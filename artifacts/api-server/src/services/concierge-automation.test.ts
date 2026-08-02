import {
  automationRunsTable,
  automationsTable,
  crmTasksTable,
  db,
  organizationsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

import { handleMessage, startConversation } from "./concierge";

let org: { id: string };

beforeAll(async () => {
  const [row] = await db
    .insert(organizationsTable)
    .values({ name: "Concierge Automation Org", slug: `test-conc-auto-${Date.now()}` })
    .returning();
  org = row;
  // Org rule on appointment.booked: create a prep task.
  await db.insert(automationsTable).values({
    organizationId: org.id,
    name: "Inspection prep task",
    event: "appointment.booked",
    conditions: {},
    actions: [{ type: "create_task", params: { title: "Prep inspection packet" } }],
    isActive: true,
  });
});

afterAll(async () => {
  await deleteTestOrgs(org.id);
});

/** Drive the concierge through the full intake and book the first slot. */
async function runFullFlow() {
  const start = await startConversation({ organizationId: org.id, source: "test" });
  const say = (content: string) =>
    handleMessage({ organizationId: org.id, conversationId: start.conversationId, content });

  await say("Roof repair");
  await say("A few shingles blew off last week.");
  await say("Auto Mation");
  await say("+15550001111");
  await say("skip");
  await say("456 Test Ln");
  await say("Springfield, TX 75001");
  await say("Residential");
  await say("Text");
  await say("Yes, you have my consent");
  return say("1"); // pick first slot → booked + done
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("concierge booking automations", () => {
  it("runs org appointment.booked automations for chat bookings", async () => {
    const final = await runFullFlow();
    expect(final?.done).toBe(true);
    expect(final?.leadId).toBeTruthy();

    // emitAutomationEvent is fire-and-forget — wait for the recorded run.
    const run = await waitFor(async () => {
      const [row] = await db
        .select()
        .from(automationRunsTable)
        .where(
          and(
            eq(automationRunsTable.organizationId, org.id),
            eq(automationRunsTable.event, "appointment.booked"),
          ),
        );
      return row;
    });
    expect(run.status).toBe("success");

    const tasks = await db
      .select()
      .from(crmTasksTable)
      .where(
        and(
          eq(crmTasksTable.organizationId, org.id),
          eq(crmTasksTable.title, "Prep inspection packet"),
        ),
      );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].leadId).toBe(final!.leadId);
  });
});
