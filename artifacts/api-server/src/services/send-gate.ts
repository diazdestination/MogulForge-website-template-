/**
 * Unified pre-send eligibility gate for outbound email/SMS.
 *
 * Every AUTOMATED send path (playbook steps, automation send_email/send_sms
 * actions, future reactivation campaigns) must call `checkSendEligibility`
 * before handing a message to a provider. The gate enforces, in order:
 *
 *   1. do-not-contact flag on the contact (all channels)
 *   2. address present and structurally valid
 *   3. suppression list (unsubscribed / STOP / bounced / manual) — keyed by
 *      normalized ADDRESS so it survives contact deletion and re-import
 *   4. channel consent (SMS requires a granted consent record; email is
 *      opt-out via the suppression list)
 *   5. quiet hours (outreach only, org-configurable, timezone-aware) —
 *      DEFERS the send to the next allowed window, never drops it
 *   6. frequency cap (outreach only) — defers past the rolling window
 *
 * Every blocked send should be recorded via `recordBlockedSend` so the
 * decision is auditable on the lead timeline and in the audit log.
 */
import {
  activitiesTable,
  auditEventsTable,
  consentRecordsTable,
  db,
  suppressionsTable,
  type SendingHoursSettings,
  type Suppression,
  type SuppressionReason,
} from "@workspace/db";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";

import { isSafeMailbox } from "./providers";
import { getSendingHours } from "./settings";

export type SendChannel = "email" | "sms";
/** outreach = automated marketing touches; transactional = confirmations, reminders, replies. */
export type SendKind = "outreach" | "transactional";

export type SendGateResult =
  | { ok: true }
  | { ok: false; outcome: "blocked"; reason: string }
  | { ok: false; outcome: "deferred"; reason: string; resumeAt: Date };

/** Activity types that count as automated outreach touches for frequency caps. */
const OUTREACH_ACTIVITY_TYPES = ["playbook_touch_sent", "automation_message_sent"];

// ---------------------------------------------------------------------------
// Normalization + suppression records
// ---------------------------------------------------------------------------

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Digits only; strips a leading US country code so formats compare equal. */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D+/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

export function normalizeAddress(channel: SendChannel, value: string): string {
  return channel === "email" ? normalizeEmail(value) : normalizePhone(value);
}

export async function getSuppression(
  organizationId: string,
  channel: SendChannel,
  rawValue: string,
): Promise<Suppression | null> {
  const value = normalizeAddress(channel, rawValue);
  if (!value) return null;
  const [row] = await db
    .select()
    .from(suppressionsTable)
    .where(
      and(
        eq(suppressionsTable.organizationId, organizationId),
        eq(suppressionsTable.channel, channel),
        eq(suppressionsTable.value, value),
      ),
    );
  return row ?? null;
}

/** Idempotent insert — first reason wins, later attempts are no-ops. */
export async function addSuppression(input: {
  organizationId: string;
  channel: SendChannel;
  value: string;
  reason: SuppressionReason;
  source?: string;
  detail?: string;
}): Promise<void> {
  const value = normalizeAddress(input.channel, input.value);
  if (!value) return;
  await db
    .insert(suppressionsTable)
    .values({
      organizationId: input.organizationId,
      channel: input.channel,
      value,
      reason: input.reason,
      source: input.source ?? null,
      detail: input.detail ?? null,
    })
    .onConflictDoNothing();
}

export async function removeSuppression(
  organizationId: string,
  channel: SendChannel,
  rawValue: string,
): Promise<boolean> {
  const value = normalizeAddress(channel, rawValue);
  if (!value) return false;
  const rows = await db
    .delete(suppressionsTable)
    .where(
      and(
        eq(suppressionsTable.organizationId, organizationId),
        eq(suppressionsTable.channel, channel),
        eq(suppressionsTable.value, value),
      ),
    )
    .returning({ id: suppressionsTable.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

/** Latest consent record for the channel must be granted. */
export async function hasChannelConsent(
  organizationId: string,
  contactId: string,
  channel: SendChannel,
): Promise<boolean> {
  const [row] = await db
    .select({ granted: consentRecordsTable.granted })
    .from(consentRecordsTable)
    .where(
      and(
        eq(consentRecordsTable.organizationId, organizationId),
        eq(consentRecordsTable.contactId, contactId),
        eq(consentRecordsTable.channel, channel),
      ),
    )
    .orderBy(desc(consentRecordsTable.recordedAt))
    .limit(1);
  return Boolean(row?.granted);
}

// ---------------------------------------------------------------------------
// Quiet hours
// ---------------------------------------------------------------------------

function zonedParts(date: Date, timezone: string): { weekday: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(date);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  return { weekday, hour };
}

/** Whether `at` falls inside the org's permitted sending window. */
export function isWithinWindow(cfg: SendingHoursSettings, at: Date): boolean {
  const { weekday, hour } = zonedParts(at, cfg.timezone);
  return cfg.days.includes(weekday) && hour >= cfg.startHour && hour < cfg.endHour;
}

/**
 * Null when sending is allowed right now; otherwise the next instant inside
 * the allowed window (top of the hour, stepped hourly — precise enough for
 * outreach and immune to DST edge cases).
 */
export function nextAllowedSendTime(
  cfg: SendingHoursSettings,
  from: Date = new Date(),
): Date | null {
  if (!cfg.quietHoursEnabled) return null;
  if (isWithinWindow(cfg, from)) return null;
  // Step forward hour by hour (up to 8 days) to the next open window.
  const cursor = new Date(from);
  cursor.setMinutes(0, 0, 0);
  for (let i = 0; i < 8 * 24; i++) {
    cursor.setTime(cursor.getTime() + 60 * 60 * 1000);
    if (isWithinWindow(cfg, cursor)) return new Date(cursor);
  }
  // Degenerate config (no open hours found) — fail open rather than stall
  // the queue forever; the config sanitizer should prevent this.
  return null;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface SendGateInput {
  organizationId: string;
  contact: {
    id: string;
    email?: string | null;
    phone?: string | null;
    doNotContact?: boolean;
  };
  channel: SendChannel;
  kind: SendKind;
  /** Pass pre-fetched settings to avoid a duplicate read in hot paths. */
  sendingHours?: SendingHoursSettings;
}

export async function checkSendEligibility(
  input: SendGateInput,
): Promise<SendGateResult> {
  const { organizationId, contact, channel, kind } = input;

  // 1. Hard do-not-contact flag.
  if (contact.doNotContact) {
    return { ok: false, outcome: "blocked", reason: "do_not_contact" };
  }

  // 2. Address present + structurally valid.
  const raw = channel === "email" ? contact.email : contact.phone;
  if (!raw) {
    return { ok: false, outcome: "blocked", reason: `no_${channel === "email" ? "email" : "phone"}` };
  }
  if (channel === "email" && !isSafeMailbox(raw.trim())) {
    return { ok: false, outcome: "blocked", reason: "invalid_email" };
  }
  if (channel === "sms" && normalizePhone(raw).length < 10) {
    return { ok: false, outcome: "blocked", reason: "invalid_phone" };
  }

  // 3. Suppression list (unsubscribe / STOP / bounce / manual).
  const suppression = await getSuppression(organizationId, channel, raw);
  if (suppression) {
    return { ok: false, outcome: "blocked", reason: `suppressed:${suppression.reason}` };
  }

  // 4. Channel consent — SMS is opt-in on every path (matches existing
  //    behavior); email outreach is opt-out via the suppression list.
  if (channel === "sms" && !(await hasChannelConsent(organizationId, contact.id, "sms"))) {
    return { ok: false, outcome: "blocked", reason: "no_sms_consent" };
  }

  if (kind !== "outreach") return { ok: true };

  const cfg = input.sendingHours ?? (await getSendingHours(organizationId));

  // 5. Quiet hours: pause (defer), never drop.
  const resumeAt = nextAllowedSendTime(cfg);
  if (resumeAt) {
    return { ok: false, outcome: "deferred", reason: "quiet_hours", resumeAt };
  }

  // 6. Frequency cap over a rolling 24h per contact.
  if (cfg.maxTouchesPerDay > 0) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const touches = await db
      .select({ occurredAt: activitiesTable.occurredAt })
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.organizationId, organizationId),
          eq(activitiesTable.contactId, contact.id),
          inArray(activitiesTable.type, OUTREACH_ACTIVITY_TYPES),
          gt(activitiesTable.occurredAt, since),
        ),
      )
      .orderBy(desc(activitiesTable.occurredAt));
    if (touches.length >= cfg.maxTouchesPerDay) {
      // Defer until the touch that frees a slot ages out of the window
      // (the maxTouchesPerDay-th newest), plus a minute of slack, clamped
      // into the next allowed sending window.
      const freeing = touches[cfg.maxTouchesPerDay - 1];
      let at = new Date(freeing.occurredAt.getTime() + 24 * 60 * 60 * 1000 + 60_000);
      if (at.getTime() <= Date.now()) at = new Date(Date.now() + 60_000);
      const clamped = nextAllowedSendTime(cfg, at);
      return {
        ok: false,
        outcome: "deferred",
        reason: "frequency_cap",
        resumeAt: clamped ?? at,
      };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Audit trail for blocked/deferred sends
// ---------------------------------------------------------------------------

/**
 * Record a blocked or deferred send so the decision is auditable: an audit
 * event always, plus a lead-timeline activity when a lead is in context.
 * Never throws — an audit failure must not break the send pipeline.
 */
export async function recordBlockedSend(input: {
  organizationId: string;
  channel: SendChannel;
  reason: string;
  outcome: "blocked" | "deferred";
  source: string; // e.g. "playbook", "automation"
  leadId?: string | null;
  contactId?: string | null;
  resumeAt?: Date;
}): Promise<void> {
  try {
    await db.insert(auditEventsTable).values({
      organizationId: input.organizationId,
      actorUserId: null,
      action: `send.${input.outcome}`,
      entityType: input.leadId ? "lead" : "contact",
      entityId: input.leadId ?? input.contactId ?? null,
      metadata: {
        channel: input.channel,
        reason: input.reason,
        source: input.source,
        resumeAt: input.resumeAt?.toISOString() ?? null,
      },
    });
    if (input.leadId) {
      await db.insert(activitiesTable).values({
        organizationId: input.organizationId,
        leadId: input.leadId,
        contactId: input.contactId ?? null,
        type: input.outcome === "deferred" ? "message_deferred" : "message_blocked",
        title:
          input.outcome === "deferred"
            ? `Automated ${input.channel === "email" ? "email" : "text"} deferred (${humanReason(input.reason)})`
            : `Automated ${input.channel === "email" ? "email" : "text"} blocked (${humanReason(input.reason)})`,
        metadata: {
          channel: input.channel,
          reason: input.reason,
          source: input.source,
          resumeAt: input.resumeAt?.toISOString() ?? null,
        },
      });
    }
  } catch (err) {
    console.error("[send-gate] failed to record blocked send:", err);
  }
}

function humanReason(reason: string): string {
  const map: Record<string, string> = {
    do_not_contact: "contact is marked do-not-contact",
    no_email: "no email address",
    no_phone: "no phone number",
    invalid_email: "invalid email address",
    invalid_phone: "invalid phone number",
    "suppressed:unsubscribed": "recipient unsubscribed",
    "suppressed:stop_keyword": "recipient texted STOP",
    "suppressed:hard_bounce": "address previously bounced",
    "suppressed:invalid": "address previously rejected",
    "suppressed:manual": "suppressed by an admin",
    no_sms_consent: "no SMS consent",
    quiet_hours: "outside sending hours",
    frequency_cap: "daily touch limit reached",
  };
  return map[reason] ?? reason;
}

// ---------------------------------------------------------------------------
// Provider failure classification → suppression
// ---------------------------------------------------------------------------

/**
 * Classify a provider send error. Returns a suppression reason for
 * permanent recipient problems (bad address), or null for transient/config
 * failures that should NOT poison the address.
 */
export function classifyProviderError(err: unknown): SuppressionReason | null {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  // Twilio permanent recipient errors: 21211 invalid 'To', 21610 STOP list,
  // 21614 not a mobile number, 30006 landline/unreachable.
  if (/\b21211\b|\b21614\b|\b30006\b|not a valid phone number|invalid 'to' phone number/.test(msg)) {
    return "invalid";
  }
  if (/\b21610\b|blacklist|unsubscribed recipient/.test(msg)) {
    return "stop_keyword";
  }
  // Email hard bounces / nonexistent mailboxes (Gmail/Resend wording).
  if (/invalid recipient|address not found|does not exist|mailbox unavailable|no mx |domain not found|recipient rejected/.test(msg)) {
    return "hard_bounce";
  }
  if (/invalid `to`|invalid to address|malformed address|refusing to send email: invalid recipient/.test(msg)) {
    return "invalid";
  }
  return null;
}

/**
 * Handle a provider send failure: if it identifies a permanently bad
 * address, suppress it (so nothing retries it) and report the reason.
 * Transient failures return null and leave retry behavior to the caller.
 */
export async function handleProviderFailure(input: {
  organizationId: string;
  channel: SendChannel;
  address: string;
  err: unknown;
  source: string;
}): Promise<SuppressionReason | null> {
  const reason = classifyProviderError(input.err);
  if (!reason) return null;
  await addSuppression({
    organizationId: input.organizationId,
    channel: input.channel,
    value: input.address,
    reason,
    source: input.source,
    detail: (input.err instanceof Error ? input.err.message : String(input.err)).slice(0, 500),
  });
  return reason;
}

// ---------------------------------------------------------------------------
// Unsubscribe tokens (email opt-out links)
// ---------------------------------------------------------------------------

import { createHmac, timingSafeEqual } from "node:crypto";

function unsubscribeSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required for unsubscribe tokens");
  return secret;
}

/** Stable opaque token binding org + contact; no DB row needed. */
export function buildUnsubscribeToken(organizationId: string, contactId: string): string {
  const payload = Buffer.from(`${organizationId}.${contactId}`, "utf8").toString("base64url");
  const sig = createHmac("sha256", unsubscribeSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function parseUnsubscribeToken(
  token: string,
): { organizationId: string; contactId: string } | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  try {
    const expected = createHmac("sha256", unsubscribeSecret()).update(payload).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    const [organizationId, contactId] = decoded.split(".");
    if (!organizationId || !contactId) return null;
    return { organizationId, contactId };
  } catch {
    return null;
  }
}

/** Public base URL for links in outbound email (dev domain or published domain). */
export function publicBaseUrl(): string {
  const domain =
    (process.env.REPLIT_DOMAINS ?? "").split(",")[0]?.trim() ||
    process.env.REPLIT_DEV_DOMAIN ||
    "localhost";
  return `https://${domain}`;
}

/** Footer appended to automated outreach emails. */
export function unsubscribeFooter(organizationId: string, contactId: string): string {
  const url = `${publicBaseUrl()}/api/v1/public/unsubscribe/${buildUnsubscribeToken(organizationId, contactId)}`;
  return `\n\n—\nTo stop receiving these emails, visit: ${url}`;
}
