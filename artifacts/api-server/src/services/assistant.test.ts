/**
 * Unit tests for the AI assistant service.
 *
 * - Each tool function returns sane output against a real empty org.
 * - The tool-call loop caps at MAX_TOOL_ROUNDS (5) and never runs forever.
 * - A missing OPENAI_API_KEY causes a clean throw, not a crash.
 * - Seeded-data suite: verifies aggregation logic against known counts.
 */
import {
  appointmentsTable,
  contactsTable,
  crmTasksTable,
  db,
  estimatesTable,
  leadsTable,
  organizationsTable,
  projectsTable,
  usersTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { TOOLS, buildSystemPrompt, runAssistantChat } from "./assistant";

/* ------------------------------------------------------------------ setup */

let orgId: string;

beforeAll(async () => {
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Empty Org for Assistant Tests",
      slug: `assistant-test-${Date.now()}`,
    })
    .returning();
  orgId = org.id;
  // No leads / contacts / appointments / estimates / projects / tasks —
  // intentionally empty to verify tools return zero-row results cleanly.
});

afterAll(async () => {
  await db
    .delete(usersTable)
    .where(eq(usersTable.organizationId, orgId));
  await db
    .delete(organizationsTable)
    .where(eq(organizationsTable.id, orgId));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------- buildSystemPrompt unit tests */

describe("buildSystemPrompt", () => {
  it("includes the org name when provided", () => {
    const prompt = buildSystemPrompt("Acme Roofing");
    expect(prompt).toContain("Acme Roofing's CRM");
    expect(prompt).not.toContain("this organization");
  });

  it("uses neutral fallback for null", () => {
    const prompt = buildSystemPrompt(null);
    expect(prompt).toContain("this organization's CRM");
  });

  it("uses neutral fallback for undefined", () => {
    const prompt = buildSystemPrompt(undefined);
    expect(prompt).toContain("this organization's CRM");
  });

  it("uses neutral fallback for an empty string", () => {
    const prompt = buildSystemPrompt("   ");
    expect(prompt).toContain("this organization's CRM");
  });

  it("trims whitespace from the org name", () => {
    const prompt = buildSystemPrompt("  Painless Roofing  ");
    expect(prompt).toContain("Painless Roofing's CRM");
  });
});

/* ------------------------------------------------------ tool edge cases */

describe("tool functions against an empty org", () => {
  it("get_pipeline_snapshot returns zero counts", async () => {
    const result = (await TOOLS.get_pipeline_snapshot.run(orgId, {})) as {
      newLeadsInWindow: number;
      leadsByStatus: unknown[];
      leadsBySource: unknown[];
    };
    expect(result.newLeadsInWindow).toBe(0);
    expect(result.leadsByStatus).toEqual([]);
    expect(result.leadsBySource).toEqual([]);
  });

  it("get_conversion_insights returns zero totals", async () => {
    const result = (await TOOLS.get_conversion_insights.run(orgId, {})) as {
      totals: { leads: number; won: number; lost: number; stillOpen: number };
    };
    expect(result.totals.leads).toBe(0);
    expect(result.totals.won).toBe(0);
    expect(result.totals.lost).toBe(0);
    expect(result.totals.stillOpen).toBe(0);
  });

  it("get_appointments_stats returns zero counts", async () => {
    const result = (await TOOLS.get_appointments_stats.run(orgId, {})) as {
      byStatus: unknown[];
      byType: unknown[];
      upcomingScheduled: number;
    };
    expect(result.byStatus).toEqual([]);
    expect(result.byType).toEqual([]);
    expect(result.upcomingScheduled).toBe(0);
  });

  it("get_team_workload returns empty members array and zero unassigned counts", async () => {
    const result = (await TOOLS.get_team_workload.run(orgId, {})) as {
      members: unknown[];
      unassigned: { openTasks: number; activeLeads: number };
    };
    expect(result.members).toEqual([]);
    expect(result.unassigned.openTasks).toBe(0);
    expect(result.unassigned.activeLeads).toBe(0);
  });

  it("get_revenue_summary returns empty estimates and zero booked value", async () => {
    const result = (await TOOLS.get_revenue_summary.run(orgId, {})) as {
      estimatesByStatus: unknown[];
      bookedProjectValueDollars: number;
    };
    expect(result.estimatesByStatus).toEqual([]);
    expect(result.bookedProjectValueDollars).toBe(0);
  });

  it("get_stale_leads returns empty list", async () => {
    const result = (await TOOLS.get_stale_leads.run(orgId, {})) as {
      count: number;
      leads: unknown[];
    };
    expect(result.count).toBe(0);
    expect(result.leads).toEqual([]);
  });

  it("intArg coercion: string numbers and negatives use the fallback", async () => {
    // days=0 is invalid (≤0) → fallback 30; limit=-1 is invalid → fallback 10
    const snap = (await TOOLS.get_pipeline_snapshot.run(orgId, { days: 0 })) as {
      windowDays: number;
    };
    expect(snap.windowDays).toBe(30);

    const stale = (await TOOLS.get_stale_leads.run(orgId, {
      days: -5,
      limit: -99,
    })) as { staleAfterDays: number };
    expect(stale.staleAfterDays).toBe(14);
  });

  it("intArg coercion: over-large values are capped", async () => {
    const snap = (await TOOLS.get_pipeline_snapshot.run(orgId, {
      days: 999999,
    })) as { windowDays: number };
    expect(snap.windowDays).toBe(3650);
  });
});

/* ----------------------------------------- runAssistantChat behaviour */

describe("runAssistantChat — missing API key", () => {
  it("throws a clean error when OPENAI_API_KEY is not set", async () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(
        runAssistantChat({
          organizationId: orgId,
          messages: [{ role: "user", content: "hello" }],
          onDelta: () => {},
        }),
      ).rejects.toThrow(/OPENAI_API_KEY/i);
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
    }
  });
});

/* ------------------------------------------------- tool functions with seeded data */

describe("tool functions against seeded data", () => {
  let seedOrgId: string;
  let userId: string;

  beforeAll(async () => {
    /* ---- org ---- */
    const [org] = await db
      .insert(organizationsTable)
      .values({
        name: "Seeded Org for Assistant Tests",
        slug: `assistant-seeded-${Date.now()}`,
      })
      .returning();
    seedOrgId = org.id;

    /* ---- user ---- */
    userId = `assistant-test-user-${Date.now()}`;
    await db.insert(usersTable).values({
      id: userId,
      organizationId: seedOrgId,
      firstName: "Alice",
      lastName: "Tester",
      role: "sales_rep",
    });

    /* ---- contact (FK required by leads) ---- */
    const [contact] = await db
      .insert(contactsTable)
      .values({ organizationId: seedOrgId, firstName: "Home", lastName: "Owner" })
      .returning();
    const contactId = contact.id;

    /* ---- leads ----
     * 3 won  (source=referral)
     * 1 lost  (source=referral)
     * 1 follow_up (source=website) — mid-pipeline → stillOpen
     * 1 new unassigned — will be made stale via SQL
     */
    const [lead1, lead2, lead3] = await db
      .insert(leadsTable)
      .values([
        {
          organizationId: seedOrgId,
          contactId,
          status: "won",
          source: "referral",
          assignedUserId: userId,
        },
        {
          organizationId: seedOrgId,
          contactId,
          status: "won",
          source: "referral",
          assignedUserId: userId,
        },
        {
          organizationId: seedOrgId,
          contactId,
          status: "won",
          source: "referral",
          assignedUserId: userId,
        },
      ])
      .returning();

    await db.insert(leadsTable).values([
      {
        organizationId: seedOrgId,
        contactId,
        status: "lost",
        source: "referral",
      },
      {
        organizationId: seedOrgId,
        contactId,
        status: "follow_up",
        source: "website",
        assignedUserId: userId,
      },
    ]);

    // Stale lead: status "new", updatedAt backdated 30 days
    const [staleLead] = await db
      .insert(leadsTable)
      .values({
        organizationId: seedOrgId,
        contactId,
        status: "new",
        source: "website",
        score: 5,
      })
      .returning();
    await db.execute(
      sql`UPDATE leads SET updated_at = now() - interval '30 days' WHERE id = ${staleLead.id}`,
    );

    /* ---- appointments ----
     * 2 scheduled (future) — assigned to user
     * 1 completed (past, within 30-day window)
     * 1 cancelled (past, within 30-day window)
     */
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const dayAfter = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

    await db.insert(appointmentsTable).values([
      {
        organizationId: seedOrgId,
        leadId: lead1.id,
        contactId,
        type: "inspection",
        status: "scheduled",
        scheduledStart: tomorrow,
        assignedUserId: userId,
      },
      {
        organizationId: seedOrgId,
        leadId: lead2.id,
        contactId,
        type: "inspection",
        status: "scheduled",
        scheduledStart: dayAfter,
        assignedUserId: userId,
      },
      {
        organizationId: seedOrgId,
        leadId: lead3.id,
        contactId,
        type: "estimate_review",
        status: "completed",
        scheduledStart: weekAgo,
      },
      {
        organizationId: seedOrgId,
        contactId,
        type: "inspection",
        status: "cancelled",
        scheduledStart: fiveDaysAgo,
      },
    ]);

    /* ---- tasks ----
     * 2 open for user: 1 overdue (dueAt past), 1 not overdue (dueAt future)
     * 1 done for user: should not appear in openTasks or overdueTasks
     */
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await db.insert(crmTasksTable).values([
      {
        organizationId: seedOrgId,
        assignedUserId: userId,
        title: "Follow up call",
        status: "open",
        dueAt: yesterday, // overdue
      },
      {
        organizationId: seedOrgId,
        assignedUserId: userId,
        title: "Send estimate",
        status: "open",
        dueAt: nextWeek, // not overdue
      },
      {
        organizationId: seedOrgId,
        assignedUserId: userId,
        title: "Done task",
        status: "done",
        dueAt: yesterday, // should not count even though dueAt is past
      },
    ]);

    /* ---- estimates ----
     * 1 accepted: totalCents=50000 ($500)
     * 1 sent:     totalCents=30000 ($300)
     */
    const [wonLead] = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.id, lead1.id));

    const [acceptedEstimate] = await db
      .insert(estimatesTable)
      .values({
        organizationId: seedOrgId,
        leadId: wonLead.id,
        title: "Roof Replacement",
        status: "accepted",
        totalCents: 50000,
        subtotalCents: 50000,
        taxCents: 0,
      })
      .returning();

    await db.insert(estimatesTable).values({
      organizationId: seedOrgId,
      leadId: lead2.id,
      title: "Partial Repair",
      status: "sent",
      totalCents: 30000,
      subtotalCents: 30000,
      taxCents: 0,
    });

    /* ---- project (backed by accepted estimate) ---- */
    await db.insert(projectsTable).values({
      organizationId: seedOrgId,
      leadId: wonLead.id,
      estimateId: acceptedEstimate.id,
      name: "Roof Job",
      status: "scheduled",
    });
  });

  afterAll(async () => {
    await deleteTestOrgs(seedOrgId);
  });

  /* -- pipelineSnapshot -- */
  it("pipelineSnapshot counts all 6 leads and groups them by status", async () => {
    const result = (await TOOLS.get_pipeline_snapshot.run(seedOrgId, { days: 30 })) as {
      newLeadsInWindow: number;
      leadsByStatus: { status: string; count: number }[];
      leadsBySource: { source: string; count: number }[];
    };

    expect(result.newLeadsInWindow).toBe(6);

    const statusMap = Object.fromEntries(result.leadsByStatus.map((r) => [r.status, r.count]));
    expect(statusMap["won"]).toBe(3);
    expect(statusMap["lost"]).toBe(1);
    expect(statusMap["follow_up"]).toBe(1);
    expect(statusMap["new"]).toBe(1);

    const sourceMap = Object.fromEntries(result.leadsBySource.map((r) => [r.source, r.count]));
    expect(sourceMap["referral"]).toBe(4); // 3 won + 1 lost
    expect(sourceMap["website"]).toBe(2);  // follow_up + stale new
  });

  /* -- conversionInsights -- */
  it("conversionInsights classifies won/lost/stillOpen correctly", async () => {
    const result = (await TOOLS.get_conversion_insights.run(seedOrgId, { days: 90 })) as {
      totals: { leads: number; won: number; lost: number; stillOpen: number };
      bySource: Record<string, { total: number; won: number; lost: number }>;
    };

    expect(result.totals.leads).toBe(6);
    expect(result.totals.won).toBe(3);
    expect(result.totals.lost).toBe(1);
    // follow_up (mid-pipeline) + new (stale) = 2 open
    expect(result.totals.stillOpen).toBe(2);

    // referral: 3 won + 1 lost
    expect(result.bySource["referral"].won).toBe(3);
    expect(result.bySource["referral"].lost).toBe(1);

    // website: follow_up + new → neither won nor lost
    expect(result.bySource["website"].won).toBe(0);
    expect(result.bySource["website"].lost).toBe(0);
  });

  /* -- appointmentsStats -- */
  it("appointmentsStats groups by status and counts upcoming scheduled", async () => {
    const result = (await TOOLS.get_appointments_stats.run(seedOrgId, { days: 30 })) as {
      byStatus: { status: string; count: number }[];
      byType: { type: string; count: number }[];
      upcomingScheduled: number;
    };

    const statusMap = Object.fromEntries(result.byStatus.map((r) => [r.status, r.count]));
    expect(statusMap["scheduled"]).toBe(2);
    expect(statusMap["completed"]).toBe(1);
    expect(statusMap["cancelled"]).toBe(1);

    // 2 future "scheduled" appointments
    expect(result.upcomingScheduled).toBe(2);

    const typeMap = Object.fromEntries(result.byType.map((r) => [r.type, r.count]));
    expect(typeMap["inspection"]).toBe(3); // 2 future + 1 cancelled
    expect(typeMap["estimate_review"]).toBe(1);
  });

  /* -- teamWorkload -- */
  it("teamWorkload reports correct open tasks, overdue tasks, active leads, and upcoming appointments", async () => {
    const result = (await TOOLS.get_team_workload.run(seedOrgId, {})) as {
      members: {
        name: string;
        openTasks: number;
        overdueTasks: number;
        activeLeads: number;
        upcomingAppointments: number;
      }[];
      unassigned: { openTasks: number; overdueTasks: number; activeLeads: number; upcomingAppointments: number };
    };

    expect(result.members).toHaveLength(1);
    const alice = result.members[0];
    expect(alice.name).toBe("Alice Tester");

    // 2 open tasks (the "done" task is excluded)
    expect(alice.openTasks).toBe(2);
    // 1 open task with dueAt in the past
    expect(alice.overdueTasks).toBe(1);
    // active leads: status not in ('completed','lost','nurture')
    // Alice has 3 won + 1 follow_up = 4 leads assigned. Won statuses are NOT
    // in the exclusion list ('completed','lost','nurture'), so all 4 are active.
    expect(alice.activeLeads).toBe(4);
    // 2 future scheduled appointments
    expect(alice.upcomingAppointments).toBe(2);
  });

  /* -- revenueSummary -- */
  it("revenueSummary sums totalCents per status and reports booked project value", async () => {
    const result = (await TOOLS.get_revenue_summary.run(seedOrgId, { days: 90 })) as {
      estimatesByStatus: { status: string; count: number; totalDollars: number }[];
      bookedProjectValueDollars: number;
    };

    const estMap = Object.fromEntries(
      result.estimatesByStatus.map((e) => [e.status, e]),
    );
    expect(estMap["accepted"].count).toBe(1);
    expect(estMap["accepted"].totalDollars).toBe(500);
    expect(estMap["sent"].count).toBe(1);
    expect(estMap["sent"].totalDollars).toBe(300);

    // Project backed by the $500 accepted estimate
    expect(result.bookedProjectValueDollars).toBe(500);
  });

  /* -- staleLeads -- */
  it("staleLeads returns only the lead whose updatedAt is past the threshold", async () => {
    // threshold = 14 days; only the backdated "new" lead qualifies
    const result = (await TOOLS.get_stale_leads.run(seedOrgId, { days: 14 })) as {
      count: number;
      leads: { status: string }[];
    };

    expect(result.count).toBe(1);
    expect(result.leads[0].status).toBe("new");
  });

  it("staleLeads excludes won and lost leads regardless of updatedAt", async () => {
    // With a very large stale window (1 day) every lead qualifies by time,
    // but won/lost/nurture/completed/etc. must still be excluded.
    // We set the stale window so small that even the recently-updated leads
    // would qualify — only the open-pipeline ones should appear.
    //
    // Backdate ALL leads for this assertion.
    await db.execute(
      sql`UPDATE leads SET updated_at = now() - interval '2 days' WHERE organization_id = ${seedOrgId}`,
    );
    const result = (await TOOLS.get_stale_leads.run(seedOrgId, { days: 1 })) as {
      count: number;
      leads: { status: string }[];
    };

    const statuses = result.leads.map((l) => l.status);
    expect(statuses).not.toContain("won");
    expect(statuses).not.toContain("lost");
    expect(statuses).not.toContain("completed");
    expect(statuses).not.toContain("nurture");
    // follow_up and new are open-pipeline → should be present
    expect(statuses).toContain("follow_up");
    expect(statuses).toContain("new");
  });
});

/* ----------- teamWorkload activeLeads boundary — won / completed / nurture ----------- */

describe("teamWorkload activeLeads status boundary", () => {
  let boundaryOrgId: string;
  let repId: string;

  beforeAll(async () => {
    const [org] = await db
      .insert(organizationsTable)
      .values({
        name: "Boundary Org for Workload Tests",
        slug: `workload-boundary-${Date.now()}`,
      })
      .returning();
    boundaryOrgId = org.id;

    repId = `boundary-rep-${Date.now()}`;
    await db.insert(usersTable).values({
      id: repId,
      organizationId: boundaryOrgId,
      firstName: "Bob",
      lastName: "Boundary",
      role: "sales_rep",
    });

    const [contact] = await db
      .insert(contactsTable)
      .values({ organizationId: boundaryOrgId, firstName: "Test", lastName: "Contact" })
      .returning();
    const contactId = contact.id;

    // One lead per status under test, all assigned to the rep.
    await db.insert(leadsTable).values([
      {
        organizationId: boundaryOrgId,
        contactId,
        status: "won",
        source: "referral",
        assignedUserId: repId,
      },
      {
        organizationId: boundaryOrgId,
        contactId,
        status: "completed",
        source: "referral",
        assignedUserId: repId,
      },
      {
        organizationId: boundaryOrgId,
        contactId,
        status: "nurture",
        source: "referral",
        assignedUserId: repId,
      },
    ]);
  });

  afterAll(async () => {
    await deleteTestOrgs(boundaryOrgId);
  });

  it("a lead with status 'won' appears in activeLeads", async () => {
    const result = (await TOOLS.get_team_workload.run(boundaryOrgId, {})) as {
      members: { name: string; activeLeads: number }[];
    };

    const bob = result.members.find((m) => m.name === "Bob Boundary");
    expect(bob).toBeDefined();
    // won is NOT in the exclusion list ('completed', 'lost', 'nurture')
    // so it should be counted as active.
    expect(bob!.activeLeads).toBeGreaterThanOrEqual(1);
  });

  it("a lead with status 'completed' does NOT appear in activeLeads", async () => {
    // Insert a rep with ONLY a completed lead so we can isolate the exclusion.
    const completedOnlyRepId = `completed-only-rep-${Date.now()}`;
    const [org2] = await db
      .insert(organizationsTable)
      .values({
        name: "Completed-Only Org",
        slug: `completed-only-${Date.now()}`,
      })
      .returning();

    try {
      await db.insert(usersTable).values({
        id: completedOnlyRepId,
        organizationId: org2.id,
        firstName: "Carol",
        lastName: "Completed",
        role: "sales_rep",
      });

      const [c] = await db
        .insert(contactsTable)
        .values({ organizationId: org2.id, firstName: "C", lastName: "C" })
        .returning();

      await db.insert(leadsTable).values({
        organizationId: org2.id,
        contactId: c.id,
        status: "completed",
        source: "referral",
        assignedUserId: completedOnlyRepId,
      });

      const result = (await TOOLS.get_team_workload.run(org2.id, {})) as {
        members: { name: string; activeLeads: number }[];
      };

      const carol = result.members.find((m) => m.name === "Carol Completed");
      expect(carol).toBeDefined();
      expect(carol!.activeLeads).toBe(0);
    } finally {
      await deleteTestOrgs(org2.id);
    }
  });

  it("a lead with status 'nurture' does NOT appear in activeLeads", async () => {
    const nurtureOnlyRepId = `nurture-only-rep-${Date.now()}`;
    const [org3] = await db
      .insert(organizationsTable)
      .values({
        name: "Nurture-Only Org",
        slug: `nurture-only-${Date.now()}`,
      })
      .returning();

    try {
      await db.insert(usersTable).values({
        id: nurtureOnlyRepId,
        organizationId: org3.id,
        firstName: "Dave",
        lastName: "Nurture",
        role: "sales_rep",
      });

      const [c] = await db
        .insert(contactsTable)
        .values({ organizationId: org3.id, firstName: "D", lastName: "D" })
        .returning();

      await db.insert(leadsTable).values({
        organizationId: org3.id,
        contactId: c.id,
        status: "nurture",
        source: "referral",
        assignedUserId: nurtureOnlyRepId,
      });

      const result = (await TOOLS.get_team_workload.run(org3.id, {})) as {
        members: { name: string; activeLeads: number }[];
      };

      const dave = result.members.find((m) => m.name === "Dave Nurture");
      expect(dave).toBeDefined();
      expect(dave!.activeLeads).toBe(0);
    } finally {
      await deleteTestOrgs(org3.id);
    }
  });
});

/* ----------------------------------------- runAssistantChat behaviour */

describe("runAssistantChat — tool-round cap", () => {
  it("resolves after exactly 5 tool rounds and never loops forever", async () => {
    // Every non-streaming call returns a tool_call; the 6th (streaming)
    // call returns an empty SSE stream followed by [DONE].
    let fetchCallCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        fetchCallCount += 1;
        const body = JSON.parse(init.body as string) as { stream?: boolean };

        if (!body.stream) {
          // Tool-call round: keep asking for the same tool.
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: `call_${fetchCallCount}`,
                        type: "function",
                        function: {
                          name: "get_pipeline_snapshot",
                          arguments: "{}",
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        // Streaming final-answer round: empty content, then DONE.
        const sse =
          'data: {"choices":[{"delta":{"content":"All done."}}]}\n\n' +
          "data: [DONE]\n\n";
        return new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    // Must have a key set or callOpenAi throws before fetch.
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    try {
      const deltas: string[] = [];
      const result = await runAssistantChat({
        organizationId: orgId,
        messages: [{ role: "user", content: "Give me everything" }],
        onDelta: (t) => deltas.push(t),
      });

      // Exactly MAX_TOOL_ROUNDS (5) non-streaming calls + 1 streaming call.
      expect(fetchCallCount).toBe(6);
      expect(result).toBe("All done.");
      expect(deltas).toContain("All done.");
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
      else delete process.env.OPENAI_API_KEY;
    }
  });

  it("returns the answer immediately when the model skips tool calls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: "Here is your answer.", tool_calls: [] } },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    try {
      const deltas: string[] = [];
      const result = await runAssistantChat({
        organizationId: orgId,
        messages: [{ role: "user", content: "Quick answer please" }],
        onDelta: (t) => deltas.push(t),
      });
      expect(result).toBe("Here is your answer.");
      expect(deltas).toContain("Here is your answer.");
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
      else delete process.env.OPENAI_API_KEY;
    }
  });

  it("embeds the org name from the database in the system prompt", async () => {
    let capturedSystemContent: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as {
          messages: Array<{ role: string; content: string }>;
        };
        capturedSystemContent = body.messages.find((m) => m.role === "system")?.content;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "Done.", tool_calls: [] } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    try {
      await runAssistantChat({
        organizationId: orgId,
        messages: [{ role: "user", content: "hi" }],
        onDelta: () => {},
      });
      expect(capturedSystemContent).toBeDefined();
      expect(capturedSystemContent).toContain("Empty Org for Assistant Tests");
      expect(capturedSystemContent).not.toContain("Painless Roofing");
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
      else delete process.env.OPENAI_API_KEY;
    }
  });

  it("falls back to neutral identity when the org is not found", async () => {
    let capturedSystemContent: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as {
          messages: Array<{ role: string; content: string }>;
        };
        capturedSystemContent = body.messages.find((m) => m.role === "system")?.content;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "Done.", tool_calls: [] } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    try {
      await runAssistantChat({
        // Non-existent org — DB returns no row.
        organizationId: "00000000-0000-0000-0000-000000000000",
        messages: [{ role: "user", content: "hi" }],
        onDelta: () => {},
      });
      expect(capturedSystemContent).toBeDefined();
      expect(capturedSystemContent).toContain("this organization");
      expect(capturedSystemContent).not.toContain("Painless Roofing");
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
      else delete process.env.OPENAI_API_KEY;
    }
  });

  it("picks up the new org name immediately after a rename", async () => {
    // Create a dedicated org so we can rename it without affecting other tests.
    const [renameOrg] = await db
      .insert(organizationsTable)
      .values({
        name: "Before Rename Corp",
        slug: `assistant-rename-${Date.now()}`,
      })
      .returning();
    const renameOrgId = renameOrg.id;

    const capturedPrompts: string[] = [];
    const makeFetch = () =>
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as {
          messages: Array<{ role: string; content: string }>;
        };
        const sys = body.messages.find((m) => m.role === "system")?.content;
        if (sys) capturedPrompts.push(sys);
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "Done.", tool_calls: [] } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    try {
      // First call — system prompt must include the original org name.
      vi.stubGlobal("fetch", makeFetch());
      await runAssistantChat({
        organizationId: renameOrgId,
        messages: [{ role: "user", content: "hello" }],
        onDelta: () => {},
      });
      expect(capturedPrompts[0]).toContain("Before Rename Corp");
      expect(capturedPrompts[0]).not.toContain("Painless Roofing & Water Restoration");

      // Rename the org in the database.
      await db
        .update(organizationsTable)
        .set({ name: "After Rename Corp" })
        .where(eq(organizationsTable.id, renameOrgId));

      // Second call — must reflect the new name in the very next request.
      vi.stubGlobal("fetch", makeFetch());
      await runAssistantChat({
        organizationId: renameOrgId,
        messages: [{ role: "user", content: "hello again" }],
        onDelta: () => {},
      });
      expect(capturedPrompts[1]).toContain("After Rename Corp");
      expect(capturedPrompts[1]).not.toContain("Before Rename Corp");
      expect(capturedPrompts[1]).not.toContain("Painless Roofing & Water Restoration");
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
      else delete process.env.OPENAI_API_KEY;
      // Clean up the rename org regardless of test outcome.
      await db.delete(organizationsTable).where(eq(organizationsTable.id, renameOrgId));
    }
  });

  it("records a graceful error result for an unknown tool name", async () => {
    // OpenAI calls a tool that doesn't exist; the loop should not crash.
    let round = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { stream?: boolean };
        round += 1;
        if (!body.stream && round === 1) {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: "call_unknown",
                        type: "function",
                        function: { name: "does_not_exist", arguments: "{}" },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        // Second call: answer directly.
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "Recovered.", tool_calls: [] } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    try {
      const result = await runAssistantChat({
        organizationId: orgId,
        messages: [{ role: "user", content: "Try something weird" }],
        onDelta: () => {},
      });
      expect(result).toBe("Recovered.");
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
      else delete process.env.OPENAI_API_KEY;
    }
  });
});

/* ----------------------------------------- cross-org isolation */

/**
 * Two-org fixture: Org A has leads, appointments, tasks, estimates, and a
 * project; Org B is intentionally empty.  Every TOOLS function is called for
 * both orgs and the counts are confirmed to be isolated — a missing WHERE
 * clause would make Org B's results non-zero and fail these assertions.
 */
describe("cross-org isolation: tool results never include another org's data", () => {
  let orgAId: string;
  let orgBId: string;

  beforeAll(async () => {
    const ts = Date.now();

    /* ---- Org A: has data ---- */
    const [orgA] = await db
      .insert(organizationsTable)
      .values({
        name: "Isolation Test Org A",
        slug: `isolation-org-a-${ts}`,
      })
      .returning();
    orgAId = orgA.id;

    /* ---- Org B: intentionally empty ---- */
    const [orgB] = await db
      .insert(organizationsTable)
      .values({
        name: "Isolation Test Org B",
        slug: `isolation-org-b-${ts}`,
      })
      .returning();
    orgBId = orgB.id;

    /* ---- Seed Org A ---- */
    const userAId = `isolation-user-a-${ts}`;
    await db.insert(usersTable).values({
      id: userAId,
      organizationId: orgAId,
      firstName: "Alpha",
      lastName: "Rep",
      role: "sales_rep",
    });

    const [contactA] = await db
      .insert(contactsTable)
      .values({ organizationId: orgAId, firstName: "Alpha", lastName: "Contact" })
      .returning();

    /* 2 leads: 1 won (assigned), 1 new (unassigned) */
    const [leadA1, leadA2] = await db
      .insert(leadsTable)
      .values([
        {
          organizationId: orgAId,
          contactId: contactA.id,
          status: "won",
          source: "referral",
          assignedUserId: userAId,
        },
        {
          organizationId: orgAId,
          contactId: contactA.id,
          status: "new",
          source: "website",
        },
      ])
      .returning();

    /* 1 upcoming scheduled appointment for Org A */
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.insert(appointmentsTable).values({
      organizationId: orgAId,
      leadId: leadA1.id,
      contactId: contactA.id,
      type: "inspection",
      status: "scheduled",
      scheduledStart: tomorrow,
      assignedUserId: userAId,
    });

    /* 1 open task for Org A */
    await db.insert(crmTasksTable).values({
      organizationId: orgAId,
      assignedUserId: userAId,
      title: "Follow up",
      status: "open",
      dueAt: tomorrow,
    });

    /* 1 accepted estimate + 1 project for Org A */
    const [estA] = await db
      .insert(estimatesTable)
      .values({
        organizationId: orgAId,
        leadId: leadA1.id,
        title: "Org A Estimate",
        status: "accepted",
        totalCents: 100000,
        subtotalCents: 100000,
        taxCents: 0,
      })
      .returning();

    await db.insert(projectsTable).values({
      organizationId: orgAId,
      leadId: leadA1.id,
      estimateId: estA.id,
      name: "Org A Project",
      status: "scheduled",
    });

    /* Backdate Org A's "new" lead so it qualifies as stale (>14 days) */
    await db.execute(
      sql`UPDATE leads SET updated_at = now() - interval '20 days'
          WHERE id = ${leadA2.id}`,
    );
  });

  afterAll(async () => {
    await deleteTestOrgs(orgAId, orgBId);
  });

  it("get_pipeline_snapshot: Org B sees no leads; Org A sees only its own", async () => {
    const [resultA, resultB] = await Promise.all([
      TOOLS.get_pipeline_snapshot.run(orgAId, { days: 365 }) as Promise<{
        newLeadsInWindow: number;
        leadsByStatus: { status: string; count: number }[];
        leadsBySource: { source: string; count: number }[];
      }>,
      TOOLS.get_pipeline_snapshot.run(orgBId, { days: 365 }) as Promise<{
        newLeadsInWindow: number;
        leadsByStatus: unknown[];
        leadsBySource: unknown[];
      }>,
    ]);

    // Org A has 2 leads
    expect(resultA.newLeadsInWindow).toBe(2);
    const statusMapA = Object.fromEntries(resultA.leadsByStatus.map((r) => [r.status, r.count]));
    expect(statusMapA["won"]).toBe(1);
    expect(statusMapA["new"]).toBe(1);

    // Org B has none
    expect(resultB.newLeadsInWindow).toBe(0);
    expect(resultB.leadsByStatus).toEqual([]);
    expect(resultB.leadsBySource).toEqual([]);
  });

  it("get_conversion_insights: Org B sees zero totals; Org A's won/lost counts don't bleed in", async () => {
    const [resultA, resultB] = await Promise.all([
      TOOLS.get_conversion_insights.run(orgAId, { days: 365 }) as Promise<{
        totals: { leads: number; won: number; lost: number; stillOpen: number };
      }>,
      TOOLS.get_conversion_insights.run(orgBId, { days: 365 }) as Promise<{
        totals: { leads: number; won: number; lost: number; stillOpen: number };
      }>,
    ]);

    expect(resultA.totals.leads).toBe(2);
    expect(resultA.totals.won).toBe(1);

    expect(resultB.totals.leads).toBe(0);
    expect(resultB.totals.won).toBe(0);
    expect(resultB.totals.lost).toBe(0);
    expect(resultB.totals.stillOpen).toBe(0);
  });

  it("get_appointments_stats: Org B sees no appointments; Org A's appointment doesn't bleed in", async () => {
    const [resultA, resultB] = await Promise.all([
      TOOLS.get_appointments_stats.run(orgAId, { days: 365 }) as Promise<{
        upcomingScheduled: number;
        byStatus: { status: string; count: number }[];
        byType: { type: string; count: number }[];
      }>,
      TOOLS.get_appointments_stats.run(orgBId, { days: 365 }) as Promise<{
        upcomingScheduled: number;
        byStatus: unknown[];
        byType: unknown[];
      }>,
    ]);

    expect(resultA.upcomingScheduled).toBe(1);
    const statusMapA = Object.fromEntries(resultA.byStatus.map((r) => [r.status, r.count]));
    expect(statusMapA["scheduled"]).toBe(1);

    expect(resultB.upcomingScheduled).toBe(0);
    expect(resultB.byStatus).toEqual([]);
    expect(resultB.byType).toEqual([]);
  });

  it("get_team_workload: Org B has no members or tasks; Org A's member data doesn't bleed in", async () => {
    const [resultA, resultB] = await Promise.all([
      TOOLS.get_team_workload.run(orgAId, {}) as Promise<{
        members: { name: string; openTasks: number; upcomingAppointments: number }[];
        unassigned: { openTasks: number; activeLeads: number };
      }>,
      TOOLS.get_team_workload.run(orgBId, {}) as Promise<{
        members: unknown[];
        unassigned: { openTasks: number; activeLeads: number };
      }>,
    ]);

    expect(resultA.members).toHaveLength(1);
    expect(resultA.members[0].openTasks).toBe(1);
    expect(resultA.members[0].upcomingAppointments).toBe(1);

    expect(resultB.members).toHaveLength(0);
    expect(resultB.unassigned.openTasks).toBe(0);
    expect(resultB.unassigned.activeLeads).toBe(0);
  });

  it("get_revenue_summary: Org B sees no estimates or project value; Org A's revenue doesn't bleed in", async () => {
    const [resultA, resultB] = await Promise.all([
      TOOLS.get_revenue_summary.run(orgAId, { days: 365 }) as Promise<{
        estimatesByStatus: { status: string; count: number; totalDollars: number }[];
        bookedProjectValueDollars: number;
      }>,
      TOOLS.get_revenue_summary.run(orgBId, { days: 365 }) as Promise<{
        estimatesByStatus: unknown[];
        bookedProjectValueDollars: number;
      }>,
    ]);

    const estMapA = Object.fromEntries(
      resultA.estimatesByStatus.map((e) => [e.status, e]),
    );
    expect(estMapA["accepted"].count).toBe(1);
    expect(estMapA["accepted"].totalDollars).toBe(1000);
    expect(resultA.bookedProjectValueDollars).toBe(1000);

    expect(resultB.estimatesByStatus).toEqual([]);
    expect(resultB.bookedProjectValueDollars).toBe(0);
  });

  it("get_stale_leads: Org B sees no stale leads; Org A's stale lead doesn't bleed in", async () => {
    const [resultA, resultB] = await Promise.all([
      TOOLS.get_stale_leads.run(orgAId, { days: 14 }) as Promise<{
        count: number;
        leads: { status: string }[];
      }>,
      TOOLS.get_stale_leads.run(orgBId, { days: 14 }) as Promise<{
        count: number;
        leads: unknown[];
      }>,
    ]);

    // Org A's "new" lead was backdated 20 days — qualifies as stale
    expect(resultA.count).toBe(1);
    expect(resultA.leads[0].status).toBe("new");

    // Org B has no leads at all
    expect(resultB.count).toBe(0);
    expect(resultB.leads).toEqual([]);
  });
});
