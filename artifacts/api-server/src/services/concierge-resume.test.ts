import {
  activitiesTable,
  conversationsTable,
  crmTasksTable,
  db,
  organizationsTable,
  scheduledActionsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

import { createAutomation } from "./automation";
import { handleMessage, markAbandonedConversations, startConversation } from "./concierge";

let org: { id: string };

beforeAll(async () => {
  const slug = `test-resume-${Date.now()}`;
  const [row] = await db
    .insert(organizationsTable)
    .values({ name: "Resume Test Org", slug })
    .returning();
  org = row;
});

afterAll(async () => {
  await deleteTestOrgs(org.id);
});

const say = (conversationId: string, content: string) =>
  handleMessage({ organizationId: org.id, conversationId, content });

async function getConversation(id: string) {
  const [row] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, id));
  return row;
}

async function forceStale(id: string) {
  await db.execute(
    `update conversations set updated_at = '${new Date(Date.now() - 45 * 60_000).toISOString()}' where id = '${id}'`,
  );
}

describe("abandoned chat resume", () => {
  it("abandon → resume reactivates, cancels pending follow-ups, and can complete", async () => {
    // Follow-up automation that schedules a delayed action on abandonment.
    await createAutomation(org.id, {
      name: "abandoned chat follow-up",
      event: "assessment.abandoned",
      actions: [
        {
          type: "schedule_followup",
          params: {
            delayMinutes: 60,
            action: { type: "create_task", params: { title: "Chase abandoned chat" } },
          },
        },
      ],
    });
    // Immediate task automation — fires right away on abandonment, so a rep
    // task exists when the homeowner comes back.
    await createAutomation(org.id, {
      name: "abandoned chat immediate task",
      event: "assessment.abandoned",
      actions: [{ type: "create_task", params: { title: "Chase abandoned chat now" } }],
    });

    const started = await startConversation({ organizationId: org.id });
    const id = started.conversationId;

    // Progress far enough to create a lead (name + phone).
    await say(id, "Request a quote");
    await say(id, "A few shingles blew off last week.");
    await say(id, "Resa Umer");
    await say(id, "555-000-3333");

    // Go idle >30 min → scheduler marks it abandoned and fires the automation.
    await forceStale(id);
    await markAbandonedConversations();
    let abandoned = await getConversation(id);
    expect(abandoned.status).toBe("abandoned");
    expect(abandoned.salesSummary).toContain("Concierge intake (in progress)");
    const leadId = abandoned.leadId!;
    expect(leadId).toBeTruthy();

    // The follow-up gets scheduled asynchronously; poll briefly.
    let pending: (typeof scheduledActionsTable.$inferSelect)[] = [];
    for (let i = 0; i < 20; i++) {
      pending = await db
        .select()
        .from(scheduledActionsTable)
        .where(
          and(
            eq(scheduledActionsTable.organizationId, org.id),
            eq(scheduledActionsTable.status, "pending"),
          ),
        );
      if (pending.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(pending.length).toBeGreaterThanOrEqual(1);

    // Immediate automation created a chase task while abandoned; poll briefly.
    let chaseTasks: (typeof crmTasksTable.$inferSelect)[] = [];
    for (let i = 0; i < 20; i++) {
      chaseTasks = await db
        .select()
        .from(crmTasksTable)
        .where(and(eq(crmTasksTable.organizationId, org.id), eq(crmTasksTable.leadId, leadId)));
      if (chaseTasks.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(chaseTasks.length).toBe(1);
    expect(chaseTasks[0].status).toBe("open");

    // Homeowner comes back and answers the email question → chat reactivates.
    await say(id, "skip");
    const resumed = await getConversation(id);
    expect(resumed.status).toBe("active");
    // Partial-summary snapshot cleared on resume.
    expect(resumed.salesSummary).toBeNull();

    // Pending abandoned-chat follow-up cancelled, not left to fire later.
    const [followup] = await db
      .select()
      .from(scheduledActionsTable)
      .where(eq(scheduledActionsTable.id, pending[0].id));
    expect(followup.status).toBe("cancelled");

    // Timeline activity written so the team knows to skip redundant outreach.
    const resumeActs = await db
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.organizationId, org.id),
          eq(activitiesTable.leadId, leadId),
          eq(activitiesTable.type, "conversation_resumed"),
        ),
      );
    expect(resumeActs.length).toBe(1);
    expect(resumeActs[0].title).toBe("Homeowner resumed the concierge chat");
    expect(resumeActs[0].metadata.conversationId).toBe(id);

    // Auto-created chase task closed out on resume.
    const [chase] = await db
      .select()
      .from(crmTasksTable)
      .where(eq(crmTasksTable.id, chaseTasks[0].id));
    expect(chase.status).toBe("done");
    expect(chase.completedAt).toBeTruthy();

    // Finish the flow → conversation completes normally.
    await say(id, "123 Main St");
    await say(id, "Springfield, TX 75001");
    await say(id, "Residential");
    await say(id, "Call");
    const final = await say(id, "No");
    expect(final?.done).toBe(true);
    const completed = await getConversation(id);
    expect(completed.status).toBe("completed");
    expect(completed.salesSummary).toBeTruthy();
  });

  it("resume straight to completion from abandoned works too", async () => {
    const started = await startConversation({ organizationId: org.id });
    const id = started.conversationId;
    await say(id, "Request a quote");
    await say(id, "Small leak spot on the porch roof.");
    await say(id, "Solo Finisher");
    await say(id, "555-000-4444");
    await say(id, "skip");
    await say(id, "9 Oak Ln");
    await say(id, "Austin, TX 78701");
    await say(id, "Residential");
    await say(id, "Call");

    // Abandon at the consent step, then answer it — should complete directly.
    await forceStale(id);
    await markAbandonedConversations();
    expect((await getConversation(id)).status).toBe("abandoned");

    const res = await say(id, "No");
    expect(res?.done).toBe(true);
    expect((await getConversation(id)).status).toBe("completed");
  });
});
