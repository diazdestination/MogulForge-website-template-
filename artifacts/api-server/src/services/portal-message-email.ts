/**
 * Assigned-rep notification for homeowner portal messages: when a homeowner
 * posts a message on their claim, email the rep assigned to that lead so the
 * message doesn't sit unread. Send failures are logged, never fatal — the
 * message itself is already persisted on the timeline.
 */
import {
  activitiesTable,
  contactsTable,
  db,
  leadsTable,
  usersTable,
} from "@workspace/db";
import { and, eq, gte, ne, sql } from "drizzle-orm";

import { logger } from "../lib/logger";

import { crmAppUrl } from "./invite-email";
import { isSafeMailbox, providers } from "./providers";
import { getOrgSettings } from "./settings";
import { orgAdminEmails } from "./api-key-expiry-reminder";

/** Absolute URL of a lead's detail page in the CRM app. */
export function leadDetailUrl(leadId: string): string {
  const base = crmAppUrl().replace(/\/$/, "");
  return `${base}/leads/${leadId}`;
}

/** Absolute URL of the homeowner portal on the public website. */
export function portalUrl(): string {
  const override = process.env.APP_URL?.trim();
  if (override) return `${override.replace(/\/$/, "")}/portal`;
  const domain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  if (domain) return `https://${domain}/portal`;
  return "http://localhost:5000/portal";
}

export interface PortalMessageNotifyResult {
  sent: boolean;
  reason: string | null;
}

/**
 * Quiet window after a rep notification email during which further portal
 * messages on the same lead do not trigger another email. The homeowner's
 * messages still land on the timeline; the rep already has one fresh email
 * pointing them at the conversation.
 */
export const PORTAL_MESSAGE_EMAIL_QUIET_MS = 5 * 60 * 1000;

type DbExecutor = Pick<typeof db, "select">;

/**
 * True when another portal message on this lead already triggered a rep
 * notification email within the quiet window. Detected via the
 * `repEmailSentAt` marker stamped onto the message's activity row, so the
 * debounce is durable across restarts and shared between instances.
 */
async function recentlyNotified(
  executor: DbExecutor,
  params: {
    organizationId: string;
    leadId: string;
    excludeActivityId?: string;
    now: Date;
  },
): Promise<boolean> {
  const cutoff = new Date(params.now.getTime() - PORTAL_MESSAGE_EMAIL_QUIET_MS);
  const conditions = [
    eq(activitiesTable.organizationId, params.organizationId),
    eq(activitiesTable.leadId, params.leadId),
    eq(activitiesTable.type, "portal_message"),
    gte(activitiesTable.createdAt, cutoff),
    sql`${activitiesTable.metadata} ->> 'repEmailSentAt' IS NOT NULL`,
  ];
  if (params.excludeActivityId) {
    conditions.push(ne(activitiesTable.id, params.excludeActivityId));
  }
  const [row] = await executor
    .select({ id: activitiesTable.id })
    .from(activitiesTable)
    .where(and(...conditions))
    .limit(1);
  return Boolean(row);
}

/**
 * Atomically claim the quiet window for this lead by stamping the message's
 * activity row with `repEmailSentAt` — under a per-lead transaction-scoped
 * advisory lock, so two concurrent posts can never both claim it. Returns
 * true when this call won the claim (and should send the email).
 */
async function claimQuietWindow(params: {
  organizationId: string;
  leadId: string;
  activityId: string;
  now: Date;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Serialize claims per lead: concurrent posts on the same lead queue up
    // here and see each other's committed stamp.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`portal-msg-email:${params.leadId}`}))`,
    );
    if (
      await recentlyNotified(tx, {
        organizationId: params.organizationId,
        leadId: params.leadId,
        excludeActivityId: params.activityId,
        now: params.now,
      })
    ) {
      return false;
    }
    await tx
      .update(activitiesTable)
      .set({
        metadata: sql`COALESCE(${activitiesTable.metadata}, '{}'::jsonb) || ${JSON.stringify({ repEmailSentAt: params.now.toISOString() })}::jsonb`,
      })
      .where(
        and(
          eq(activitiesTable.id, params.activityId),
          eq(activitiesTable.organizationId, params.organizationId),
        ),
      );
    return true;
  });
}

/** Release a claimed quiet window after a failed send so a later message retries. */
async function releaseQuietWindow(params: {
  organizationId: string;
  activityId: string;
}): Promise<void> {
  await db
    .update(activitiesTable)
    .set({ metadata: sql`${activitiesTable.metadata} - 'repEmailSentAt'` })
    .where(
      and(
        eq(activitiesTable.id, params.activityId),
        eq(activitiesTable.organizationId, params.organizationId),
      ),
    );
}

/**
 * Notify the rep assigned to a lead that a homeowner sent a portal message.
 * When the assigned rep is not usable (missing, deactivated, or without a
 * valid mailbox), falls back to emailing the org's active owners/admins so
 * the message never sits silent. Rapid consecutive messages on the same
 * lead are debounced: if an email already went out within the quiet
 * window, no new email is sent until the window elapses.
 */
export async function notifyAssignedRepOfPortalMessage(params: {
  organizationId: string;
  leadId: string;
  messageContent: string;
  /** Activity row of the message being posted; stamped after a successful send. */
  activityId?: string;
  now?: Date;
}): Promise<PortalMessageNotifyResult> {
  try {
    const now = params.now ?? new Date();
    const [row] = await db
      .select({
        assignedUserId: leadsTable.assignedUserId,
        repEmail: usersTable.email,
        repFirstName: usersTable.firstName,
        repActive: usersTable.isActive,
        contactFirstName: contactsTable.firstName,
        contactLastName: contactsTable.lastName,
      })
      .from(leadsTable)
      .innerJoin(contactsTable, eq(leadsTable.contactId, contactsTable.id))
      .leftJoin(usersTable, eq(leadsTable.assignedUserId, usersTable.id))
      .where(
        and(
          eq(leadsTable.id, params.leadId),
          eq(leadsTable.organizationId, params.organizationId),
        ),
      )
      .limit(1);

    if (!row) {
      return { sent: false, reason: "lead not found" };
    }

    // Decide who can hear about this message. When the assigned rep is not
    // usable (missing, deactivated, or without a valid mailbox), fall back
    // to the org's active owners/admins so the message never sits silent.
    let fallbackReason: string | null = null;
    if (!row.assignedUserId) {
      fallbackReason = "no assigned rep";
    } else if (row.repActive === false) {
      fallbackReason = "assigned rep is deactivated";
    } else {
      const repEmail = row.repEmail?.trim();
      if (!repEmail || !isSafeMailbox(repEmail)) {
        fallbackReason = "assigned rep has no valid email";
      }
    }

    const leadName = [row.contactFirstName, row.contactLastName]
      .filter((part) => part?.trim())
      .join(" ")
      .trim();
    const settings = await getOrgSettings(params.organizationId);
    const businessName =
      settings.businessProfile?.businessName?.trim() || "Painless Roofing";
    const url = leadDetailUrl(params.leadId);
    const preview =
      params.messageContent.length > 500
        ? `${params.messageContent.slice(0, 500)}…`
        : params.messageContent;
    const subject = `New portal message from ${leadName || "a homeowner"}`;
    const buildBody = (greetingName: string | null) =>
      [
        `Hi ${greetingName || "there"},`,
        "",
        `${leadName || "A homeowner"} sent a new message from the claim portal:`,
        "",
        `"${preview}"`,
        "",
        `View the lead and reply here:`,
        url,
        "",
        `— ${businessName}`,
      ].join("\n");

    // Claim the quiet window atomically before sending: if another message
    // on this lead already claimed it (email sent within the window), skip.
    if (params.activityId) {
      const claimed = await claimQuietWindow({
        organizationId: params.organizationId,
        leadId: params.leadId,
        activityId: params.activityId,
        now,
      });
      if (!claimed) {
        return { sent: false, reason: "recently notified (quiet window)" };
      }
    } else if (
      await recentlyNotified(db, {
        organizationId: params.organizationId,
        leadId: params.leadId,
        now,
      })
    ) {
      return { sent: false, reason: "recently notified (quiet window)" };
    }

    // Release a claimed quiet window when nothing was delivered, so a later
    // message can notify instead of the failure silencing the whole window.
    const releaseClaim = async () => {
      if (params.activityId) {
        await releaseQuietWindow({
          organizationId: params.organizationId,
          activityId: params.activityId,
        }).catch(() => {});
      }
    };

    if (!fallbackReason) {
      try {
        await providers.email.send(
          row.repEmail!.trim(),
          subject,
          buildBody(row.repFirstName?.trim() || null),
        );
      } catch (sendErr) {
        await releaseClaim();
        throw sendErr;
      }
      return { sent: true, reason: null };
    }

    // Fallback: use the configured inbox when set, otherwise notify every
    // active org owner/admin.
    const fallbackInbox = settings.fallbackNotificationInbox?.trim() || null;
    if (fallbackInbox) {
      try {
        await providers.email.send(fallbackInbox, subject, buildBody(null));
      } catch (sendErr) {
        await releaseClaim();
        throw sendErr;
      }
      return { sent: true, reason: `${fallbackReason}; notified fallback inbox` };
    }

    const admins = await orgAdminEmails(params.organizationId);
    if (admins.length === 0) {
      logger.warn(
        { leadId: params.leadId, organizationId: params.organizationId },
        `portal message: ${fallbackReason} and no admin recipients`,
      );
      await releaseClaim();
      return { sent: false, reason: `${fallbackReason}; no admin recipients` };
    }
    let delivered = 0;
    for (const to of admins) {
      try {
        await providers.email.send(to, subject, buildBody(null));
        delivered += 1;
      } catch (err) {
        // One bad mailbox must not block the remaining admins.
        logger.error(
          { err, to, leadId: params.leadId },
          "portal message: admin fallback send failed",
        );
      }
    }
    if (delivered === 0) {
      await releaseClaim();
      return { sent: false, reason: `${fallbackReason}; all admin sends failed` };
    }
    return { sent: true, reason: `${fallbackReason}; notified org admins` };
  } catch (err) {
    logger.error(
      { err, leadId: params.leadId },
      "portal: failed to notify assigned rep of portal message",
    );
    return {
      sent: false,
      reason: err instanceof Error ? err.message : "send failed",
    };
  }
}

/**
 * Notify the rep assigned to a lead that a homeowner added new damage photos
 * to their claim from the portal. When the assigned rep is not usable
 * (missing, deactivated, or without a valid mailbox), falls back to emailing
 * the org's active owners/admins so the new evidence never sits unseen.
 * Failures are logged and never thrown.
 */
export async function notifyAssignedRepOfPortalPhotos(params: {
  organizationId: string;
  leadId: string;
  photoCount: number;
}): Promise<PortalMessageNotifyResult> {
  try {
    const [row] = await db
      .select({
        assignedUserId: leadsTable.assignedUserId,
        repEmail: usersTable.email,
        repFirstName: usersTable.firstName,
        repActive: usersTable.isActive,
        contactFirstName: contactsTable.firstName,
        contactLastName: contactsTable.lastName,
      })
      .from(leadsTable)
      .innerJoin(contactsTable, eq(leadsTable.contactId, contactsTable.id))
      .leftJoin(usersTable, eq(leadsTable.assignedUserId, usersTable.id))
      .where(
        and(
          eq(leadsTable.id, params.leadId),
          eq(leadsTable.organizationId, params.organizationId),
        ),
      )
      .limit(1);

    if (!row) {
      return { sent: false, reason: "lead not found" };
    }

    // Decide who can hear about these photos. When the assigned rep is not
    // usable (missing, deactivated, or without a valid mailbox), fall back to
    // the org's active owners/admins so new evidence never sits unseen.
    let fallbackReason: string | null = null;
    if (!row.assignedUserId) {
      fallbackReason = "no assigned rep";
    } else if (row.repActive === false) {
      fallbackReason = "assigned rep is deactivated";
    } else {
      const repEmail = row.repEmail?.trim();
      if (!repEmail || !isSafeMailbox(repEmail)) {
        fallbackReason = "assigned rep has no valid email";
      }
    }

    const leadName = [row.contactFirstName, row.contactLastName]
      .filter((part) => part?.trim())
      .join(" ")
      .trim();
    const settings = await getOrgSettings(params.organizationId);
    const businessName =
      settings.businessProfile?.businessName?.trim() || "Painless Roofing";
    const url = leadDetailUrl(params.leadId);
    const photoWord = params.photoCount === 1 ? "photo" : "photos";
    const subject = `New damage ${photoWord} from ${leadName || "a homeowner"} (${params.photoCount})`;
    const buildBody = (greetingName: string | null) =>
      [
        `Hi ${greetingName || "there"},`,
        "",
        `${leadName || "A homeowner"} added ${params.photoCount} new damage ${photoWord} to their claim from the portal.`,
        "",
        `Review the new photos on the lead timeline:`,
        url,
        "",
        `— ${businessName}`,
      ].join("\n");

    if (!fallbackReason) {
      await providers.email.send(
        row.repEmail!.trim(),
        subject,
        buildBody(row.repFirstName?.trim() || null),
      );
      return { sent: true, reason: null };
    }

    // Fallback: notify every active org owner/admin instead.
    const admins = await orgAdminEmails(params.organizationId);
    if (admins.length === 0) {
      logger.warn(
        { leadId: params.leadId, organizationId: params.organizationId },
        `portal photos: ${fallbackReason} and no admin recipients`,
      );
      return { sent: false, reason: `${fallbackReason}; no admin recipients` };
    }
    let delivered = 0;
    for (const to of admins) {
      try {
        await providers.email.send(to, subject, buildBody(null));
        delivered += 1;
      } catch (err) {
        // One bad mailbox must not block the remaining admins.
        logger.error(
          { err, to, leadId: params.leadId },
          "portal photos: admin fallback send failed",
        );
      }
    }
    if (delivered === 0) {
      return { sent: false, reason: `${fallbackReason}; all admin sends failed` };
    }
    return { sent: true, reason: `${fallbackReason}; notified org admins` };
  } catch (err) {
    logger.error(
      { err, leadId: params.leadId },
      "portal: failed to notify assigned rep of new portal photos",
    );
    return {
      sent: false,
      reason: err instanceof Error ? err.message : "send failed",
    };
  }
}

/**
 * Quiet window after a homeowner notification email during which further
 * team replies on the same lead do not trigger another email. The rep's
 * messages still land on the timeline; the homeowner already has one fresh
 * email pointing them at the conversation.
 */
export const HOMEOWNER_REPLY_EMAIL_QUIET_MS = 5 * 60 * 1000;

/**
 * True when another team_message on this lead already triggered a homeowner
 * notification email within the quiet window, detected via the
 * `homeownerEmailSentAt` marker stamped onto the activity row.
 */
async function homeownerRecentlyNotified(
  executor: DbExecutor,
  params: {
    organizationId: string;
    leadId: string;
    excludeActivityId?: string;
    now: Date;
  },
): Promise<boolean> {
  const cutoff = new Date(
    params.now.getTime() - HOMEOWNER_REPLY_EMAIL_QUIET_MS,
  );
  const conditions = [
    eq(activitiesTable.organizationId, params.organizationId),
    eq(activitiesTable.leadId, params.leadId),
    eq(activitiesTable.type, "team_message"),
    gte(activitiesTable.createdAt, cutoff),
    sql`${activitiesTable.metadata} ->> 'homeownerEmailSentAt' IS NOT NULL`,
  ];
  if (params.excludeActivityId) {
    conditions.push(ne(activitiesTable.id, params.excludeActivityId));
  }
  const [row] = await executor
    .select({ id: activitiesTable.id })
    .from(activitiesTable)
    .where(and(...conditions))
    .limit(1);
  return Boolean(row);
}

/**
 * Atomically claim the quiet window for this homeowner notification by
 * stamping the team_message activity row with `homeownerEmailSentAt` —
 * under a per-lead advisory lock so concurrent replies can never both claim.
 * Returns true when this call won the claim (and should send the email).
 */
async function claimHomeownerQuietWindow(params: {
  organizationId: string;
  leadId: string;
  activityId: string;
  now: Date;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`homeowner-reply-email:${params.leadId}`}))`,
    );
    if (
      await homeownerRecentlyNotified(tx, {
        organizationId: params.organizationId,
        leadId: params.leadId,
        excludeActivityId: params.activityId,
        now: params.now,
      })
    ) {
      return false;
    }
    await tx
      .update(activitiesTable)
      .set({
        metadata: sql`COALESCE(${activitiesTable.metadata}, '{}'::jsonb) || ${JSON.stringify({ homeownerEmailSentAt: params.now.toISOString() })}::jsonb`,
      })
      .where(
        and(
          eq(activitiesTable.id, params.activityId),
          eq(activitiesTable.organizationId, params.organizationId),
        ),
      );
    return true;
  });
}

/** Release a claimed homeowner quiet window after a failed send. */
async function releaseHomeownerQuietWindow(params: {
  organizationId: string;
  activityId: string;
}): Promise<void> {
  await db
    .update(activitiesTable)
    .set({
      metadata: sql`${activitiesTable.metadata} - 'homeownerEmailSentAt'`,
    })
    .where(
      and(
        eq(activitiesTable.id, params.activityId),
        eq(activitiesTable.organizationId, params.organizationId),
      ),
    );
}

/**
 * Notify the homeowner (the lead's contact) that the team replied to their
 * portal conversation, so they don't have to keep checking the portal.
 * No-ops (sent: false, with a reason) when the contact has no usable email.
 * Rapid consecutive replies within the quiet window produce only one email —
 * the first one claims the window; subsequent calls are suppressed until it
 * elapses. Never throws — send failures are logged and must not block the reply.
 */
export async function notifyHomeownerOfTeamReply(params: {
  organizationId: string;
  leadId: string;
  messageContent: string;
  /** Activity row of the team_message being posted; stamped after a successful send. */
  activityId?: string;
  now?: Date;
}): Promise<PortalMessageNotifyResult> {
  try {
    const now = params.now ?? new Date();

    const [row] = await db
      .select({
        contactEmail: contactsTable.email,
        contactFirstName: contactsTable.firstName,
      })
      .from(leadsTable)
      .innerJoin(contactsTable, eq(leadsTable.contactId, contactsTable.id))
      .where(
        and(
          eq(leadsTable.id, params.leadId),
          eq(leadsTable.organizationId, params.organizationId),
        ),
      )
      .limit(1);

    if (!row) {
      return { sent: false, reason: "lead not found" };
    }
    const to = row.contactEmail?.trim();
    if (!to || !isSafeMailbox(to)) {
      return { sent: false, reason: "contact has no valid email" };
    }

    // Claim the quiet window atomically before sending: if another team reply
    // on this lead already claimed it (email sent within the window), skip.
    if (params.activityId) {
      const claimed = await claimHomeownerQuietWindow({
        organizationId: params.organizationId,
        leadId: params.leadId,
        activityId: params.activityId,
        now,
      });
      if (!claimed) {
        return { sent: false, reason: "recently notified (quiet window)" };
      }
    } else if (
      await homeownerRecentlyNotified(db, {
        organizationId: params.organizationId,
        leadId: params.leadId,
        now,
      })
    ) {
      return { sent: false, reason: "recently notified (quiet window)" };
    }

    const releaseClaim = async () => {
      if (params.activityId) {
        await releaseHomeownerQuietWindow({
          organizationId: params.organizationId,
          activityId: params.activityId,
        }).catch(() => {});
      }
    };

    const settings = await getOrgSettings(params.organizationId);
    const businessName =
      settings.businessProfile?.businessName?.trim() || "Painless Roofing";
    const url = portalUrl();
    const preview =
      params.messageContent.length > 500
        ? `${params.messageContent.slice(0, 500)}…`
        : params.messageContent;

    const body = [
      `Hi ${row.contactFirstName?.trim() || "there"},`,
      "",
      `The ${businessName} team replied to your claim conversation:`,
      "",
      `"${preview}"`,
      "",
      `Sign in to your portal to read and reply:`,
      url,
      "",
      `— ${businessName}`,
    ].join("\n");

    try {
      await providers.email.send(
        to,
        `${businessName} replied to your message`,
        body,
      );
    } catch (sendErr) {
      await releaseClaim();
      throw sendErr;
    }
    return { sent: true, reason: null };
  } catch (err) {
    logger.error(
      { err, leadId: params.leadId },
      "portal: failed to notify homeowner of team reply",
    );
    return {
      sent: false,
      reason: err instanceof Error ? err.message : "send failed",
    };
  }
}
