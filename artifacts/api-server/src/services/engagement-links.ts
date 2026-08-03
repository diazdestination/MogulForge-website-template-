import { randomBytes } from "node:crypto";
import {
  activitiesTable,
  contactsTable,
  db,
  engagementLinksTable,
  leadsTable,
  type EngagementLink,
} from "@workspace/db";
import { and, eq, or, sql } from "drizzle-orm";
import { emitAutomationEvent } from "./automation";
import { buildTouch, leadAttributionColumns } from "./attribution";
import { publicBaseUrl } from "./send-gate";
import { getOrgSettings } from "./settings";

/**
 * Tokenized post-sale engagement links (review click-through + referral
 * submission). The token alone identifies the org/contact — a capability
 * URL that is only ever sent to the customer it belongs to. We track
 * clicks and submissions honestly: a review CLICK is recorded, but a
 * completed third-party review is never claimed (not detectable).
 */

export type EngagementLinkKind = "review" | "referral";

export async function getOrCreateEngagementLink(
  organizationId: string,
  contactId: string,
  kind: EngagementLinkKind,
  leadId?: string | null,
): Promise<EngagementLink> {
  const [existing] = await db
    .select()
    .from(engagementLinksTable)
    .where(
      and(
        eq(engagementLinksTable.contactId, contactId),
        eq(engagementLinksTable.kind, kind),
      ),
    );
  if (existing) return existing;
  try {
    const [row] = await db
      .insert(engagementLinksTable)
      .values({
        organizationId,
        contactId,
        leadId: leadId ?? null,
        kind,
        token: randomBytes(18).toString("base64url"),
      })
      .returning();
    return row;
  } catch (err) {
    // Concurrent creation: the unique (contact, kind) index won the race.
    const [row] = await db
      .select()
      .from(engagementLinksTable)
      .where(
        and(
          eq(engagementLinksTable.contactId, contactId),
          eq(engagementLinksTable.kind, kind),
        ),
      );
    if (row) return row;
    throw err;
  }
}

/** Absolute URL a customer clicks (review redirect / referral form API). */
export function engagementLinkUrl(link: EngagementLink): string {
  return link.kind === "review"
    ? `${publicBaseUrl()}/api/v1/public/el/${link.token}`
    : `${publicBaseUrl()}/api/v1/public/referrals/${link.token}`;
}

export async function findEngagementLink(
  token: string,
): Promise<EngagementLink | null> {
  const [row] = await db
    .select()
    .from(engagementLinksTable)
    .where(eq(engagementLinksTable.token, token));
  return row ?? null;
}

/**
 * Record a review-link click and return the org's review destination URL
 * (Google write-a-review page when a Place ID is configured).
 */
export async function recordReviewClick(
  link: EngagementLink,
): Promise<string> {
  await db
    .update(engagementLinksTable)
    .set({
      clickCount: sql`${engagementLinksTable.clickCount} + 1`,
      lastClickedAt: new Date(),
    })
    .where(eq(engagementLinksTable.id, link.id));
  await db.insert(activitiesTable).values({
    organizationId: link.organizationId,
    leadId: link.leadId,
    contactId: link.contactId,
    type: "review_link_clicked",
    title: "Review link clicked",
    metadata: { engagementLinkId: link.id },
  });
  const settings = await getOrgSettings(link.organizationId);
  const placeId = settings.googleReviews?.placeId;
  return placeId
    ? `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`
    : settings.businessProfile?.website || publicBaseUrl();
}

export interface ReferralSubmission {
  name: string;
  email?: string;
  phone?: string;
  notes?: string;
}

/**
 * Turn a referral submission into a properly-attributed lead: source
 * "referral", sourceDetail pointing at the referring contact, plus
 * timeline events on both the new lead and the referrer.
 */
export async function recordReferralSubmission(
  link: EngagementLink,
  submission: ReferralSubmission,
): Promise<{ leadId: string }> {
  const [referrer] = await db
    .select()
    .from(contactsTable)
    .where(eq(contactsTable.id, link.contactId));
  const referrerName =
    (referrer && `${referrer.firstName ?? ""} ${referrer.lastName ?? ""}`.trim()) ||
    "a customer";
  const organizationId = link.organizationId;
  const email = submission.email?.trim().toLowerCase() || null;
  const phone = submission.phone ? submission.phone.replace(/[^\d+]/g, "") : null;
  const [firstName, ...rest] = submission.name.trim().split(/\s+/);
  const touch = buildTouch({ channel: "referral", source: "referral" });

  const created = await db.transaction(async (tx) => {
    // Contact dedupe by normalized email/phone within the org.
    const matchers = [];
    if (email) matchers.push(sql`lower(${contactsTable.email}) = ${email}`);
    if (phone) {
      matchers.push(
        sql`regexp_replace(coalesce(${contactsTable.phone}, ''), '[^0-9+]', '', 'g') = ${phone}`,
      );
    }
    const [existingContact] = matchers.length
      ? await tx
          .select()
          .from(contactsTable)
          .where(and(eq(contactsTable.organizationId, organizationId), or(...matchers)))
          .limit(1)
      : [];
    let contactId: string;
    if (existingContact) {
      contactId = existingContact.id;
    } else {
      const [contact] = await tx
        .insert(contactsTable)
        .values({
          organizationId,
          firstName: firstName || "Unknown",
          lastName: rest.join(" ") || null,
          email: submission.email?.trim() || null,
          phone: submission.phone?.trim() || null,
        })
        .returning();
      contactId = contact.id;
    }
    const [lead] = await tx
      .insert(leadsTable)
      .values({
        organizationId,
        contactId,
        status: "new",
        summary: submission.notes
          ? `Referred by ${referrerName}. ${submission.notes}`
          : `Referred by ${referrerName}.`,
        sourceDetail: `referred-by:${link.contactId}`,
        ...leadAttributionColumns({
          source: "referral",
          creationMethod: "referral",
          touch,
        }),
      })
      .returning();
    return { leadId: lead.id, contactId };
  });
  await db
    .update(engagementLinksTable)
    .set({
      submissionCount: sql`${engagementLinksTable.submissionCount} + 1`,
    })
    .where(eq(engagementLinksTable.id, link.id));
  await db.insert(activitiesTable).values([
    {
      organizationId: link.organizationId,
      leadId: created.leadId,
      type: "referral_received",
      title: `Referral from ${referrerName}`,
      metadata: { referrerContactId: link.contactId },
    },
    {
      organizationId: link.organizationId,
      leadId: link.leadId,
      contactId: link.contactId,
      type: "referral_submitted",
      title: `${referrerName} referred ${submission.name}`,
      metadata: { referredLeadId: created.leadId },
    },
  ]);
  // Standard pipeline entry: scoring, playbooks, and webhooks all fire.
  emitAutomationEvent(link.organizationId, "lead.created", {
    leadId: created.leadId,
    contactId: created.contactId,
    fields: { "lead.status": "new", "lead.source": "referral" },
  });
  return { leadId: created.leadId };
}
