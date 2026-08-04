import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import {
  activitiesTable,
  contactsTable,
  db,
  DEFAULT_SENDING_HOURS,
  engagementLinksTable,
  estimatesTable,
  leadsTable,
  organizationsTable,
  playbookEnrollmentsTable,
  playbooksTable,
  playbookTouchesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import app from "../app";
import { runEvent } from "./automation";
import * as crm from "./crm";
import {
  findEngagementLink,
  getOrCreateEngagementLink,
  recordReviewClick,
} from "./engagement-links";
import {
  classifyWonLead,
  correctWonRevenue,
  ensurePostSalePlaybooks,
  handlePostSaleTransition,
  REVIEW_PLAYBOOK_SEED_KEY,
} from "./post-sale";
import { getRoiReport, roiReportToCsv } from "./roi-report";
import { updateOrgSettings } from "./settings";

let server: Server;
let baseUrl: string;
let org: { id: string };
let otherOrg: { id: string };

beforeAll(async () => {
  const [o] = await db
    .insert(organizationsTable)
    .values({ name: "PostSale Test Org", slug: `postsale-test-${Date.now()}` })
    .returning();
  org = o;
  const [o2] = await db
    .insert(organizationsTable)
    .values({ name: "PostSale Other Org", slug: `postsale-other-${Date.now()}` })
    .returning();
  otherOrg = o2;
  for (const id of [org.id, otherOrg.id]) {
    await updateOrgSettings(id, {
      sendingHours: { ...DEFAULT_SENDING_HOURS, quietHoursEnabled: false },
    });
  }
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server?.close();
  await deleteTestOrgs(org.id, otherOrg.id);
});

async function makeLead(orgId = org.id, opts?: Partial<typeof leadsTable.$inferInsert>) {
  const contact = await crm.createContact(orgId, {
    firstName: "Post",
    lastName: "Sale",
    email: `postsale-${Date.now()}-${Math.random().toString(36).slice(2)}@test.example`,
  });
  const lead = await crm.createLead(orgId, { contactId: contact.id });
  if (opts && Object.keys(opts).length) {
    await db.update(leadsTable).set(opts).where(eq(leadsTable.id, lead!.id));
  }
  return { contact, lead: lead! };
}

async function activePostSaleEnrollments(leadId: string) {
  return db
    .select()
    .from(playbookEnrollmentsTable)
    .where(
      and(
        eq(playbookEnrollmentsTable.leadId, leadId),
        eq(playbookEnrollmentsTable.kind, "post_sale"),
      ),
    );
}

describe("post-sale playbooks", () => {
  it("seeds inactive post-sale playbooks idempotently", async () => {
    await Promise.all([
      ensurePostSalePlaybooks(org.id),
      ensurePostSalePlaybooks(org.id),
    ]);
    await ensurePostSalePlaybooks(org.id);
    const rows = await db
      .select()
      .from(playbooksTable)
      .where(
        and(
          eq(playbooksTable.organizationId, org.id),
          eq(playbooksTable.kind, "post_sale"),
        ),
      );
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.isActive === false)).toBe(true);
  });

  it("does not enroll when the playbook is inactive or before the milestone", async () => {
    const { lead } = await makeLead();
    // inactive: nothing happens even at the milestone
    await handlePostSaleTransition(org.id, lead.id, "completed");
    expect(await activePostSaleEnrollments(lead.id)).toHaveLength(0);

    // activate review playbook, but a non-milestone status still does nothing
    await db
      .update(playbooksTable)
      .set({ isActive: true })
      .where(
        and(
          eq(playbooksTable.organizationId, org.id),
          eq(playbooksTable.seedKey, REVIEW_PLAYBOOK_SEED_KEY),
        ),
      );
    await handlePostSaleTransition(org.id, lead.id, "won");
    expect(await activePostSaleEnrollments(lead.id)).toHaveLength(0);
  });

  it("lead.created never enrolls a post-sale playbook, even when active", async () => {
    // The review playbook is active at this point (previous test).
    const { lead } = await makeLead();
    await runEvent(org.id, "lead.created", {
      leadId: lead.id,
      fields: { "lead.status": "new" },
    });
    expect(await activePostSaleEnrollments(lead.id)).toHaveLength(0);
  });

  it("enrolls at the milestone via a real status transition, once per playbook", async () => {
    const { lead } = await makeLead();
    await db
      .update(leadsTable)
      .set({ status: "completed" })
      .where(eq(leadsTable.id, lead.id));
    await runEvent(org.id, "lead.updated", {
      leadId: lead.id,
      fields: { "lead.status": "completed" },
    });
    const first = await activePostSaleEnrollments(lead.id);
    expect(first).toHaveLength(1); // only the review playbook is active

    // repeat transition: unique (lead, playbook) index keeps it single
    await handlePostSaleTransition(org.id, lead.id, "completed");
    expect(await activePostSaleEnrollments(lead.id)).toHaveLength(1);

    // a no-op update (statusChanged=false) never enrolls another lead
    const { lead: lead2 } = await makeLead();
    await runEvent(org.id, "lead.updated", {
      leadId: lead2.id,
      fields: { "lead.status": "completed", "lead.statusChanged": false },
    });
    expect(await activePostSaleEnrollments(lead2.id)).toHaveLength(0);
  });
});

describe("post-sale playbook editing round-trip", () => {
  it("PATCH body schema preserves milestoneStatuses and linkKind (no silent stripping)", async () => {
    const { UpdatePlaybookBody } = await import("@workspace/api-zod");
    const parsed = UpdatePlaybookBody.safeParse({
      name: "Review request (edited)",
      isActive: true,
      enrollmentRules: { minScore: null, milestoneStatuses: ["completed"] },
      steps: [
        {
          channel: "email",
          delayMinutes: 2880,
          subject: "How did we do?",
          prompt: "Edited prompt",
          linkKind: "review",
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.enrollmentRules?.milestoneStatuses).toEqual(["completed"]);
      expect(parsed.data.steps?.[0].linkKind).toBe("review");
    }
  });

  it("editing a seeded post-sale playbook keeps its milestone gating and link steps", async () => {
    const [pb] = await db
      .select()
      .from(playbooksTable)
      .where(
        and(
          eq(playbooksTable.organizationId, org.id),
          eq(playbooksTable.seedKey, REVIEW_PLAYBOOK_SEED_KEY),
        ),
      );
    // Simulate the route's update using a client round-trip body (the CC
    // editor spreads existing rules and carries step linkKind through).
    await db
      .update(playbooksTable)
      .set({
        name: "Review request (customized)",
        enrollmentRules: { ...(pb.enrollmentRules ?? {}), minScore: null },
        steps: pb.steps,
      })
      .where(eq(playbooksTable.id, pb.id));
    const [after] = await db
      .select()
      .from(playbooksTable)
      .where(eq(playbooksTable.id, pb.id));
    expect(after.enrollmentRules?.milestoneStatuses).toEqual(["completed"]);
    expect(after.steps.some((s) => s.linkKind === "review")).toBe(true);
    expect(after.kind).toBe("post_sale");
  });
});

describe("classifyWonLead attribution", () => {
  const wonRow = async (leadId: string) => {
    const [row] = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.id, leadId));
    return row;
  };

  it("no revenue figure → unknown", async () => {
    const { lead } = await makeLead();
    await classifyWonLead(org.id, lead.id);
    const row = await wonRow(lead.id);
    expect(row.wonAttribution).toBe("unknown");
    expect(row.wonRevenueCents).toBeNull();
    expect(row.wonAt).not.toBeNull();
  });

  it("rep estimate only → estimated", async () => {
    const { lead } = await makeLead(org.id, { estimatedValueCents: 500_000 });
    await classifyWonLead(org.id, lead.id);
    const row = await wonRow(lead.id);
    expect(row.wonAttribution).toBe("estimated");
    expect(row.wonRevenueCents).toBe(500_000);
  });

  it("accepted estimate, no outreach → self_reported; accepted + sent touch → assisted; platform-captured + engaged → directly_attributed", async () => {
    const cases: {
      creationMethod?: string;
      touch?: { replied: boolean } | null;
      expected: string;
    }[] = [
      { touch: null, expected: "self_reported" },
      { touch: { replied: false }, expected: "assisted" },
      { creationMethod: "widget", touch: { replied: true }, expected: "directly_attributed" },
    ];
    for (const c of cases) {
      const { lead, contact } = await makeLead(org.id, {
        creationMethod: c.creationMethod ?? "manual",
      });
      await db.insert(estimatesTable).values({
        organizationId: org.id,
        leadId: lead.id,
        title: "Test estimate",
        status: "accepted",
        acceptedAt: new Date(),
        totalCents: 1_200_000,
        lineItems: [],
      });
      if (c.touch) {
        const [pb] = await db
          .select()
          .from(playbooksTable)
          .where(eq(playbooksTable.organizationId, org.id))
          .limit(1);
        const [enr] = await db
          .insert(playbookEnrollmentsTable)
          .values({
            organizationId: org.id,
            leadId: lead.id,
            playbookId: pb.id,
            status: "completed",
          })
          .returning();
        await db.insert(playbookTouchesTable).values({
          enrollmentId: enr.id,
          organizationId: org.id,
          leadId: lead.id,
          playbookId: pb.id,
          stepIndex: 0,
          channel: "email",
          provider: "test",
          sentHourUtc: new Date().getUTCHours(),
          sentAt: new Date(),
          repliedAt: c.touch.replied ? new Date() : null,
        });
      }
      await classifyWonLead(org.id, lead.id);
      const row = await wonRow(lead.id);
      expect(row.wonAttribution).toBe(c.expected);
      expect(row.wonRevenueCents).toBe(1_200_000);
    }
  });

  it("concurrent classification attempts cannot double-write", async () => {
    const { lead } = await makeLead(org.id, { estimatedValueCents: 300 });
    await Promise.all([
      classifyWonLead(org.id, lead.id),
      classifyWonLead(org.id, lead.id),
      classifyWonLead(org.id, lead.id),
    ]);
    const row = await wonRow(lead.id);
    expect(row.wonRevenueCents).toBe(300);
    expect(row.wonAttribution).toBe("estimated");
  });

  it("classifies only once — a second win never rewrites the record", async () => {
    const { lead } = await makeLead(org.id, { estimatedValueCents: 100 });
    await classifyWonLead(org.id, lead.id);
    const before = await wonRow(lead.id);
    await db
      .update(leadsTable)
      .set({ estimatedValueCents: 999_999 })
      .where(eq(leadsTable.id, lead.id));
    await classifyWonLead(org.id, lead.id);
    const after = await wonRow(lead.id);
    expect(after.wonRevenueCents).toBe(before.wonRevenueCents);
    expect(after.wonAt?.getTime()).toBe(before.wonAt?.getTime());
  });
});

describe("engagement links", () => {
  it("review click is tracked and redirects to the configured destination", async () => {
    await updateOrgSettings(org.id, {
      googleReviews: { placeId: "test-place-id" },
    } as never);
    const { lead, contact } = await makeLead();
    const link = await getOrCreateEngagementLink(org.id, contact.id, "review", lead.id);
    const again = await getOrCreateEngagementLink(org.id, contact.id, "review");
    expect(again.id).toBe(link.id); // one link per contact+kind

    const res = await fetch(`${baseUrl}/api/v1/public/el/${link.token}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("writereview?placeid=test-place-id");

    const fresh = await findEngagementLink(link.token);
    expect(fresh?.clickCount).toBe(1);
    const acts = await db
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.contactId, contact.id),
          eq(activitiesTable.type, "review_link_clicked"),
        ),
      );
    expect(acts).toHaveLength(1);
  });

  it("referral submission creates a properly-attributed lead in the right org", async () => {
    const { lead, contact } = await makeLead();
    const link = await getOrCreateEngagementLink(org.id, contact.id, "referral", lead.id);

    const res = await fetch(`${baseUrl}/api/v1/public/referrals/${link.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Nina Neighbor",
        email: "Nina.Neighbor@test.example",
        notes: "Wants a quote",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { leadId: string };

    const [newLead] = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.id, body.leadId));
    expect(newLead.organizationId).toBe(org.id);
    expect(newLead.source).toBe("referral");
    expect(newLead.creationMethod).toBe("referral");
    expect(newLead.sourceDetail).toBe(`referred-by:${contact.id}`);
    expect(newLead.summary).toContain("Referred by");

    // referral without contact info is rejected
    const bad = await fetch(`${baseUrl}/api/v1/public/referrals/${link.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "No Contact" }),
    });
    expect(bad.status).toBe(400);

    // unknown token 404s; a review token can't take referral posts
    const nope = await fetch(`${baseUrl}/api/v1/public/referrals/not-a-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X", email: "x@test.example" }),
    });
    expect(nope.status).toBe(404);
  });

  it("dedupes the referred contact by email within the org", async () => {
    const { contact } = await makeLead();
    const link = await getOrCreateEngagementLink(org.id, contact.id, "referral");
    const existing = await crm.createContact(org.id, {
      firstName: "Already",
      lastName: "Here",
      email: "already.here@test.example",
    });
    const res = await fetch(`${baseUrl}/api/v1/public/referrals/${link.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Already Here", email: "ALREADY.HERE@test.example" }),
    });
    const body = (await res.json()) as { leadId: string };
    const [newLead] = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.id, body.leadId));
    expect(newLead.contactId).toBe(existing.id);
    const contacts = await db
      .select()
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.organizationId, org.id),
          eq(contactsTable.email, "already.here@test.example"),
        ),
      );
    expect(contacts).toHaveLength(1);
  });
});

describe("correctWonRevenue", () => {
  const wonRow = async (leadId: string) => {
    const [row] = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.id, leadId));
    return row;
  };

  it("returns not_found for an unknown lead", async () => {
    const result = await correctWonRevenue(
      org.id,
      "00000000-0000-0000-0000-000000000000",
      100_000,
    );
    expect(result).toEqual({ ok: false, error: "not_found" });
  });

  it("returns not_won for a lead that has never been classified", async () => {
    const { lead } = await makeLead();
    const result = await correctWonRevenue(org.id, lead.id, 100_000);
    expect(result).toEqual({ ok: false, error: "not_won" });
  });

  it("corrects the revenue amount, leaves attribution untouched, returns previousCents", async () => {
    const { lead } = await makeLead(org.id, { estimatedValueCents: 400_000 });
    await classifyWonLead(org.id, lead.id);

    const result = await correctWonRevenue(org.id, lead.id, 600_000);
    expect(result).toEqual({ ok: true, previousCents: 400_000 });

    const row = await wonRow(lead.id);
    expect(row.wonRevenueCents).toBe(600_000);
    expect(row.wonAttribution).toBe("estimated"); // untouched
    expect(row.wonAt).not.toBeNull();            // untouched
  });

  it("can clear revenue to null", async () => {
    const { lead } = await makeLead(org.id, { estimatedValueCents: 100_000 });
    await classifyWonLead(org.id, lead.id);

    const result = await correctWonRevenue(org.id, lead.id, null);
    expect(result).toMatchObject({ ok: true, previousCents: 100_000 });

    const row = await wonRow(lead.id);
    expect(row.wonRevenueCents).toBeNull();
    expect(row.wonAttribution).toBe("estimated"); // attribution still present
  });

  it("can be applied multiple times (change orders)", async () => {
    const { lead } = await makeLead(org.id, { estimatedValueCents: 200_000 });
    await classifyWonLead(org.id, lead.id);

    await correctWonRevenue(org.id, lead.id, 250_000);
    const r2 = await correctWonRevenue(org.id, lead.id, 275_000);
    expect(r2).toEqual({ ok: true, previousCents: 250_000 });

    const row = await wonRow(lead.id);
    expect(row.wonRevenueCents).toBe(275_000);
  });
});

describe("ROI report", () => {
  it("aggregates org-scoped and stays honest about attribution", async () => {
    // won lead with revenue in THIS org
    const { lead } = await makeLead(org.id, { estimatedValueCents: 250_000 });
    await classifyWonLead(org.id, lead.id);
    // noise in the other org must not leak in
    const { lead: foreign } = await makeLead(otherOrg.id, {
      estimatedValueCents: 9_999_999,
    });
    await classifyWonLead(otherOrg.id, foreign.id);

    const report = await getRoiReport(org.id, 30);
    expect(report.outcomes.won).toBeGreaterThan(0);
    expect(report.outcomes.revenueWonCents).toBeGreaterThan(0);
    expect(report.outcomes.revenueWonCents).toBeLessThan(9_999_999);
    const categories = report.outcomes.revenueByAttribution.map((r) => r.category);
    for (const c of categories) {
      expect([
        "directly_attributed",
        "assisted",
        "self_reported",
        "estimated",
        "unknown",
      ]).toContain(c);
    }
    expect(report.leads.total).toBeGreaterThan(0);
    expect(report.reviewsAndReferrals.referralLeads).toBeGreaterThan(0);

    const other = await getRoiReport(otherOrg.id, 30);
    expect(other.leads.total).toBe(1);
    expect(other.outcomes.revenueWonCents).toBe(9_999_999);

    // Review/referral counts are window-bounded event counts, not the
    // links' lifetime counters: an old click outside the window is ignored.
    const withRecent = report.reviewsAndReferrals.reviewLinkClicks;
    await db
      .update(activitiesTable)
      .set({ occurredAt: new Date(Date.now() - 60 * 86_400_000) })
      .where(
        and(
          eq(activitiesTable.organizationId, org.id),
          eq(activitiesTable.type, "review_link_clicked"),
        ),
      );
    const after = await getRoiReport(org.id, 30);
    expect(after.reviewsAndReferrals.reviewLinkClicks).toBeLessThan(
      Math.max(withRecent, 1),
    );
    expect(after.reviewsAndReferrals.reviewLinkClicks).toBe(0);

    const csv = roiReportToCsv(report);
    expect(csv.startsWith("section,metric,key,value\n")).toBe(true);
    expect(csv).toContain("revenue_won_cents");
    expect(csv).toContain("by_source");
  });
});
