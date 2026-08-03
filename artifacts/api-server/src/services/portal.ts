/**
 * Homeowner portal: OTP login against the contact record (email or phone),
 * portal sessions, and a read view of the homeowner's claims (leads),
 * appointments, and timeline. No staff auth involved.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { CLIENT } from "../lib/client.config";

import {
  activitiesTable,
  appointmentsTable,
  contactsTable,
  db,
  leadsTable,
  portalLoginCodesTable,
  portalSessionsTable,
  propertiesTable,
  type Activity,
  type Appointment,
  type Contact,
  type Lead,
  type LeadStatus,
  type PortalSession,
} from "@workspace/db";
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

import { logger } from "../lib/logger";
import { consumeCooldown } from "../lib/rateLimit";
import { emitAutomationEvent } from "./automation";
import {
  notifyAssignedRepOfPortalMessage,
  notifyAssignedRepOfPortalPhotos,
} from "./portal-message-email";
import { stopEnrollmentsForLead } from "./playbooks";
import { recordLeadOutcome } from "./playbook-learning";
import { isSafeMailbox, providers } from "./providers";

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const REQUEST_CODE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_VERIFY_ATTEMPTS = 5;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Normalize a login identifier: lowercased email, or last 10 digits of a phone. */
export function normalizeIdentifier(
  raw: string,
): { identifier: string; channel: "email" | "sms" } | null {
  const trimmed = raw.trim();
  if (trimmed.includes("@")) {
    const email = trimmed.toLowerCase();
    if (!isSafeMailbox(email)) return null;
    return { identifier: email, channel: "email" };
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  return { identifier: digits.slice(-10), channel: "sms" };
}

/** Find contacts in the org whose email/phone matches the normalized identifier. */
async function findMatchingContacts(
  organizationId: string,
  identifier: string,
  channel: "email" | "sms",
): Promise<Contact[]> {
  if (channel === "email") {
    return db
      .select()
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.organizationId, organizationId),
          sql`lower(${contactsTable.email}) = ${identifier}`,
        ),
      );
  }
  return db
    .select()
    .from(contactsTable)
    .where(
      and(
        eq(contactsTable.organizationId, organizationId),
        sql`right(regexp_replace(coalesce(${contactsTable.phone}, ''), '[^0-9]', '', 'g'), 10) = ${identifier}`,
      ),
    );
}

/**
 * Request a login code. Always resolves without revealing whether the
 * identifier matched a contact (anti-enumeration): the code is only created
 * and sent when a matching contact exists.
 */
export async function requestLoginCode(params: {
  organizationId: string;
  rawIdentifier: string;
}): Promise<{ ok: true; channel: "email" | "sms" } | { ok: false }> {
  const normalized = normalizeIdentifier(params.rawIdentifier);
  if (!normalized) return { ok: false };
  const { identifier, channel } = normalized;

  // Throttle per identifier before doing any work: a burst of requests for
  // the same email/phone must not flood portal_login_codes or spam the
  // homeowner. Throttled requests return the same neutral success shape as
  // non-matching identifiers, so callers can't detect throttling either.
  const cooldown = await consumeCooldown({
    key: `portal-login-code:${params.organizationId}:${identifier}`,
    windowMs: REQUEST_CODE_WINDOW_MS,
    max: REQUEST_CODE_MAX,
  });
  if (!cooldown.allowed) {
    logger.warn(
      { organizationId: params.organizationId, channel },
      "portal login code request throttled",
    );
    return { ok: true, channel };
  }

  const contacts = await findMatchingContacts(
    params.organizationId,
    identifier,
    channel,
  );
  if (contacts.length === 0) {
    // Same outward behavior as success — do not leak which emails/phones exist.
    return { ok: true, channel };
  }

  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  await db.insert(portalLoginCodesTable).values({
    organizationId: params.organizationId,
    identifier,
    channel,
    codeHash: sha256(code),
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });

  const firstName = contacts[0].firstName;
  const body = [
    `Hi ${firstName},`,
    "",
    `Your ${CLIENT.businessShortName} portal sign-in code is: ${code}`,
    "",
    "This code expires in 10 minutes. If you didn't request it, you can ignore this message.",
  ].join("\n");

  try {
    if (channel === "email") {
      await providers.email.send(
        identifier,
        `Your ${CLIENT.businessShortName} sign-in code`,
        body,
      );
    } else {
      const to = contacts[0].phone ?? identifier;
      await providers.sms.send(
        to,
        `${CLIENT.businessShortName} sign-in code: ${code}. Expires in 10 minutes.`,
      );
    }
  } catch (err) {
    logger.error({ err }, "portal: failed to send login code");
    throw new Error("Failed to send verification code");
  }
  return { ok: true, channel };
}

/** Verify a login code and mint a portal session token. */
export async function verifyLoginCode(params: {
  organizationId: string;
  rawIdentifier: string;
  code: string;
}): Promise<{ token: string; expiresAt: Date } | null> {
  const normalized = normalizeIdentifier(params.rawIdentifier);
  if (!normalized) return null;
  const { identifier, channel } = normalized;

  const [record] = await db
    .select()
    .from(portalLoginCodesTable)
    .where(
      and(
        eq(portalLoginCodesTable.organizationId, params.organizationId),
        eq(portalLoginCodesTable.identifier, identifier),
        isNull(portalLoginCodesTable.consumedAt),
        gt(portalLoginCodesTable.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(portalLoginCodesTable.createdAt))
    .limit(1);
  if (!record || record.attempts >= MAX_VERIFY_ATTEMPTS) return null;

  const given = Buffer.from(sha256(params.code.trim()), "hex");
  const expected = Buffer.from(record.codeHash, "hex");
  const matches =
    given.length === expected.length && timingSafeEqual(given, expected);

  if (!matches) {
    await db
      .update(portalLoginCodesTable)
      .set({ attempts: record.attempts + 1 })
      .where(eq(portalLoginCodesTable.id, record.id));
    return null;
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.transaction(async (tx) => {
    await tx
      .update(portalLoginCodesTable)
      .set({ consumedAt: new Date() })
      .where(eq(portalLoginCodesTable.id, record.id));
    await tx.insert(portalSessionsTable).values({
      organizationId: params.organizationId,
      tokenHash: sha256(token),
      identifier,
      channel,
      expiresAt,
    });
  });
  return { token, expiresAt };
}

/** Resolve a live portal session from a bearer token, or null. */
export async function getPortalSession(
  token: string,
): Promise<PortalSession | null> {
  if (!token || token.length > 200) return null;
  const [session] = await db
    .select()
    .from(portalSessionsTable)
    .where(
      and(
        eq(portalSessionsTable.tokenHash, sha256(token)),
        gt(portalSessionsTable.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return session ?? null;
}

export async function revokePortalSession(token: string): Promise<void> {
  await db
    .delete(portalSessionsTable)
    .where(eq(portalSessionsTable.tokenHash, sha256(token)));
}

/* ------------------------------------------------------------------ */
/* Claim view: homeowner-friendly timeline mapped from the pipeline.    */
/* ------------------------------------------------------------------ */

/** Homeowner-facing journey steps, in order, mapped from lead statuses. */
const JOURNEY_STEPS: {
  key: string;
  label: string;
  description: string;
  statuses: LeadStatus[];
}[] = [
  {
    key: "received",
    label: "Request received",
    description: "We have your assessment and our team is reviewing it.",
    statuses: ["new", "ai_qualified", "nurture"],
  },
  {
    key: "reaching_out",
    label: "Reaching out",
    description: "A team member is contacting you to talk next steps.",
    statuses: ["contact_attempted", "follow_up"],
  },
  {
    key: "inspection",
    label: "Inspection",
    description: "Your on-site roof inspection is scheduled or under way.",
    statuses: ["inspection_scheduled", "inspection_completed"],
  },
  {
    key: "estimate",
    label: "Estimate",
    description: "We're preparing and sharing your detailed estimate.",
    statuses: ["estimate_preparing", "estimate_sent"],
  },
  {
    key: "approval",
    label: "Insurance & approval",
    description: "Working through insurance/claim details and your approval.",
    statuses: ["claim_pending", "won"],
  },
  {
    key: "repair",
    label: "Repair",
    description: "Your project is scheduled and the crew gets to work.",
    statuses: ["production_scheduled", "in_progress"],
  },
  {
    key: "wrap_up",
    label: "Final walkthrough & done",
    description: "Final quality walkthrough, then your roof is complete.",
    statuses: ["final_walkthrough", "completed", "review_requested"],
  },
];

function buildTimeline(status: LeadStatus): {
  steps: { key: string; label: string; description: string; state: string }[];
  closed: boolean;
} {
  if (status === "lost") {
    return {
      closed: true,
      steps: JOURNEY_STEPS.map((s) => ({
        key: s.key,
        label: s.label,
        description: s.description,
        state: "upcoming",
      })),
    };
  }
  const currentIndex = JOURNEY_STEPS.findIndex((s) =>
    s.statuses.includes(status),
  );
  const done = status === "completed" || status === "review_requested";
  return {
    closed: false,
    steps: JOURNEY_STEPS.map((s, i) => ({
      key: s.key,
      label: s.label,
      description: s.description,
      state:
        done || i < currentIndex
          ? "complete"
          : i === currentIndex
            ? "current"
            : "upcoming",
    })),
  };
}

/** Activity types safe to show a homeowner (never internal notes/audit). */
const HOMEOWNER_VISIBLE_ACTIVITY_TYPES = [
  "lead_captured",
  "status_changed",
  "appointment_scheduled",
  "appointment_reminder_sent",
  "portal_message",
  "team_message",
];

/**
 * Map an activity to homeowner-friendly copy. Reminder activities get fixed
 * copy because their stored title/body embed send-channel details (email
 * address / phone number of record) meant for the internal timeline.
 */
function portalUpdateCopy(act: Activity): { title: string; body: string | null } {
  if (act.type === "appointment_reminder_sent") {
    return {
      title: "Appointment reminder sent",
      body: "We sent you a reminder about your upcoming inspection appointment.",
    };
  }
  return { title: act.title, body: act.body };
}
export async function getPortalOverview(session: PortalSession) {
  const contacts = await findMatchingContacts(
    session.organizationId,
    session.identifier,
    session.channel,
  );
  const contactIds = contacts.map((c) => c.id);
  if (contactIds.length === 0) {
    return { contact: null, claims: [] };
  }

  const leads: Lead[] = await db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.organizationId, session.organizationId),
        inArray(leadsTable.contactId, contactIds),
      ),
    )
    .orderBy(desc(leadsTable.createdAt));

  const leadIds = leads.map((l) => l.id);
  const [appointments, activities, photoActivities, properties]: [
    Appointment[],
    Activity[],
    Activity[],
    (typeof propertiesTable.$inferSelect)[],
  ] = await Promise.all([
    leadIds.length
      ? db
          .select()
          .from(appointmentsTable)
          .where(
            and(
              eq(appointmentsTable.organizationId, session.organizationId),
              inArray(appointmentsTable.leadId, leadIds),
            ),
          )
          .orderBy(appointmentsTable.scheduledStart)
      : Promise.resolve([]),
    leadIds.length
      ? db
          .select()
          .from(activitiesTable)
          .where(
            and(
              eq(activitiesTable.organizationId, session.organizationId),
              inArray(activitiesTable.leadId, leadIds),
              inArray(activitiesTable.type, HOMEOWNER_VISIBLE_ACTIVITY_TYPES),
            ),
          )
          .orderBy(desc(activitiesTable.occurredAt))
      : Promise.resolve([]),
    leadIds.length
      ? db
          .select()
          .from(activitiesTable)
          .where(
            and(
              eq(activitiesTable.organizationId, session.organizationId),
              inArray(activitiesTable.leadId, leadIds),
              eq(activitiesTable.type, "photos_attached"),
            ),
          )
          .orderBy(desc(activitiesTable.occurredAt))
      : Promise.resolve([]),
    db
      .select()
      .from(propertiesTable)
      .where(
        and(
          eq(propertiesTable.organizationId, session.organizationId),
          inArray(propertiesTable.contactId, contactIds),
        ),
      ),
  ]);

  const primary = contacts[0];
  /** Object paths of homeowner-submitted damage photos, per lead. */
  const photosByLead = new Map<string, string[]>();
  for (const act of photoActivities) {
    if (!act.leadId) continue;
    const meta = act.metadata as { photoPaths?: unknown } | null;
    const paths = Array.isArray(meta?.photoPaths)
      ? meta.photoPaths.filter(
          (p): p is string => typeof p === "string" && p.startsWith("/objects/"),
        )
      : [];
    if (paths.length === 0) continue;
    const existing = photosByLead.get(act.leadId) ?? [];
    for (const p of paths) {
      if (!existing.includes(p)) existing.push(p);
    }
    photosByLead.set(act.leadId, existing);
  }
  const propertyByLead = (lead: Lead) =>
    properties.find((p) => p.id === lead.propertyId) ??
    properties.find((p) => p.contactId === lead.contactId) ??
    null;

  return {
    contact: {
      firstName: primary.firstName,
      lastName: primary.lastName,
      email: primary.email,
      phone: primary.phone,
    },
    claims: leads.map((lead) => {
      const timeline = buildTimeline(lead.status);
      const property = propertyByLead(lead);
      return {
        id: lead.id,
        status: lead.status,
        closed: timeline.closed,
        urgency: lead.urgency,
        serviceType: lead.serviceType,
        createdAt: lead.createdAt.toISOString(),
        updatedAt: lead.updatedAt.toISOString(),
        property: property
          ? {
              addressLine1: property.addressLine1,
              addressLine2: property.addressLine2,
              city: property.city,
              state: property.state,
              postalCode: property.postalCode,
            }
          : null,
        steps: timeline.steps,
        photos: photosByLead.get(lead.id) ?? [],
        appointments: appointments
          .filter((a) => a.leadId === lead.id && a.status !== "cancelled")
          .map((a) => ({
            id: a.id,
            type: a.type,
            status: a.status,
            scheduledStart: a.scheduledStart.toISOString(),
            scheduledEnd: a.scheduledEnd ? a.scheduledEnd.toISOString() : null,
          })),
        updates: activities
          .filter((act) => act.leadId === lead.id)
          .slice(0, 20)
          .map((act) => {
            const copy = portalUpdateCopy(act);
            return {
              id: act.id,
              type: act.type,
              title: copy.title,
              body: copy.body,
              occurredAt: act.occurredAt.toISOString(),
            };
          }),
      };
    }),
  };
}

/**
 * True when the object path is a damage photo attached to one of the leads
 * owned by this portal session's contact(s) — the ownership check for
 * streaming photos to a homeowner. Stricter than the CRM check: the photo
 * must belong to a lead the OTP-verified homeowner owns, not just the org.
 */
export async function isPortalPhotoForSession(
  session: PortalSession,
  objectPath: string,
): Promise<boolean> {
  const contacts = await findMatchingContacts(
    session.organizationId,
    session.identifier,
    session.channel,
  );
  const contactIds = contacts.map((c) => c.id);
  if (contactIds.length === 0) return false;

  const rows = await db
    .select({ id: activitiesTable.id })
    .from(activitiesTable)
    .innerJoin(leadsTable, eq(activitiesTable.leadId, leadsTable.id))
    .where(
      and(
        eq(activitiesTable.organizationId, session.organizationId),
        eq(leadsTable.organizationId, session.organizationId),
        inArray(leadsTable.contactId, contactIds),
        sql`${activitiesTable.type} = 'photos_attached'
          AND ${activitiesTable.metadata} @> ${JSON.stringify({ photoPaths: [objectPath] })}::jsonb`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Attach additional homeowner-uploaded damage photos to one of the session's
 * own claims via a photos_attached activity (same shape the assessment flow
 * writes, so the CRM team and portal gallery pick them up automatically).
 * Returns the number attached, null when the claim isn't owned, or
 * "limit_exceeded" when the claim already holds the maximum number of
 * homeowner photos (prevents one claim from being flooded with uploads).
 */
export const MAX_PORTAL_PHOTOS_PER_CLAIM = 50;

export async function addPortalClaimPhotos(params: {
  session: PortalSession;
  leadId: string;
  photoPaths: string[];
  /** Overridable in tests; production callers use the default cap. */
  maxPhotosPerClaim?: number;
}): Promise<number | null | "limit_exceeded"> {
  const contacts = await findMatchingContacts(
    params.session.organizationId,
    params.session.identifier,
    params.session.channel,
  );
  const contactIds = contacts.map((c) => c.id);
  if (contactIds.length === 0) return null;

  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.id, params.leadId),
        eq(leadsTable.organizationId, params.session.organizationId),
        inArray(leadsTable.contactId, contactIds),
      ),
    )
    .limit(1);
  if (!lead) return null;

  const photoPaths = [
    ...new Set(params.photoPaths.filter((p) => p.startsWith("/objects/"))),
  ];
  if (photoPaths.length === 0) return 0;

  // Cap the TOTAL photos accumulated on one claim. Each request is already
  // limited to 10 photos and rate-limited, but without a per-claim ceiling a
  // homeowner (or compromised session) could attach hundreds over time.
  // The count + insert run in one transaction under a per-claim advisory
  // lock so concurrent requests cannot race past the cap or double-attach.
  const cap = params.maxPhotosPerClaim ?? MAX_PORTAL_PHOTOS_PER_CLAIM;
  const attached = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${lead.id}:portal-photos`}))`,
    );
    const existingActivities = await tx
      .select({ metadata: activitiesTable.metadata })
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.organizationId, params.session.organizationId),
          eq(activitiesTable.leadId, lead.id),
          eq(activitiesTable.type, "photos_attached"),
        ),
      );
    const existingPaths = new Set<string>();
    for (const act of existingActivities) {
      const meta = act.metadata as { photoPaths?: unknown } | null;
      if (!Array.isArray(meta?.photoPaths)) continue;
      for (const p of meta.photoPaths) {
        if (typeof p === "string") existingPaths.add(p);
      }
    }
    const newPaths = photoPaths.filter((p) => !existingPaths.has(p));
    if (newPaths.length === 0) return 0;
    if (existingPaths.size + newPaths.length > cap) {
      return "limit_exceeded" as const;
    }

    await tx.insert(activitiesTable).values({
      organizationId: params.session.organizationId,
      leadId: lead.id,
      contactId: lead.contactId,
      type: "photos_attached",
      title: `Homeowner attached ${newPaths.length} damage photo${newPaths.length === 1 ? "" : "s"} (portal)`,
      body: null,
      metadata: { photoPaths: newPaths, source: "homeowner-portal" },
    });
    return newPaths.length;
  });

  if (typeof attached === "number" && attached > 0) {
    // Alert the team: email the assigned rep (if any) and emit an automation
    // event so admins can wire their own rules. Neither blocks or fails the
    // homeowner's upload — the photos are already on the timeline.
    await notifyAssignedRepOfPortalPhotos({
      organizationId: params.session.organizationId,
      leadId: lead.id,
      photoCount: attached,
    });
    emitAutomationEvent(params.session.organizationId, "portal.photos_added", {
      leadId: lead.id,
      contactId: lead.contactId ?? undefined,
      fields: {
        "photos.count": attached,
        "photos.source": "homeowner-portal",
        "lead.status": lead.status,
        "lead.urgency": lead.urgency,
      },
    });
  }
  return attached;
}

/**
 * Full message history for one of the session's own claims — every
 * portal_message (homeowner) and team_message (team reply) on the lead,
 * oldest to newest, so the thread reads top-down like a conversation.
 * Returns null when the claim isn't owned by this homeowner.
 */
export async function getPortalConversation(
  session: PortalSession,
  leadId: string,
): Promise<
  | { id: string; sender: "homeowner" | "team"; body: string; occurredAt: string }[]
  | null
> {
  const contacts = await findMatchingContacts(
    session.organizationId,
    session.identifier,
    session.channel,
  );
  const contactIds = contacts.map((c) => c.id);
  if (contactIds.length === 0) return null;

  const [lead] = await db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.id, leadId),
        eq(leadsTable.organizationId, session.organizationId),
        inArray(leadsTable.contactId, contactIds),
      ),
    )
    .limit(1);
  if (!lead) return null;

  const rows = await db
    .select()
    .from(activitiesTable)
    .where(
      and(
        eq(activitiesTable.organizationId, session.organizationId),
        eq(activitiesTable.leadId, lead.id),
        inArray(activitiesTable.type, ["portal_message", "team_message"]),
      ),
    )
    .orderBy(activitiesTable.occurredAt, activitiesTable.id);

  return rows.map((act) => ({
    id: act.id,
    sender: act.type === "portal_message" ? ("homeowner" as const) : ("team" as const),
    body: act.body ?? "",
    occurredAt: act.occurredAt.toISOString(),
  }));
}

/** Post a homeowner message onto a claim's timeline for the team to see. */
export async function postPortalMessage(params: {
  session: PortalSession;
  leadId: string;
  content: string;
}): Promise<boolean> {
  const contacts = await findMatchingContacts(
    params.session.organizationId,
    params.session.identifier,
    params.session.channel,
  );
  const contactIds = contacts.map((c) => c.id);
  if (contactIds.length === 0) return false;

  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.id, params.leadId),
        eq(leadsTable.organizationId, params.session.organizationId),
        inArray(leadsTable.contactId, contactIds),
      ),
    )
    .limit(1);
  if (!lead) return false;

  const [activity] = await db
    .insert(activitiesTable)
    .values({
      organizationId: params.session.organizationId,
      leadId: lead.id,
      contactId: lead.contactId,
      type: "portal_message",
      title: "Message from homeowner (portal)",
      body: params.content,
      metadata: { source: "homeowner-portal" },
    })
    .returning({ id: activitiesTable.id });

  // A homeowner reply means a human should take over: pause any live
  // Closer Engine outreach so the lead isn't hit with automated touches
  // mid-conversation. Never throws.
  await stopEnrollmentsForLead(
    params.session.organizationId,
    lead.id,
    "lead replied via portal",
    "paused",
  );
  // Learning loop: credit the reply back to the outreach touches that
  // preceded it (variant/step attribution). Never throws.
  await recordLeadOutcome(params.session.organizationId, lead.id, "replied");

  // Notify the assigned rep (if any) so the message doesn't sit unread.
  // Rapid consecutive messages are debounced to at most one email per quiet
  // window (see portal-message-email.ts). Never blocks or fails the
  // homeowner's post — failures are logged inside.
  await notifyAssignedRepOfPortalMessage({
    organizationId: params.session.organizationId,
    leadId: lead.id,
    messageContent: params.content,
    activityId: activity?.id,
  });
  return true;
}

/**
 * Delete expired or consumed portal login codes and expired portal sessions.
 * Rows are only ever inserted (logout deletes a single session), so without
 * periodic cleanup both tables grow forever. Called by the scheduler tick.
 */
export async function cleanupExpiredPortalCredentials(
  now: Date = new Date(),
): Promise<{ codes: number; sessions: number }> {
  const codes = await db
    .delete(portalLoginCodesTable)
    .where(
      or(
        lte(portalLoginCodesTable.expiresAt, now),
        isNotNull(portalLoginCodesTable.consumedAt),
      ),
    )
    .returning({ id: portalLoginCodesTable.id });
  const sessions = await db
    .delete(portalSessionsTable)
    .where(lte(portalSessionsTable.expiresAt, now))
    .returning({ id: portalSessionsTable.id });
  if (codes.length > 0 || sessions.length > 0) {
    logger.info(
      { codes: codes.length, sessions: sessions.length },
      "portal cleanup removed expired credentials",
    );
  }
  return { codes: codes.length, sessions: sessions.length };
}

const REQUEST_CODE_MAX = 3;
