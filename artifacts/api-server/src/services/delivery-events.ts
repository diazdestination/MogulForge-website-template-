/**
 * Delivery signals for outbound outreach: provider webhooks (Resend email
 * events, Twilio SMS status callbacks) and opt-out flows feed each touch's
 * delivery column in playbook_touches, flip the contact's per-channel
 * do-not-contact flag on hard bounces / unsubscribes, suppress the address,
 * and surface the event on the lead timeline.
 */
import {
  activitiesTable,
  contactsTable,
  db,
  leadsTable,
  playbookTouchesTable,
  type PlaybookTouch,
  type SuppressionReason,
} from "@workspace/db";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { recordAudit } from "./audit";
import { addSuppression, type SendChannel } from "./send-gate";

export type DeliverySignal = "delivered" | "bounced" | "unsubscribed";

function channelNoun(channel: SendChannel): string {
  return channel === "email" ? "email" : "text";
}

/**
 * Update one touch's delivery column from a provider webhook, correlated by
 * provider message id. "delivered" never overwrites a bounce/unsubscribe;
 * bounce/unsubscribe overwrite anything. Adds a lead-timeline activity for
 * bounces and unsubscribes (delivered stays quiet — it's the happy path).
 * Returns the touch (with org/lead context) or null when no touch matches.
 */
export async function recordTouchDelivery(input: {
  providerMessageId: string;
  signal: DeliverySignal;
  detail?: string;
}): Promise<PlaybookTouch | null> {
  const { providerMessageId, signal, detail } = input;
  if (!providerMessageId) return null;
  const now = new Date();
  const guard =
    signal === "delivered"
      ? // delivered only fills an empty slot
        isNull(playbookTouchesTable.delivery)
      : // bounce/unsubscribe always win
        or(
          isNull(playbookTouchesTable.delivery),
          eq(playbookTouchesTable.delivery, "delivered"),
        );
  const [touch] = await db
    .update(playbookTouchesTable)
    .set({ delivery: signal, deliveryAt: now })
    .where(
      and(eq(playbookTouchesTable.providerMessageId, providerMessageId), guard),
    )
    .returning();
  if (!touch) {
    // Either no touch with this id, or the update was a no-op (already in a
    // terminal state) — fetch for context so callers can still suppress.
    const [existing] = await db
      .select()
      .from(playbookTouchesTable)
      .where(eq(playbookTouchesTable.providerMessageId, providerMessageId));
    return existing ?? null;
  }

  if (signal !== "delivered") {
    const channel = touch.channel as SendChannel;
    await db.insert(activitiesTable).values({
      organizationId: touch.organizationId,
      leadId: touch.leadId,
      type: signal === "bounced" ? "message_bounced" : "message_unsubscribed",
      title:
        signal === "bounced"
          ? `Outreach ${channelNoun(channel)} bounced`
          : `Recipient unsubscribed from automated ${channelNoun(channel)}s`,
      metadata: {
        channel,
        provider: touch.provider,
        providerMessageId,
        stepIndex: touch.stepIndex,
        detail: detail ?? null,
      },
    });
  }
  return touch;
}

/**
 * Flip a contact's per-channel do-not-contact flag and suppress their
 * current address on that channel. Idempotent; never throws (a webhook must
 * always be ACKed). Used by bounce webhooks and both unsubscribe flows.
 */
export async function suppressChannelForContact(input: {
  organizationId: string;
  contactId: string;
  channel: SendChannel;
  reason: SuppressionReason;
  source: string;
  detail?: string;
}): Promise<void> {
  const { organizationId, contactId, channel, reason, source, detail } = input;
  try {
    const [contact] = await db
      .update(contactsTable)
      .set(
        channel === "email"
          ? { doNotContactEmail: true }
          : { doNotContactSms: true },
      )
      .where(
        and(
          eq(contactsTable.id, contactId),
          eq(contactsTable.organizationId, organizationId),
        ),
      )
      .returning();
    if (!contact) return;
    const address = channel === "email" ? contact.email : contact.phone;
    if (address) {
      await addSuppression({
        organizationId,
        channel,
        value: address,
        reason,
        source,
        detail,
      });
    }
    await recordAudit({
      organizationId,
      action: "send.channel_suppressed",
      entityType: "contact",
      entityId: contactId,
      metadata: { channel, reason, source },
    });
  } catch (err) {
    console.error("[delivery-events] suppressChannelForContact failed:", err);
  }
}

/**
 * Contact-initiated opt-out (unsubscribe link, SMS STOP): flip the channel
 * DNC flag, suppress the address, mark the contact's outstanding touches on
 * that channel as unsubscribed, and put the opt-out on each lead's timeline.
 * Never throws.
 */
export async function recordContactOptOut(input: {
  organizationId: string;
  contactId: string;
  channel: SendChannel;
  source: string;
}): Promise<void> {
  const { organizationId, contactId, channel, source } = input;
  try {
    await suppressChannelForContact({
      organizationId,
      contactId,
      channel,
      reason: channel === "email" ? "unsubscribed" : "stop_keyword",
      source,
    });
    const leads = await db
      .select({ id: leadsTable.id })
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.organizationId, organizationId),
          eq(leadsTable.contactId, contactId),
        ),
      );
    const leadIds = leads.map((l) => l.id);
    if (leadIds.length === 0) return;
    const now = new Date();
    await db
      .update(playbookTouchesTable)
      .set({ delivery: "unsubscribed", deliveryAt: now })
      .where(
        and(
          eq(playbookTouchesTable.organizationId, organizationId),
          inArray(playbookTouchesTable.leadId, leadIds),
          eq(playbookTouchesTable.channel, channel),
          or(
            isNull(playbookTouchesTable.delivery),
            eq(playbookTouchesTable.delivery, "delivered"),
          ),
        ),
      );
    for (const leadId of leadIds) {
      await db.insert(activitiesTable).values({
        organizationId,
        leadId,
        contactId,
        type: "message_unsubscribed",
        title:
          channel === "email"
            ? "Recipient unsubscribed from automated emails"
            : "Recipient texted STOP — automated texts stopped",
        metadata: { channel, source },
      });
    }
  } catch (err) {
    console.error("[delivery-events] recordContactOptOut failed:", err);
  }
}

/**
 * Handle a bounce-class webhook for a touch: mark the touch, then flip the
 * per-channel DNC flag + suppression for the lead's contact. When no touch
 * matches (e.g. non-playbook send), falls back to suppressing every contact
 * matching the address — same cross-org matching the STOP flow uses.
 */
export async function handleBounce(input: {
  providerMessageId: string;
  channel: SendChannel;
  address?: string | null;
  reason: SuppressionReason;
  source: string;
  detail?: string;
}): Promise<void> {
  const touch = await recordTouchDelivery({
    providerMessageId: input.providerMessageId,
    signal: "bounced",
    detail: input.detail,
  });
  if (touch) {
    const [lead] = await db
      .select({ contactId: leadsTable.contactId })
      .from(leadsTable)
      .where(eq(leadsTable.id, touch.leadId));
    if (lead?.contactId) {
      await suppressChannelForContact({
        organizationId: touch.organizationId,
        contactId: lead.contactId,
        channel: input.channel,
        reason: input.reason,
        source: input.source,
        detail: input.detail,
      });
    }
    return;
  }
  // No touch matched — suppress by address wherever that contact exists.
  if (!input.address) return;
  const matches =
    input.channel === "email"
      ? await db
          .select({ id: contactsTable.id, organizationId: contactsTable.organizationId })
          .from(contactsTable)
          .where(sql`lower(coalesce(${contactsTable.email}, '')) = ${input.address.trim().toLowerCase()}`)
      : await db
          .select({ id: contactsTable.id, organizationId: contactsTable.organizationId })
          .from(contactsTable)
          .where(
            sql`regexp_replace(coalesce(${contactsTable.phone}, ''), '\\D', '', 'g') LIKE ${"%" + input.address.replace(/\D+/g, "").slice(-10)}`,
          );
  for (const contact of matches) {
    await suppressChannelForContact({
      organizationId: contact.organizationId,
      contactId: contact.id,
      channel: input.channel,
      reason: input.reason,
      source: input.source,
      detail: input.detail,
    });
  }
}

/**
 * Twilio error codes that mean the NUMBER itself is permanently
 * unreachable (invalid, landline, carrier-blocked). Transient failures
 * (device off, network congestion) must NOT poison the number.
 */
const TWILIO_PERMANENT_ERROR_CODES = new Set([
  "21211", // invalid 'To' number
  "21610", // recipient on Twilio's STOP list
  "21614", // not a mobile number
  "30004", // blocked by recipient/carrier
  "30005", // unknown destination
  "30006", // landline / unreachable carrier
]);

export function isPermanentTwilioError(errorCode: string | undefined): boolean {
  return Boolean(errorCode && TWILIO_PERMANENT_ERROR_CODES.has(errorCode));
}
