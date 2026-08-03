import {
  appointmentsTable,
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  playbookEnrollmentsTable,
  playbooksTable,
  reactivationCampaignLeadsTable,
  reactivationCampaignsTable,
  suppressionsTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { vi } from "vitest";

// Wrap enrollLead so individual tests can make it fail once (crash-safety
// coverage); all other tests get the real implementation.
vi.mock("./playbooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./playbooks")>();
  return { ...actual, enrollLead: vi.fn(actual.enrollLead) };
});

import { enrollLead } from "./playbooks";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  createCampaign,
  drainReactivationCampaigns,
  getCampaignReport,
  importLeads,
  launchCampaign,
  parseCsv,
  previewSegment,
  recommendedSegments,
  setCampaignStatus,
} from "./reactivation";

let orgId: string;
let otherOrgId: string;
let playbookId: string;

beforeAll(async () => {
  const [org] = await db
    .insert(organizationsTable)
    .values({ name: "Reactivation Test Org", slug: `reactivation-${Date.now()}` })
    .returning();
  orgId = org.id;
  const [other] = await db
    .insert(organizationsTable)
    .values({ name: "Reactivation Other Org", slug: `reactivation-other-${Date.now()}` })
    .returning();
  otherOrgId = other.id;
  const [pb] = await db
    .insert(playbooksTable)
    .values({
      organizationId: orgId,
      name: "Win-back sequence",
      isActive: true,
      steps: [
        { channel: "email", delayMinutes: 60, prompt: "Friendly check-in" },
        { channel: "email", delayMinutes: 1440, prompt: "Second touch" },
      ],
    })
    .returning();
  playbookId = pb.id;
});

afterAll(async () => {
  await deleteTestOrgs(orgId, otherOrgId);
});

async function makeLead(
  org: string,
  opts: {
    status?: string;
    email?: string;
    createdAt?: Date;
    source?: string;
    estimatedValueCents?: number;
  } = {},
) {
  const [contact] = await db
    .insert(contactsTable)
    .values({
      organizationId: org,
      firstName: "Old",
      lastName: "Lead",
      email: opts.email ?? `old-${crypto.randomUUID()}@example.com`,
    })
    .returning();
  const [lead] = await db
    .insert(leadsTable)
    .values({
      organizationId: org,
      contactId: contact.id,
      status: (opts.status ?? "lost") as typeof leadsTable.$inferSelect.status,
      source: opts.source ?? "website",
      estimatedValueCents: opts.estimatedValueCents,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    })
    .returning();
  return { lead, contact };
}

describe("parseCsv", () => {
  it("handles quoted fields, embedded commas, and CRLF", () => {
    const rows = parseCsv('a,b\r\n"Smith, Jane",x\n"say ""hi""",y\n');
    expect(rows).toEqual([
      ["a", "b"],
      ["Smith, Jane", "x"],
      ['say "hi"', "y"],
    ]);
  });
});

describe("importLeads", () => {
  it("imports, dedupes, flags suppressed, and skips invalid rows", async () => {
    // Existing contact to collide with.
    await makeLead(orgId, { email: "existing@example.com" });
    // Suppressed address.
    await db.insert(suppressionsTable).values({
      organizationId: orgId,
      channel: "email",
      value: "optout@example.com",
      reason: "unsubscribed",
    });

    const csv = [
      "First,Last,Email,Phone",
      "Alice,Anders,alice@example.com,",
      "Bob,Brown,existing@example.com,", // dupe vs CRM
      "Cara,Cole,alice@example.com,", // dupe within file
      "Dave,Dean,optout@example.com,", // suppressed but imported
      ",Noname,missing@example.com,", // no first name
      "Eve,Empty,,", // no email or phone
    ].join("\n");

    const result = await importLeads(orgId, {
      csv,
      mapping: { firstName: 0, lastName: 1, email: 2, phone: 3 },
      fileName: "old-leads.csv",
      defaultStatus: "lost",
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.totalRows).toBe(6);
    expect(result.imported).toBe(2); // alice + dave
    expect(result.duplicates).toBe(2);
    expect(result.skipped).toBe(2);
    expect(result.suppressed).toBe(1);
    expect(result.errors.length).toBe(2);

    const [imported] = await db
      .select()
      .from(leadsTable)
      .innerJoin(contactsTable, eq(leadsTable.contactId, contactsTable.id))
      .where(
        and(eq(leadsTable.organizationId, orgId), eq(contactsTable.email, "alice@example.com")),
      );
    expect(imported.leads.creationMethod).toBe("import");
    expect(imported.leads.status).toBe("lost");
    expect(imported.leads.source).toBe("csv-import");
  });

  it("rejects a mapping without email or phone", async () => {
    const result = await importLeads(orgId, {
      csv: "First\nAlice",
      mapping: { firstName: 0 },
    });
    expect(result).toHaveProperty("error");
  });
});

describe("segments", () => {
  it("previews counts scoped to the org and filters by status/age", async () => {
    const old = new Date(Date.now() - 90 * 86_400_000);
    await makeLead(orgId, { status: "lost", createdAt: old });
    await makeLead(otherOrgId, { status: "lost", createdAt: old });

    const preview = await previewSegment(orgId, { statuses: ["lost"], minAgeDays: 60 });
    expect(preview.count).toBeGreaterThanOrEqual(1);
    expect(preview.sample.length).toBeGreaterThanOrEqual(1);

    const otherPreview = await previewSegment(otherOrgId, {
      statuses: ["lost"],
      minAgeDays: 60,
    });
    expect(otherPreview.count).toBe(1); // never sees the main org's leads

    // Nonsense statuses are dropped by sanitization → broader match, not crash.
    const sanitized = await previewSegment(orgId, { statuses: ["bogus"], minAgeDays: -5 });
    expect(sanitized.segment.statuses).toEqual([]);
  });

  it("returns recommended presets with counts", async () => {
    const presets = await recommendedSegments(orgId);
    expect(presets.length).toBeGreaterThanOrEqual(4);
    const lost = presets.find((p) => p.key === "lost");
    expect(lost).toBeDefined();
    expect(typeof lost!.count).toBe("number");
  });
});

describe("campaign lifecycle + throttle", () => {
  it("launches, paces enrollment by ratePerHour, and reactivates cold leads", async () => {
    const old = new Date(Date.now() - 400 * 86_400_000);
    const leads = [];
    for (let i = 0; i < 5; i++) {
      leads.push(await makeLead(orgId, { status: "lost", createdAt: old, source: "door-knock" }));
    }

    const campaign = await createCampaign(orgId, {
      name: "Lost win-back",
      playbookId,
      segment: { statuses: ["lost"], sources: ["door-knock"] },
      // Low rate so the pacing target stays at 1 even if this test runs for
      // minutes alongside other suites' unscoped scheduler ticks.
      ratePerHour: 2,
    });
    if ("error" in campaign) throw new Error(campaign.error);
    expect(campaign.status).toBe("draft");

    const launched = await launchCampaign(orgId, campaign.id);
    if ("error" in launched) throw new Error(launched.error);
    expect(launched.status).toBe("running");
    expect(launched.totalLeads).toBe(5);

    // Immediately after launch the target is max(1, ceil(~0h * rate)) = 1.
    await drainReactivationCampaigns(orgId);
    let rows = await db
      .select()
      .from(reactivationCampaignLeadsTable)
      .where(eq(reactivationCampaignLeadsTable.campaignId, campaign.id));
    expect(rows.filter((r) => r.status === "enrolled").length).toBe(1);

    // A second immediate drain must not exceed the pacing target.
    await drainReactivationCampaigns(orgId);
    rows = await db
      .select()
      .from(reactivationCampaignLeadsTable)
      .where(eq(reactivationCampaignLeadsTable.campaignId, campaign.id));
    expect(rows.filter((r) => r.status === "enrolled").length).toBe(1);

    // The enrolled lead was moved back into an outreach-active stage and the
    // original stage was preserved.
    const enrolledRow = rows.find((r) => r.status === "enrolled")!;
    expect(enrolledRow.previousLeadStatus).toBe("lost");
    const [reactivated] = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.id, enrolledRow.leadId));
    expect(reactivated.status).toBe("nurture");
    expect(enrolledRow.enrollmentId).toBeTruthy();

    // Backdate the launch 10 hours: target = 20 ≥ 5, so the rest drain.
    await db
      .update(reactivationCampaignsTable)
      .set({ launchedAt: new Date(Date.now() - 10 * 3_600_000) })
      .where(eq(reactivationCampaignsTable.id, campaign.id));
    await drainReactivationCampaigns(orgId);
    rows = await db
      .select()
      .from(reactivationCampaignLeadsTable)
      .where(eq(reactivationCampaignLeadsTable.campaignId, campaign.id));
    expect(rows.filter((r) => r.status === "pending").length).toBe(0);

    const report = await getCampaignReport(orgId, campaign.id);
    expect(report).not.toBeNull();
    expect(report!.campaign.status).toBe("completed");
    expect(report!.enrolled).toBe(5);

    // Cross-tenant access must 404.
    expect(await getCampaignReport(otherOrgId, campaign.id)).toBeNull();
  });

  it("pause halts draining; cancel stops sequences and pending leads", async () => {
    const old = new Date(Date.now() - 400 * 86_400_000);
    for (let i = 0; i < 3; i++) {
      await makeLead(orgId, { status: "follow_up", createdAt: old, source: "referral-x" });
    }
    const campaign = await createCampaign(orgId, {
      name: "Cancel test",
      playbookId,
      segment: { statuses: ["follow_up"], sources: ["referral-x"] },
      ratePerHour: 1,
    });
    if ("error" in campaign) throw new Error(campaign.error);
    const launched = await launchCampaign(orgId, campaign.id);
    if ("error" in launched) throw new Error(launched.error);
    await drainReactivationCampaigns(orgId); // enrolls exactly 1 (rate 1/hr)

    const paused = await setCampaignStatus(orgId, campaign.id, "pause");
    if ("error" in paused) throw new Error(paused.error);
    expect(paused.status).toBe("paused");
    await drainReactivationCampaigns(orgId); // paused → no work
    const afterPause = await db
      .select()
      .from(reactivationCampaignLeadsTable)
      .where(
        and(
          eq(reactivationCampaignLeadsTable.campaignId, campaign.id),
          eq(reactivationCampaignLeadsTable.status, "enrolled"),
        ),
      );
    expect(afterPause.length).toBe(1);

    const cancelled = await setCampaignStatus(orgId, campaign.id, "cancel");
    if ("error" in cancelled) throw new Error(cancelled.error);
    expect(cancelled.status).toBe("cancelled");

    // Pending snapshot leads are closed out...
    const [pendingCount] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(reactivationCampaignLeadsTable)
      .where(
        and(
          eq(reactivationCampaignLeadsTable.campaignId, campaign.id),
          eq(reactivationCampaignLeadsTable.status, "pending"),
        ),
      );
    expect(Number(pendingCount.n)).toBe(0);
    // ...and the live enrollment it created was stopped.
    const [enrollment] = await db
      .select()
      .from(playbookEnrollmentsTable)
      .where(eq(playbookEnrollmentsTable.id, afterPause[0].enrollmentId!));
    expect(enrollment.status).toBe("stopped");

    // A cancelled campaign can't be resumed.
    const resumed = await setCampaignStatus(orgId, campaign.id, "resume");
    expect(resumed).toHaveProperty("error");
  });

  it("cancel stops only the enrollments the campaign created", async () => {
    const old = new Date(Date.now() - 400 * 86_400_000);
    // A lead with a pre-existing live enrollment (outside any campaign).
    const outside = await makeLead(orgId, { status: "follow_up", createdAt: old });
    const [pb] = await db.select().from(playbooksTable).where(eq(playbooksTable.id, playbookId));
    const [outsideEnrollment] = await db
      .insert(playbookEnrollmentsTable)
      .values({
        organizationId: orgId,
        playbookId: pb.id,
        leadId: outside.lead.id,
        status: "active",
        currentStep: 0,
        nextRunAt: new Date(),
      })
      .returning();

    // Campaign over different leads (low rate keeps one pending so the
    // campaign is still running/cancellable after the first drain).
    await makeLead(orgId, { status: "lost", createdAt: old, source: "isolation-src" });
    await makeLead(orgId, { status: "lost", createdAt: old, source: "isolation-src" });
    const campaign = await createCampaign(orgId, {
      name: "Isolation test",
      playbookId,
      segment: { statuses: ["lost"], sources: ["isolation-src"] },
      ratePerHour: 1,
    });
    if ("error" in campaign) throw new Error(campaign.error);
    const launched = await launchCampaign(orgId, campaign.id);
    if ("error" in launched) throw new Error(launched.error);
    await drainReactivationCampaigns(orgId);

    const cancelled = await setCampaignStatus(orgId, campaign.id, "cancel");
    if ("error" in cancelled) throw new Error(cancelled.error);

    // The unrelated enrollment must still be active.
    const [stillActive] = await db
      .select()
      .from(playbookEnrollmentsTable)
      .where(eq(playbookEnrollmentsTable.id, outsideEnrollment.id));
    expect(stillActive.status).toBe("active");
  });

  it("a mid-batch enrollment failure leaves the lead pending and retryable", async () => {
    const old = new Date(Date.now() - 400 * 86_400_000);
    await makeLead(orgId, { status: "lost", createdAt: old, source: "failure-src" });
    await makeLead(orgId, { status: "lost", createdAt: old, source: "failure-src" });

    const campaign = await createCampaign(orgId, {
      name: "Failure test",
      playbookId,
      segment: { statuses: ["lost"], sources: ["failure-src"] },
      ratePerHour: 500,
    });
    if ("error" in campaign) throw new Error(campaign.error);
    const launched = await launchCampaign(orgId, campaign.id);
    if ("error" in launched) throw new Error(launched.error);
    await db
      .update(reactivationCampaignsTable)
      .set({ launchedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(reactivationCampaignsTable.id, campaign.id));

    // First enrollment in the batch blows up; the second must still process.
    vi.mocked(enrollLead).mockRejectedValueOnce(new Error("boom: provider down"));
    await drainReactivationCampaigns(orgId);

    let rows = await db
      .select()
      .from(reactivationCampaignLeadsTable)
      .where(eq(reactivationCampaignLeadsTable.campaignId, campaign.id));
    expect(rows.filter((r) => r.status === "enrolled").length).toBe(1);
    expect(rows.filter((r) => r.status === "pending").length).toBe(1);
    // No stranded rows: every enrolled row has a real enrollment link.
    expect(rows.filter((r) => r.status === "enrolled" && !r.enrollmentId)).toEqual([]);
    // The campaign must NOT be marked completed while a lead awaits retry.
    const [c] = await db
      .select()
      .from(reactivationCampaignsTable)
      .where(eq(reactivationCampaignsTable.id, campaign.id));
    expect(c.status).toBe("running");

    // Next tick retries the failed lead and finishes the campaign.
    await drainReactivationCampaigns(orgId);
    rows = await db
      .select()
      .from(reactivationCampaignLeadsTable)
      .where(eq(reactivationCampaignLeadsTable.campaignId, campaign.id));
    expect(rows.filter((r) => r.status === "enrolled").length).toBe(2);
    expect(rows.filter((r) => !r.enrollmentId)).toEqual([]);
  });

  it("reports contacted, replies, bookings, and recovered revenue", async () => {
    const old = new Date(Date.now() - 400 * 86_400_000);
    const a = await makeLead(orgId, {
      status: "lost",
      createdAt: old,
      source: "report-src",
      estimatedValueCents: 1_200_000,
    });
    const b = await makeLead(orgId, { status: "lost", createdAt: old, source: "report-src" });

    const campaign = await createCampaign(orgId, {
      name: "Report test",
      playbookId,
      segment: { statuses: ["lost"], sources: ["report-src"] },
      ratePerHour: 500,
    });
    if ("error" in campaign) throw new Error(campaign.error);
    const launched = await launchCampaign(orgId, campaign.id);
    if ("error" in launched) throw new Error(launched.error);
    await db
      .update(reactivationCampaignsTable)
      .set({ launchedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(reactivationCampaignsTable.id, campaign.id));
    await drainReactivationCampaigns(orgId);

    // Simulate engine outcomes: lead A got a touch, replied, booked, and won.
    const [rowA] = await db
      .select()
      .from(reactivationCampaignLeadsTable)
      .where(
        and(
          eq(reactivationCampaignLeadsTable.campaignId, campaign.id),
          eq(reactivationCampaignLeadsTable.leadId, a.lead.id),
        ),
      );
    await db
      .update(playbookEnrollmentsTable)
      .set({
        history: [
          { at: new Date().toISOString(), kind: "sent", stepIndex: 0, channel: "email" },
        ] as never,
        status: "completed",
        pauseReason: "reply received",
      })
      .where(eq(playbookEnrollmentsTable.id, rowA.enrollmentId!));
    await db.insert(appointmentsTable).values({
      organizationId: orgId,
      leadId: a.lead.id,
      type: "inspection",
      status: "scheduled",
      scheduledStart: new Date(Date.now() + 86_400_000),
      scheduledEnd: new Date(Date.now() + 86_400_000 + 7_200_000),
    });
    await db.update(leadsTable).set({ status: "won" }).where(eq(leadsTable.id, a.lead.id));

    const report = await getCampaignReport(orgId, campaign.id);
    expect(report).not.toBeNull();
    expect(report!.enrolled).toBe(2);
    expect(report!.contacted).toBe(1);
    expect(report!.replied).toBe(1);
    expect(report!.booked).toBe(1);
    expect(report!.recoveredRevenueCents).toBe(1_200_000);
    void b;
  });
});
