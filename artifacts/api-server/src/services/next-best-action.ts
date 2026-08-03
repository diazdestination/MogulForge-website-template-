import {
  activitiesTable,
  appointmentsTable,
  contactsTable,
  db,
  leadsTable,
  nextActionFeedbackTable,
  type Lead,
} from "@workspace/db";
import { and, desc, eq, gt, inArray, or, sql } from "drizzle-orm";

import * as crm from "./crm";
import { draftOutreachMessage } from "./providers";
import { getBusinessName, getOrgSettings } from "./settings";

/**
 * Next-best-action copilot: turns the Closer Engine's signals (score,
 * urgency, engagement recency, portal messages, appointment state) into ONE
 * recommended action per lead with a human-readable "why", plus a
 * prioritized "today's actions" queue across leads. Reps always confirm —
 * nothing here sends automatically. Their responses (sent / edited /
 * snoozed / dismissed) are captured as outcome signals.
 */

export type NextActionType =
  | "reply_portal_message"
  | "call_now"
  | "send_message"
  | "follow_up_estimate"
  | "schedule_follow_up"
  | "none";

export interface NextBestAction {
  leadId: string;
  actionType: NextActionType;
  title: string;
  reasons: string[];
  priority: number;
  channel?: "email" | "sms" | "phone";
  draft?: { subject?: string; body: string; provider: string };
  leadSummary?: string | null;
  leadStatus: string;
  contactName?: string | null;
  score: number;
}

/** Dismissed recommendations stay hidden this long. */
const DISMISS_TTL_HOURS = 72;
/** Leads quiet for this many days get a re-engagement message. */
const QUIET_DAYS = 3;

const OUTREACH_STATUSES = [
  "new",
  "ai_qualified",
  "contact_attempted",
  "follow_up",
  "nurture",
];
const QUEUE_STATUSES = [...OUTREACH_STATUSES, "estimate_sent", "claim_pending"];

interface LeadSignals {
  hasUnreadPortalMessage: boolean;
  lastActivityAt: Date | null;
  hasUpcomingAppointment: boolean;
  contactName: string | null;
  hasPhone: boolean;
  hasEmail: boolean;
}

/** Suppressions in effect for a lead: actionType → why it's hidden. */
async function getSuppressions(organizationId: string, leadId: string) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - DISMISS_TTL_HOURS * 3_600_000);
  const rows = await db
    .select()
    .from(nextActionFeedbackTable)
    .where(
      and(
        eq(nextActionFeedbackTable.organizationId, organizationId),
        eq(nextActionFeedbackTable.leadId, leadId),
        inArray(nextActionFeedbackTable.response, ["snoozed", "dismissed"]),
        or(
          and(
            eq(nextActionFeedbackTable.response, "snoozed"),
            gt(nextActionFeedbackTable.snoozedUntil, now),
          ),
          and(
            eq(nextActionFeedbackTable.response, "dismissed"),
            gt(nextActionFeedbackTable.createdAt, cutoff),
          ),
        ),
      ),
    );
  const suppressed = new Set<string>();
  for (const row of rows) suppressed.add(row.actionType);
  return suppressed;
}

async function loadSignals(
  organizationId: string,
  leads: Lead[],
): Promise<Map<string, LeadSignals>> {
  const map = new Map<string, LeadSignals>();
  if (leads.length === 0) return map;
  const leadIds = leads.map((l) => l.id);
  const contactIds = [...new Set(leads.map((l) => l.contactId))];

  const [activityRows, apptRows, contactRows] = await Promise.all([
    db
      .select({
        leadId: activitiesTable.leadId,
        lastActivityAt: sql<string>`max(${activitiesTable.occurredAt})`,
        unread: sql<boolean>`COALESCE(
          max(${activitiesTable.occurredAt}) FILTER (WHERE ${activitiesTable.type} = 'portal_message') >
          COALESCE(max(${activitiesTable.occurredAt}) FILTER (WHERE ${activitiesTable.type} = 'team_message'), '-infinity'::timestamptz),
          false)`,
      })
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.organizationId, organizationId),
          inArray(activitiesTable.leadId, leadIds),
        ),
      )
      .groupBy(activitiesTable.leadId),
    db
      .select({ leadId: appointmentsTable.leadId })
      .from(appointmentsTable)
      .where(
        and(
          eq(appointmentsTable.organizationId, organizationId),
          inArray(appointmentsTable.leadId, leadIds),
          eq(appointmentsTable.status, "scheduled"),
          gt(appointmentsTable.scheduledStart, new Date()),
        ),
      ),
    db
      .select({
        id: contactsTable.id,
        firstName: contactsTable.firstName,
        lastName: contactsTable.lastName,
        phone: contactsTable.phone,
        email: contactsTable.email,
      })
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.organizationId, organizationId),
          inArray(contactsTable.id, contactIds),
        ),
      ),
  ]);

  const activityByLead = new Map(activityRows.map((r) => [r.leadId, r]));
  const upcoming = new Set(apptRows.map((r) => r.leadId));
  const contactById = new Map(contactRows.map((r) => [r.id, r]));

  for (const lead of leads) {
    const act = activityByLead.get(lead.id);
    const contact = contactById.get(lead.contactId);
    map.set(lead.id, {
      hasUnreadPortalMessage: Boolean(act?.unread),
      lastActivityAt: act?.lastActivityAt ? new Date(act.lastActivityAt) : null,
      hasUpcomingAppointment: upcoming.has(lead.id),
      contactName: contact
        ? [contact.firstName, contact.lastName].filter(Boolean).join(" ") || null
        : null,
      hasPhone: Boolean(contact?.phone),
      hasEmail: Boolean(contact?.email),
    });
  }
  return map;
}

function daysSince(date: Date | null, fallback: Date): number {
  const ref = date ?? fallback;
  return Math.floor((Date.now() - ref.getTime()) / 86_400_000);
}

/**
 * Pure ranking logic: ordered candidate actions, best first. Suppression
 * (snooze/dismiss) removes an action TYPE, and the lead falls through to
 * the next eligible recommendation instead of going dark.
 */
function rankLeadCandidates(
  lead: Lead,
  signals: LeadSignals,
): Omit<NextBestAction, "draft">[] {
  const candidates: Omit<NextBestAction, "draft">[] = [];
  const base = {
    leadId: lead.id,
    leadSummary: lead.summary,
    leadStatus: lead.status,
    contactName: signals.contactName,
    score: lead.score,
  };
  const quietDays = daysSince(signals.lastActivityAt, new Date(lead.createdAt));

  if (signals.hasUnreadPortalMessage) {
    candidates.push({
      ...base,
      actionType: "reply_portal_message",
      title: "Reply to the homeowner's message",
      // Fall back to a viable channel; without one, no draft is offered but
      // the recommendation (and its urgency) still surfaces.
      channel: signals.hasEmail ? "email" : signals.hasPhone ? "sms" : undefined,
      reasons: [
        "The homeowner sent a message and hasn't heard back yet",
        "Fast replies are the strongest conversion signal we track",
      ],
      priority: 100 + Math.min(lead.score, 100) / 10,
    });
  }

  if (signals.hasUpcomingAppointment) {
    // Hard stop: with an inspection booked, don't fall through to outreach.
    candidates.push({
      ...base,
      actionType: "none",
      title: "Inspection booked — no outreach needed",
      reasons: ["An appointment is already on the calendar"],
      priority: 0,
    });
    return candidates;
  }

  if (lead.status === "estimate_sent" || lead.status === "claim_pending") {
    candidates.push({
      ...base,
      actionType: "follow_up_estimate",
      title:
        lead.status === "estimate_sent"
          ? "Follow up on the estimate"
          : "Check in on the insurance claim",
      channel: signals.hasEmail ? "email" : signals.hasPhone ? "phone" : "email",
      reasons: [
        lead.status === "estimate_sent"
          ? "Estimate is out — a nudge now keeps it top of mind"
          : "Claim is pending — a check-in keeps the job moving",
        quietDays > 0 ? `No activity in ${quietDays} day${quietDays === 1 ? "" : "s"}` : "Stay ahead while it's fresh",
      ],
      priority: 60 + Math.min(quietDays, 10) * 2 + Math.min(lead.score, 100) / 10,
    });
  }

  const hot = lead.urgency === "emergency" || lead.score >= 70;
  if (hot && signals.hasPhone) {
    candidates.push({
      ...base,
      actionType: "call_now",
      title: "Call this lead now",
      channel: "phone",
      reasons: [
        lead.urgency === "emergency"
          ? "Marked as an emergency — speed wins these jobs"
          : `High lead score (${lead.score}) — hot leads close on the phone`,
        ...(quietDays >= 1 ? [`No touch in ${quietDays} day${quietDays === 1 ? "" : "s"}`] : []),
      ],
      priority: 80 + Math.min(lead.score, 100) / 5 + (lead.urgency === "emergency" ? 15 : 0),
    });
  }

  if (quietDays >= QUIET_DAYS && (signals.hasEmail || signals.hasPhone)) {
    candidates.push({
      ...base,
      actionType: "send_message",
      title: "Send a personal check-in",
      channel: signals.hasEmail ? "email" : "sms",
      reasons: [
        `Quiet for ${quietDays} days — a human touch re-engages stalled leads`,
        lead.score > 0 ? `Lead score ${lead.score} still shows real intent` : "Still in an active outreach stage",
      ],
      priority: 40 + Math.min(quietDays, 14) * 2 + Math.min(lead.score, 100) / 10,
    });
  }

  candidates.push({
    ...base,
    actionType: "schedule_follow_up",
    title: "Schedule a follow-up",
    reasons: ["Recently touched — set a reminder so this lead doesn't go cold"],
    priority: 20 + Math.min(lead.score, 100) / 10,
  });
  return candidates;
}

/**
 * Pick the best candidate whose action TYPE isn't snoozed/dismissed. Only
 * when every candidate is suppressed does the lead go quiet.
 */
function pickAction(
  lead: Lead,
  signals: LeadSignals,
  suppressed: Set<string>,
): Omit<NextBestAction, "draft"> {
  const candidates = rankLeadCandidates(lead, signals);
  const eligible = candidates.find(
    (c) => c.actionType === "none" || !suppressed.has(c.actionType),
  );
  if (eligible) return eligible;
  return {
    leadId: lead.id,
    actionType: "none",
    title: "Recommendation snoozed",
    reasons: ["You snoozed or dismissed this suggestion — it'll return later"],
    priority: 0,
    leadSummary: lead.summary,
    leadStatus: lead.status,
    contactName: signals.contactName,
    score: lead.score,
  };
}

async function buildDraft(
  organizationId: string,
  action: Omit<NextBestAction, "draft">,
  lead: Lead,
): Promise<NextBestAction["draft"]> {
  if (
    (action.actionType !== "send_message" &&
      action.actionType !== "follow_up_estimate" &&
      action.actionType !== "reply_portal_message") ||
    (action.channel !== "email" && action.channel !== "sms")
  ) {
    return undefined;
  }
  const settings = await getOrgSettings(organizationId);
  const businessName =
    await getBusinessName(organizationId);
  const prompts: Record<string, string> = {
    send_message:
      "Personal check-in from their rep. Warm, short, one clear next step (book the free inspection or reply with questions). No pressure.",
    follow_up_estimate:
      "Follow-up on the estimate we already sent. Ask if they have questions and offer to walk through it. Do not restate or change any numbers.",
    reply_portal_message:
      "Reply to a homeowner who just messaged us. Thank them for reaching out and let them know their rep is on it with a clear next step.",
  };
  const firstName = action.contactName?.split(" ")[0] || "there";
  const { body, provider } = await draftOutreachMessage({
    channel: action.channel,
    prompt: prompts[action.actionType],
    businessName,
    contactFirstName: firstName,
    leadSummary: lead.summary ?? undefined,
    serviceType: lead.serviceType ?? undefined,
    urgency: lead.urgency,
    stepNumber: 1,
    totalSteps: 1,
  });
  return {
    subject:
      action.channel === "email"
        ? action.actionType === "follow_up_estimate"
          ? `Your ${businessName} estimate — any questions?`
          : `Checking in from ${businessName}`
        : undefined,
    body,
    provider,
  };
}

/** Next best action for one lead, with an AI draft when it's a message. */
export async function getNextBestAction(
  organizationId: string,
  leadId: string,
): Promise<NextBestAction | null> {
  const lead = await crm.getLead(organizationId, leadId);
  if (!lead) return null;

  const terminal = ["won", "lost", "completed"];
  if (terminal.includes(lead.status)) {
    return {
      leadId: lead.id,
      actionType: "none",
      title: "No action needed",
      reasons: [`Lead is ${lead.status.replace(/_/g, " ")}`],
      priority: 0,
      leadSummary: lead.summary,
      leadStatus: lead.status,
      contactName: null,
      score: lead.score,
    };
  }

  const [signalsMap, suppressed] = await Promise.all([
    loadSignals(organizationId, [lead]),
    getSuppressions(organizationId, leadId),
  ]);
  const ranked = pickAction(lead, signalsMap.get(lead.id)!, suppressed);
  const draft = await buildDraft(organizationId, ranked, lead).catch(() => undefined);
  return { ...ranked, draft };
}

/** Prioritized queue across all workable leads (no drafts — on demand). */
export async function listTodayActions(
  organizationId: string,
  opts: { limit?: number } = {},
): Promise<Omit<NextBestAction, "draft">[]> {
  const limit = Number.isFinite(opts.limit)
    ? Math.min(Math.max(Math.trunc(opts.limit!), 1), 50)
    : 25;
  const leads = await db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.organizationId, organizationId),
        inArray(
          leadsTable.status,
          QUEUE_STATUSES as (typeof leadsTable.$inferSelect.status)[],
        ),
      ),
    )
    .orderBy(desc(leadsTable.score), desc(leadsTable.createdAt))
    .limit(200);
  if (leads.length === 0) return [];

  const [signalsMap, feedbackRows] = await Promise.all([
    loadSignals(organizationId, leads),
    db
      .select()
      .from(nextActionFeedbackTable)
      .where(
        and(
          eq(nextActionFeedbackTable.organizationId, organizationId),
          inArray(
            nextActionFeedbackTable.leadId,
            leads.map((l) => l.id),
          ),
          inArray(nextActionFeedbackTable.response, ["snoozed", "dismissed"]),
        ),
      ),
  ]);

  const now = Date.now();
  const cutoff = now - DISMISS_TTL_HOURS * 3_600_000;
  const suppressedByLead = new Map<string, Set<string>>();
  for (const row of feedbackRows) {
    const live =
      row.response === "snoozed"
        ? row.snoozedUntil && row.snoozedUntil.getTime() > now
        : row.createdAt.getTime() > cutoff;
    if (!live) continue;
    if (!suppressedByLead.has(row.leadId)) suppressedByLead.set(row.leadId, new Set());
    suppressedByLead.get(row.leadId)!.add(row.actionType);
  }

  return leads
    .map((lead) =>
      pickAction(
        lead,
        signalsMap.get(lead.id)!,
        suppressedByLead.get(lead.id) ?? new Set(),
      ),
    )
    .filter((a) => a.actionType !== "none")
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit);
}

/** Record how the rep responded; snoozes/dismissals hide the suggestion. */
export async function recordActionFeedback(
  organizationId: string,
  leadId: string,
  actorUserId: string | null,
  input: {
    actionType: string;
    response: "sent" | "edited" | "snoozed" | "dismissed";
    snoozeHours?: number;
  },
): Promise<boolean> {
  const lead = await crm.getLead(organizationId, leadId);
  if (!lead) return false;
  const snoozedUntil =
    input.response === "snoozed"
      ? new Date(Date.now() + Math.min(Math.max(input.snoozeHours ?? 24, 1), 24 * 14) * 3_600_000)
      : null;
  await db.insert(nextActionFeedbackTable).values({
    organizationId,
    leadId,
    actorUserId,
    actionType: input.actionType,
    response: input.response,
    snoozedUntil,
  });
  if (input.response === "snoozed" || input.response === "dismissed") {
    await crm.createActivity(organizationId, {
      leadId,
      contactId: lead.contactId,
      actorUserId,
      type: "next_action_feedback",
      title:
        input.response === "snoozed"
          ? "Next-best-action suggestion snoozed"
          : "Next-best-action suggestion dismissed",
      body: null,
      metadata: { actionType: input.actionType, response: input.response },
    });
  }
  return true;
}

// ---------- Copilot performance (learning-loop insights) ----------

export interface CopilotActionTypeStats {
  actionType: string;
  sent: number;
  edited: number;
  snoozed: number;
  dismissed: number;
  total: number;
  /** (sent + edited) / total, null when there's no feedback for the type. */
  acceptanceRate: number | null;
}

export interface CopilotPerformance {
  byActionType: CopilotActionTypeStats[];
  conversion: {
    /** Leads where at least one suggestion was sent/edited (acted on). */
    actedLeads: number;
    actedWon: number;
    /** Leads whose only responses were snoozes/dismissals. */
    dismissedLeads: number;
    dismissedWon: number;
  };
  totalFeedback: number;
}

/**
 * Aggregates rep responses to copilot suggestions: acceptance per action
 * type, plus a won-rate comparison between leads whose suggestions were
 * acted on vs only dismissed/snoozed. Org-scoped; read-only.
 */
export async function getCopilotPerformance(
  organizationId: string,
): Promise<CopilotPerformance> {
  const [byTypeRows, byLeadRows] = await Promise.all([
    db
      .select({
        actionType: nextActionFeedbackTable.actionType,
        response: nextActionFeedbackTable.response,
        count: sql<number>`count(*)::int`,
      })
      .from(nextActionFeedbackTable)
      .where(eq(nextActionFeedbackTable.organizationId, organizationId))
      .groupBy(
        nextActionFeedbackTable.actionType,
        nextActionFeedbackTable.response,
      ),
    db
      .select({
        leadId: nextActionFeedbackTable.leadId,
        acted: sql<boolean>`bool_or(${nextActionFeedbackTable.response} IN ('sent', 'edited'))`,
        won: sql<boolean>`bool_or(${leadsTable.status} = 'won')`,
      })
      .from(nextActionFeedbackTable)
      .innerJoin(leadsTable, eq(nextActionFeedbackTable.leadId, leadsTable.id))
      .where(eq(nextActionFeedbackTable.organizationId, organizationId))
      .groupBy(nextActionFeedbackTable.leadId),
  ]);

  const byType = new Map<string, CopilotActionTypeStats>();
  let totalFeedback = 0;
  for (const row of byTypeRows) {
    const stats = byType.get(row.actionType) ?? {
      actionType: row.actionType,
      sent: 0,
      edited: 0,
      snoozed: 0,
      dismissed: 0,
      total: 0,
      acceptanceRate: null,
    };
    if (
      row.response === "sent" ||
      row.response === "edited" ||
      row.response === "snoozed" ||
      row.response === "dismissed"
    ) {
      stats[row.response] += row.count;
    }
    stats.total += row.count;
    totalFeedback += row.count;
    byType.set(row.actionType, stats);
  }
  const byActionType = [...byType.values()]
    .map((s) => ({
      ...s,
      acceptanceRate: s.total > 0 ? (s.sent + s.edited) / s.total : null,
    }))
    .sort((a, b) => b.total - a.total);

  const conversion = {
    actedLeads: 0,
    actedWon: 0,
    dismissedLeads: 0,
    dismissedWon: 0,
  };
  for (const row of byLeadRows) {
    if (row.acted) {
      conversion.actedLeads += 1;
      if (row.won) conversion.actedWon += 1;
    } else {
      conversion.dismissedLeads += 1;
      if (row.won) conversion.dismissedWon += 1;
    }
  }

  return { byActionType, conversion, totalFeedback };
}
