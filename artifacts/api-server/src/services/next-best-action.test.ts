import {
  activitiesTable,
  appointmentsTable,
  db,
  nextActionFeedbackTable,
  organizationsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

import * as crm from "./crm";
import {
  getNextBestAction,
  listTodayActions,
  recordActionFeedback,
} from "./next-best-action";

let org: { id: string };

beforeAll(async () => {
  const slug = `test-nba-${Date.now()}`;
  const [row] = await db
    .insert(organizationsTable)
    .values({ name: "Next Best Action Test Org", slug })
    .returning();
  org = row;
});

afterAll(async () => {
  await deleteTestOrgs(org.id);
});

async function makeLead(opts: {
  score?: number;
  urgency?: string;
  status?: string;
  phone?: string | null;
  email?: string | null;
} = {}) {
  const contact = await crm.createContact(org.id, {
    firstName: "Next",
    lastName: "Action",
    phone: opts.phone === null ? undefined : (opts.phone ?? "+15550004444"),
    email: opts.email === null ? undefined : (opts.email ?? "nba@test.example"),
  });
  const lead = await crm.createLead(org.id, {
    contactId: contact.id,
    score: opts.score ?? 0,
    urgency: (opts.urgency ?? "normal") as never,
    status: (opts.status ?? "new") as never,
    summary: "Roof leak after storm",
    serviceType: "roof repair",
  });
  return { contact, lead: lead! };
}

describe("next-best-action copilot", () => {
  it("recommends replying when the homeowner has an unanswered portal message", async () => {
    const { lead, contact } = await makeLead({ score: 10 });
    await crm.createActivity(org.id, {
      leadId: lead.id,
      contactId: contact.id,
      actorUserId: null,
      type: "portal_message",
      title: "Homeowner message",
      body: "Any update?",
      metadata: {},
    });
    const action = await getNextBestAction(org.id, lead.id);
    expect(action?.actionType).toBe("reply_portal_message");
    expect(action!.priority).toBeGreaterThan(90);
    expect(action!.reasons.length).toBeGreaterThan(0);
  });

  it("recommends calling hot leads and holds off when an inspection is booked", async () => {
    const { lead } = await makeLead({ score: 90 });
    const action = await getNextBestAction(org.id, lead.id);
    expect(action?.actionType).toBe("call_now");
    expect(action?.channel).toBe("phone");

    await db.insert(appointmentsTable).values({
      organizationId: org.id,
      leadId: lead.id,
      scheduledStart: new Date(Date.now() + 86_400_000),
      status: "scheduled",
    });
    const after = await getNextBestAction(org.id, lead.id);
    expect(after?.actionType).toBe("none");
  });

  it("drafts a follow-up message for estimate_sent leads", async () => {
    const { lead } = await makeLead({ status: "estimate_sent", score: 30 });
    const action = await getNextBestAction(org.id, lead.id);
    expect(action?.actionType).toBe("follow_up_estimate");
    expect(action?.draft?.body).toBeTruthy();
    expect(action?.draft?.subject).toBeTruthy();
  });

  it("returns no action for terminal leads", async () => {
    const { lead } = await makeLead({ status: "won", score: 95 });
    const action = await getNextBestAction(org.id, lead.id);
    expect(action?.actionType).toBe("none");
  });

  it("honors snoozes and dismissals, and logs them as feedback + timeline signals", async () => {
    const { lead } = await makeLead({ score: 85 });
    const before = await getNextBestAction(org.id, lead.id);
    expect(before?.actionType).toBe("call_now");

    const ok = await recordActionFeedback(org.id, lead.id, null, {
      actionType: "call_now",
      response: "snoozed",
      snoozeHours: 24,
    });
    expect(ok).toBe(true);

    // The snoozed action type is hidden; the lead falls through to the next
    // eligible recommendation instead of going dark.
    const after = await getNextBestAction(org.id, lead.id);
    expect(after?.actionType).not.toBe("call_now");

    const rows = await db
      .select()
      .from(nextActionFeedbackTable)
      .where(
        and(
          eq(nextActionFeedbackTable.organizationId, org.id),
          eq(nextActionFeedbackTable.leadId, lead.id),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].snoozedUntil).not.toBeNull();

    const acts = await db
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.leadId, lead.id),
          eq(activitiesTable.type, "next_action_feedback"),
        ),
      );
    expect(acts).toHaveLength(1);
  });

  it("builds a prioritized today queue: replies first, then hot calls, no terminal leads", async () => {
    const { lead: hot } = await makeLead({ score: 95 });
    const { lead: replyLead, contact } = await makeLead({ score: 5 });
    await crm.createActivity(org.id, {
      leadId: replyLead.id,
      contactId: contact.id,
      actorUserId: null,
      type: "portal_message",
      title: "Homeowner message",
      body: "Hello?",
      metadata: {},
    });
    await makeLead({ status: "won" });

    const queue = await listTodayActions(org.id);
    const ids = queue.map((a) => a.leadId);
    expect(ids).toContain(hot.id);
    expect(ids).toContain(replyLead.id);
    // Reply beats even a very hot call.
    expect(ids.indexOf(replyLead.id)).toBeLessThan(ids.indexOf(hot.id));
    // Sorted by priority descending.
    for (let i = 1; i < queue.length; i++) {
      expect(queue[i - 1].priority).toBeGreaterThanOrEqual(queue[i].priority);
    }
    // Queue rows never include drafts (drafts are on-demand per lead).
    expect(queue.every((a) => !("draft" in a && (a as { draft?: unknown }).draft))).toBe(true);
  });

  it("falls through to the next eligible action when the top one is snoozed", async () => {
    // Hot lead → call_now; snoozing call_now should surface the next rule
    // (quiet re-engagement or schedule_follow_up), not go dark.
    const { lead } = await makeLead({ score: 88 });
    await recordActionFeedback(org.id, lead.id, null, {
      actionType: "call_now",
      response: "snoozed",
      snoozeHours: 4,
    });
    const action = await getNextBestAction(org.id, lead.id);
    expect(action?.actionType).not.toBe("call_now");
    expect(action?.actionType).not.toBe("none");
  });

  it("recommends replying without an email channel when the contact has no email", async () => {
    const { lead, contact } = await makeLead({ email: null, phone: null });
    await crm.createActivity(org.id, {
      leadId: lead.id,
      contactId: contact.id,
      actorUserId: null,
      type: "portal_message",
      title: "Homeowner message",
      body: "Ping",
      metadata: {},
    });
    const action = await getNextBestAction(org.id, lead.id);
    expect(action?.actionType).toBe("reply_portal_message");
    expect(action?.channel).toBeUndefined();
    expect(action?.draft).toBeUndefined();
  });

  it("clamps or defaults a malformed queue limit instead of breaking", async () => {
    await makeLead({ score: 50 });
    const bad = await listTodayActions(org.id, { limit: Number.NaN });
    expect(Array.isArray(bad)).toBe(true);
    expect(bad.length).toBeGreaterThan(0);
    const one = await listTodayActions(org.id, { limit: 1 });
    expect(one).toHaveLength(1);
    const big = await listTodayActions(org.id, { limit: 9999 });
    expect(big.length).toBeLessThanOrEqual(50);
  });

  it("recordActionFeedback rejects leads outside the org", async () => {
    const [otherOrg] = await db
      .insert(organizationsTable)
      .values({ name: "NBA Other Org", slug: `test-nba-other-${Date.now()}` })
      .returning();
    try {
      const { lead } = await makeLead();
      const ok = await recordActionFeedback(otherOrg.id, lead.id, null, {
        actionType: "call_now",
        response: "dismissed",
      });
      expect(ok).toBe(false);
    } finally {
      await deleteTestOrgs(otherOrg.id);
    }
  });
});
