/**
 * Visitor intelligence & lead attribution: first/last-touch persistence on
 * the lead row across capture paths, consent-aware session→lead association
 * at identification time, anonymous isolation, and behavior-aware scoring
 * with stored reasons.
 */
import {
  analyticsEventsTable,
  db,
  DEFAULT_LEAD_SCORING,
  leadsTable,
  organizationsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

import { captureAssessment } from "./assessment";
import {
  buildTouch,
  getLeadBehaviorSummary,
  getVisitorBehavior,
  leadAttributionColumns,
  repeatTouchColumns,
  scoreBehavior,
} from "./attribution";
import { captureFormSubmission, createForm, getPublicFormRow } from "./forms";
import { captureWidgetLead } from "./widget";

let org: { id: string };
let otherOrg: { id: string };

const ATTR = {
  utmSource: "google",
  utmMedium: "cpc",
  utmCampaign: "storm-2026",
  landingPage: "/financing",
  referrer: "https://google.com/",
};

/** Seed prior anonymous session activity for a visitor id. */
async function seedVisit(
  organizationId: string,
  anonymousId: string,
  daysAgo: number,
  events: { eventName: string; path?: string }[],
) {
  const at = new Date(Date.now() - daysAgo * 86_400_000);
  await db.insert(analyticsEventsTable).values(
    events.map((e, i) => ({
      organizationId,
      eventName: e.eventName,
      anonymousId,
      sessionId: `sess-${daysAgo}`,
      path: e.path ?? "/",
      occurredAt: new Date(at.getTime() + i * 60_000),
    })),
  );
}

beforeAll(async () => {
  const stamp = Date.now();
  const [a] = await db
    .insert(organizationsTable)
    .values({ name: "Attribution Test Org", slug: `test-attr-${stamp}` })
    .returning();
  org = a;
  const [b] = await db
    .insert(organizationsTable)
    .values({ name: "Attribution Other Org", slug: `test-attr-b-${stamp}` })
    .returning();
  otherOrg = b;
});

afterAll(async () => {
  await deleteTestOrgs(org.id, otherOrg.id);
});

describe("touch helpers", () => {
  it("normalizes attribution and fills first/last touch columns", () => {
    const touch = buildTouch({ channel: "web", source: "website", attribution: ATTR });
    expect(touch.utm).toEqual({ source: "google", medium: "cpc", campaign: "storm-2026" });
    const cols = leadAttributionColumns({
      source: "website",
      creationMethod: "assessment",
      touch,
      anonymousId: "anon-1",
    });
    expect(cols).toMatchObject({
      source: "website",
      latestSource: "website",
      campaign: "storm-2026",
      landingPage: "/financing",
      referrer: "https://google.com/",
      creationMethod: "assessment",
      anonymousId: "anon-1",
    });
    expect(cols.firstTouch).toEqual(cols.lastTouch);
  });

  it("repeat touches move last-touch forward without disturbing first-touch fields", () => {
    const touch = buildTouch({
      channel: "web",
      source: "spring-promo",
      attribution: { utmCampaign: "spring" },
    });
    const cols = repeatTouchColumns({
      source: "spring-promo",
      touch,
      existing: { anonymousId: "anon-original", campaign: "storm-2026" },
      anonymousId: "anon-else",
    });
    expect(cols.latestSource).toBe("spring-promo");
    expect(cols.lastTouch).toEqual(touch);
    // Existing campaign and visitor link win — first identification sticks.
    expect(cols).not.toHaveProperty("campaign");
    expect(cols).not.toHaveProperty("anonymousId");
  });
});

describe("attribution persistence across capture paths", () => {
  it("assessment submissions persist attribution, creation method, and visitor link", async () => {
    const anon = `anon-assess-${Date.now()}`;
    await seedVisit(org.id, anon, 3, [
      { eventName: "page_view", path: "/financing" },
      { eventName: "page_view", path: "/services" },
    ]);
    await seedVisit(org.id, anon, 1, [{ eventName: "assessment_started", path: "/assessment" }]);

    const result = await captureAssessment({
      organizationId: org.id,
      submission: {
        firstName: "Attr",
        phone: "555-000-1111",
        addressLine1: "1 Main St",
        city: "Atlanta",
        state: "GA",
        postalCode: "30301",
        intent: "storm",
        source: "website",
        attribution: ATTR,
        anonymousId: anon,
        consent: { smsGranted: true, emailGranted: true, disclosureVersion: "t.v1" },
      },
    });

    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, result.leadId));
    expect(lead).toMatchObject({
      source: "website",
      latestSource: "website",
      campaign: "storm-2026",
      landingPage: "/financing",
      referrer: "https://google.com/",
      creationMethod: "assessment",
      anonymousId: anon,
    });
    expect((lead.firstTouch as any).utm.campaign).toBe("storm-2026");
    // Behavior signals landed in the score reasons.
    expect(lead.scoreReasons.join(" ")).toMatch(/Returned to the website on 2 separate days/);
    expect(lead.scoreReasons.join(" ")).toMatch(/high-intent pages/);
    expect(lead.scoreReasons.join(" ")).toMatch(/on-site tools/);
  });

  it("anonymous submissions stay anonymous: no link, no behavior reasons", async () => {
    const result = await captureAssessment({
      organizationId: org.id,
      submission: {
        firstName: "Anon",
        phone: "555-000-2222",
        addressLine1: "2 Main St",
        city: "Atlanta",
        state: "GA",
        postalCode: "30301",
        intent: "general",
        consent: { smsGranted: false, emailGranted: false, disclosureVersion: "t.v1" },
      },
    });
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, result.leadId));
    expect(lead.anonymousId).toBeNull();
    expect(lead.creationMethod).toBe("assessment");
    expect(lead.scoreReasons.join(" ")).not.toMatch(/Returned to the website/);
  });

  it("widget submissions persist attribution and creation method", async () => {
    const { leadId } = await captureWidgetLead({
      organizationId: org.id,
      submission: {
        firstName: "Widget",
        phone: "555-000-3333",
        attribution: ATTR,
        anonymousId: "anon-widget-1",
      },
    });
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
    expect(lead).toMatchObject({
      source: "widget",
      latestSource: "widget",
      campaign: "storm-2026",
      landingPage: "/financing",
      creationMethod: "widget",
      anonymousId: "anon-widget-1",
    });
  });

  it("form submissions persist attribution; repeat submissions update last touch and link the visitor", async () => {
    const form = await createForm(org.id, {
      name: "Attr form",
      slug: `attr-form-${Date.now()}`,
      status: "published",
      steps: [
        {
          key: "contact",
          title: "Contact",
          fields: [
            { key: "first", type: "text", label: "First", required: true, mapTo: "contact.firstName" },
            { key: "phone", type: "phone", label: "Phone", required: true, mapTo: "contact.phone" },
          ],
        },
      ],
    });
    expect(form && "id" in form).toBe(true);
    const row = await getPublicFormRow(org.id, (form as any).slug);
    const first = await captureFormSubmission({
      organizationId: org.id,
      form: row!,
      answers: { first: "Form", phone: "555-000-4444" },
      attribution: ATTR,
    });
    if ("error" in first) throw new Error(first.error);
    let [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, first.leadId));
    expect(lead.creationMethod).toBe("form");
    expect(lead.campaign).toBe("storm-2026");
    expect(lead.anonymousId).toBeNull();
    const originalFirstTouch = lead.firstTouch;

    // Repeat submission: new source, visitor now identified with an id.
    const again = await captureFormSubmission({
      organizationId: org.id,
      form: row!,
      answers: { first: "Form", phone: "555-000-4444" },
      attribution: { utmCampaign: "retarget" },
      anonymousId: "anon-form-1",
      source: "retarget-email",
    });
    if ("error" in again) throw new Error(again.error);
    expect(again.deduped).toBe(true);
    expect(again.leadId).toBe(first.leadId);
    [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, first.leadId));
    expect(lead.latestSource).toBe("retarget-email");
    expect(lead.firstTouch).toEqual(originalFirstTouch); // first touch immutable
    expect((lead.lastTouch as any).utm.campaign).toBe("retarget");
    expect(lead.campaign).toBe("storm-2026"); // first campaign kept
    expect(lead.anonymousId).toBe("anon-form-1"); // linked at identification
  });
});

describe("form-embed page views feed behavior scoring", () => {
  it("prior page_view events recorded by the forms embed show up in a form lead's score and summary", async () => {
    const anon = `anon-embed-${Date.now()}`;
    // What the forms.js embed records on load across two days.
    await seedVisit(org.id, anon, 4, [{ eventName: "page_view", path: "/pricing" }]);
    await seedVisit(org.id, anon, 1, [{ eventName: "page_view", path: "/pricing" }]);

    const form = await createForm(org.id, {
      name: "Embed form",
      slug: `embed-form-${Date.now()}`,
      status: "published",
      steps: [
        {
          key: "contact",
          title: "Contact",
          fields: [
            { key: "first", type: "text", label: "First", required: true, mapTo: "contact.firstName" },
            { key: "phone", type: "phone", label: "Phone", required: true, mapTo: "contact.phone" },
          ],
        },
      ],
    });
    const row = await getPublicFormRow(org.id, (form as any).slug);
    const result = await captureFormSubmission({
      organizationId: org.id,
      form: row!,
      answers: { first: "Embed", phone: "555-000-6666" },
      attribution: ATTR,
      anonymousId: anon,
    });
    if ("error" in result) throw new Error(result.error);
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, result.leadId));
    expect(lead.anonymousId).toBe(anon);
    expect(lead.scoreReasons.join(" ")).toMatch(/Returned to the website on 2 separate days/);
    expect(lead.scoreReasons.join(" ")).toMatch(/high-intent pages/);

    const summary = await getLeadBehaviorSummary(org.id, result.leadId);
    expect(summary?.linked).toBe(true);
    expect(summary?.behavior.pageViews).toBe(2);
    expect(summary?.behavior.topPages[0]?.path).toBe("/pricing");
  });
});

describe("behavior summary + isolation", () => {
  it("summarizes a linked visitor's activity and scopes it to the org", async () => {
    const anon = `anon-summary-${Date.now()}`;
    await seedVisit(org.id, anon, 5, [
      { eventName: "page_view", path: "/financing" },
      { eventName: "form_started", path: "/quote" },
    ]);
    await seedVisit(org.id, anon, 2, [{ eventName: "page_view", path: "/reviews" }]);
    // Same visitor id in ANOTHER org must not leak into this org's summary.
    await seedVisit(otherOrg.id, anon, 1, [
      { eventName: "page_view", path: "/other-org-page" },
    ]);

    const { leadId } = await captureWidgetLead({
      organizationId: org.id,
      submission: { firstName: "Sum", phone: "555-000-5555", anonymousId: anon },
    });
    const summary = await getLeadBehaviorSummary(org.id, leadId);
    expect(summary?.linked).toBe(true);
    expect(summary?.behavior.pageViews).toBe(2);
    expect(summary?.behavior.activeDays).toBe(2);
    expect(summary?.behavior.abandonedForms).toBe(1);
    expect(summary?.behavior.topPages.map((p) => p.path)).not.toContain("/other-org-page");
    expect(summary?.behavior.highlights.join(" ")).toMatch(/Returned 2×/);

    // Tenant scoping: the other org cannot read this lead's summary at all.
    expect(await getLeadBehaviorSummary(otherOrg.id, leadId)).toBeNull();
  });

  it("returns the empty shape for unlinked leads and unknown ids", async () => {
    expect((await getVisitorBehavior(org.id, null)).pageViews).toBe(0);
    expect((await getVisitorBehavior(org.id, "never-seen")).highlights).toEqual([]);
  });

  it("behavior scoring respects zero weights and stores readable reasons", () => {
    const behavior = {
      pageViews: 5,
      sessions: 2,
      activeDays: 3,
      firstSeenAt: null,
      lastSeenAt: null,
      topPages: [],
      highIntentPages: ["financing"],
      toolsStarted: ["assessment"],
      abandonedForms: 0,
      highlights: [],
    };
    const scored = scoreBehavior(behavior, DEFAULT_LEAD_SCORING);
    expect(scored.points).toBe(
      DEFAULT_LEAD_SCORING.returnVisitBonus +
        DEFAULT_LEAD_SCORING.engagedPagesBonus +
        DEFAULT_LEAD_SCORING.toolUsageBonus,
    );
    expect(scored.reasons).toHaveLength(3);
    const off = scoreBehavior(behavior, {
      ...DEFAULT_LEAD_SCORING,
      returnVisitBonus: 0,
      engagedPagesBonus: 0,
      toolUsageBonus: 0,
    });
    expect(off.points).toBe(0);
    expect(off.reasons).toEqual([]);
  });
});
