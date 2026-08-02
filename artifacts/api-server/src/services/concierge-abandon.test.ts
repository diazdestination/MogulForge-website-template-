import {
  activitiesTable,
  automationRunsTable,
  automationsTable,
  consentRecordsTable,
  conversationsTable,
  crmTasksTable,
  db,
  organizationsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

// Prevent real email/SMS sends — the Gmail connector is live in this workspace
// and hitting it during parallel test runs triggers 429 rate-limit errors.
vi.mock("./providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers")>();
  return {
    ...actual,
    providers: {
      ...actual.providers,
      email: {
        ...actual.providers.email,
        send: vi.fn(async () => ({ id: "mock-email", provider: "mock" })),
      },
      sms: {
        ...actual.providers.sms,
        send: vi.fn(async () => ({ id: "mock-sms", provider: "mock" })),
      },
    },
  };
});

import {
  createAutomation,
  DEFAULT_ABANDONED_FOLLOWUP_SEED_KEY,
  ensureDefaultAutomations,
} from "./automation";
import { markAbandonedConversations } from "./concierge";
import * as crm from "./crm";

let org: { id: string };

/** Extra orgs created inside individual tests, cleaned up in afterAll. */
const extraOrgIds: string[] = [];

beforeAll(async () => {
  const slug = `test-abandon-${Date.now()}`;
  const [row] = await db
    .insert(organizationsTable)
    .values({ name: "Abandon Test Org", slug })
    .returning();
  org = row;
});

afterAll(async () => {
  await deleteTestOrgs(org.id, ...extraOrgIds);
});

async function makeConversation(opts: {
  updatedAt: Date;
  status?: "active" | "completed";
  withLead?: boolean;
  orgId?: string;
  smsConsent?: boolean;
}) {
  const orgId = opts.orgId ?? org.id;
  let leadId: string | null = null;
  let contactId: string | null = null;
  if (opts.withLead) {
    const contact = await crm.createContact(orgId, {
      firstName: "Aband",
      lastName: "Oned",
      phone: "+15550002222",
      email: "aband.oned@test.example",
    });
    if (opts.smsConsent !== undefined) {
      await db.insert(consentRecordsTable).values({
        organizationId: orgId,
        contactId: contact.id,
        channel: "sms",
        granted: opts.smsConsent,
        disclosureVersion: "v1",
      });
    }
    const lead = await crm.createLead(orgId, { contactId: contact.id });
    leadId = lead!.id;
    contactId = contact.id;
  }
  const [conversation] = await db
    .insert(conversationsTable)
    .values({
      organizationId: orgId,
      status: opts.status ?? "active",
      leadId,
      contactId,
      intent: "leak",
      urgency: "emergency",
      state: {
        step: "email",
        urgency: "emergency",
        intent: "leak",
        firstName: "Aband",
        phone: "+15550002222",
        leadId: leadId ?? undefined,
        contactId: contactId ?? undefined,
      },
    })
    .returning();
  // Force updatedAt (insert default is now()).
  await db
    .update(conversationsTable)
    .set({ status: conversation.status })
    .where(eq(conversationsTable.id, conversation.id));
  await db.execute(
    `update conversations set updated_at = '${opts.updatedAt.toISOString()}' where id = '${conversation.id}'`,
  );
  return { conversation, leadId };
}

describe("markAbandonedConversations", () => {
  it("marks stale active conversations abandoned with a partial summary and fires automations", async () => {
    const rule = await createAutomation(org.id, {
      name: "task on abandoned chat",
      event: "assessment.abandoned",
      actions: [{ type: "create_task", params: { title: "Call back abandoned chat" } }],
    });
    const { conversation, leadId } = await makeConversation({
      updatedAt: new Date(Date.now() - 45 * 60_000),
      withLead: true,
    });

    const marked = await markAbandonedConversations();
    expect(marked).toBeGreaterThanOrEqual(1);

    const [updated] = await db
      .select()
      .from(conversationsTable)
      .where(eq(conversationsTable.id, conversation.id));
    expect(updated.status).toBe("abandoned");
    expect(updated.salesSummary).toContain("Concierge intake (in progress)");
    expect(updated.salesSummary).toContain("Aband");

    // Partial summary activity recorded on the lead.
    const acts = await db
      .select()
      .from(activitiesTable)
      .where(and(eq(activitiesTable.leadId, leadId!), eq(activitiesTable.type, "ai_summary")));
    expect(acts.some((a) => a.title.includes("abandoned"))).toBe(true);

    // Automation rule ran for the event (emit is fire-and-forget; poll briefly).
    let runs: (typeof automationRunsTable.$inferSelect)[] = [];
    for (let i = 0; i < 20; i++) {
      runs = await db
        .select()
        .from(automationRunsTable)
        .where(eq(automationRunsTable.automationId, rule.id));
      if (runs.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0].event).toBe("assessment.abandoned");
  });

  it("leaves fresh and completed conversations alone, and is idempotent", async () => {
    const fresh = await makeConversation({ updatedAt: new Date() });
    const done = await makeConversation({
      updatedAt: new Date(Date.now() - 120 * 60_000),
      status: "completed",
    });

    await markAbandonedConversations();
    await markAbandonedConversations(); // second run: nothing new in this org

    const rows = await db
      .select()
      .from(conversationsTable)
      .where(eq(conversationsTable.organizationId, org.id));
    const freshRow = rows.find((r) => r.id === fresh.conversation.id);
    const doneRow = rows.find((r) => r.id === done.conversation.id);
    expect(freshRow!.status).toBe("active");
    expect(doneRow!.status).toBe("completed");

    // Only one abandonment activity per abandoned conversation (idempotency).
    const acts = await db
      .select()
      .from(activitiesTable)
      .where(eq(activitiesTable.organizationId, org.id));
    const abandonActs = acts.filter((a) => a.title.includes("abandoned"));
    expect(abandonActs.length).toBe(1);
  });
});

describe("seeded abandoned-chat follow-up end to end", () => {
  async function makeSeededOrg() {
    const [row] = await db
      .insert(organizationsTable)
      .values({
        name: "Seeded Abandon Org",
        slug: `test-abandon-seeded-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      })
      .returning();
    extraOrgIds.push(row.id);
    await ensureDefaultAutomations(row.id);
    const [rule] = await db
      .select()
      .from(automationsTable)
      .where(
        and(
          eq(automationsTable.organizationId, row.id),
          eq(automationsTable.seedKey, DEFAULT_ABANDONED_FOLLOWUP_SEED_KEY),
        ),
      );
    expect(rule).toBeDefined();
    return { orgId: row.id, rule };
  }

  async function pollRuns(automationId: string) {
    let runs: (typeof automationRunsTable.$inferSelect)[] = [];
    for (let i = 0; i < 30; i++) {
      runs = await db
        .select()
        .from(automationRunsTable)
        .where(eq(automationRunsTable.automationId, automationId));
      if (runs.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return runs;
  }

  it("sends the SMS and creates the callback task for a consented contact", async () => {
    const { orgId, rule } = await makeSeededOrg();
    const { leadId } = await makeConversation({
      updatedAt: new Date(Date.now() - 45 * 60_000),
      withLead: true,
      orgId,
      smsConsent: true,
    });

    await markAbandonedConversations();

    const runs = await pollRuns(rule.id);
    expect(runs.length).toBe(1);
    expect(runs[0].event).toBe("assessment.abandoned");
    expect(runs[0].status).toBe("success");

    const results = runs[0].actionResults;
    const sms = results.find((r) => r.type === "send_sms");
    expect(sms?.status).toBe("success");
    const email = results.find((r) => r.type === "send_email");
    expect(email?.status).toBe("success");
    const task = results.find((r) => r.type === "create_task");
    expect(task?.status).toBe("success");

    const tasks = await db
      .select()
      .from(crmTasksTable)
      .where(
        and(
          eq(crmTasksTable.organizationId, orgId),
          eq(crmTasksTable.leadId, leadId!),
        ),
      );
    expect(
      tasks.some((t) => t.title.includes("abandoned concierge chat")),
    ).toBe(true);
  });

  it("skips the SMS without consent but still creates the callback task", async () => {
    const { orgId, rule } = await makeSeededOrg();
    const { leadId } = await makeConversation({
      updatedAt: new Date(Date.now() - 45 * 60_000),
      withLead: true,
      orgId,
      smsConsent: false,
    });

    await markAbandonedConversations();

    const runs = await pollRuns(rule.id);
    expect(runs.length).toBe(1);

    const results = runs[0].actionResults;
    const sms = results.find((r) => r.type === "send_sms");
    expect(sms?.status).toBe("skipped");
    expect(sms?.detail).toContain("no SMS consent");
    const task = results.find((r) => r.type === "create_task");
    expect(task?.status).toBe("success");

    const tasks = await db
      .select()
      .from(crmTasksTable)
      .where(
        and(
          eq(crmTasksTable.organizationId, orgId),
          eq(crmTasksTable.leadId, leadId!),
        ),
      );
    expect(
      tasks.some((t) => t.title.includes("abandoned concierge chat")),
    ).toBe(true);
  });
});
