import {
  consentRecordsTable,
  db,
  organizationsTable,
  playbookDecisionsTable,
  playbookTouchesTable,
  playbooksTable,
  type Playbook,
  DEFAULT_SENDING_HOURS,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { updateOrgSettings } from "./settings";

import { runEvent } from "./automation";
import * as crm from "./crm";
import {
  adjustSendTime,
  chooseVariant,
  getConversionInsights,
  MIN_VARIANT_SAMPLE,
  MIN_WINDOW_SAMPLE,
  recordLeadOutcome,
  recordTouch,
} from "./playbook-learning";
import { autoEnrollLead, executePlaybookStep } from "./playbooks";

let org: { id: string };

beforeAll(async () => {
  const slug = `test-pblearn-${Date.now()}`;
  const [row] = await db
    .insert(organizationsTable)
    .values({ name: "Playbook Learning Test Org", slug })
    .returning();
  org = row;
  // These suites run at any wall-clock time: disable the (default-on)
  // sending window so step execution is deterministic.
  await updateOrgSettings(org.id, {
    sendingHours: { ...DEFAULT_SENDING_HOURS, quietHoursEnabled: false },
  });
});

afterAll(async () => {
  await deleteTestOrgs(org.id);
});

async function makeLead() {
  const contact = await crm.createContact(org.id, {
    firstName: "Learn",
    lastName: "Loop",
    phone: "+15550003333",
    email: "learn@test.example",
  });
  await db.insert(consentRecordsTable).values({
    organizationId: org.id,
    contactId: contact.id,
    channel: "sms",
    granted: true,
    disclosureVersion: "v1",
  });
  const lead = await crm.createLead(org.id, { contactId: contact.id });
  return { contact, lead: lead! };
}

async function makeVariantPlaybook(pinned?: string): Promise<Playbook> {
  const [pb] = await db
    .insert(playbooksTable)
    .values({
      organizationId: org.id,
      name: `Variant test ${Date.now()}-${Math.random()}`,
      isActive: false, // never auto-matched; used directly in tests
      enrollmentRules: {},
      steps: [
        {
          channel: "email",
          delayMinutes: 5,
          subject: "A subject",
          prompt: "variant A direction",
          variants: [{ key: "B", prompt: "variant B direction", subject: "B subject" }],
          ...(pinned ? { pinnedVariant: pinned } : {}),
        },
      ],
    })
    .returning();
  return pb;
}

function seedTouch(opts: {
  playbookId: string;
  enrollmentId: string;
  leadId: string;
  variantKey: string;
  replied?: boolean;
  hour?: number;
}) {
  return db.insert(playbookTouchesTable).values({
    organizationId: org.id,
    playbookId: opts.playbookId,
    enrollmentId: opts.enrollmentId,
    leadId: opts.leadId,
    stepIndex: 0,
    variantKey: opts.variantKey,
    channel: "email",
    provider: "mock-email",
    sentHourUtc: opts.hour ?? 10,
    repliedAt: opts.replied ? new Date() : null,
  });
}

describe("closer engine learning loop", () => {
  it("records a touch on send and attributes reply/booking/win outcomes", async () => {
    const { lead } = await makeLead();
    const enrollment = await autoEnrollLead(org.id, lead.id);
    const result = await executePlaybookStep(org.id, {
      enrollmentId: enrollment!.id,
      stepIndex: 0,
    });
    expect(result.status).toBe("success");

    let [touch] = await db
      .select()
      .from(playbookTouchesTable)
      .where(eq(playbookTouchesTable.leadId, lead.id));
    expect(touch).toBeDefined();
    expect(touch.variantKey).toBe("default");
    expect(touch.repliedAt).toBeNull();

    await recordLeadOutcome(org.id, lead.id, "replied");
    await recordLeadOutcome(org.id, lead.id, "booked");
    await recordLeadOutcome(org.id, lead.id, "won");
    // Second reply must not overwrite the first attribution timestamp.
    const [after1] = await db
      .select()
      .from(playbookTouchesTable)
      .where(eq(playbookTouchesTable.leadId, lead.id));
    await recordLeadOutcome(org.id, lead.id, "replied");
    [touch] = await db
      .select()
      .from(playbookTouchesTable)
      .where(eq(playbookTouchesTable.leadId, lead.id));
    expect(touch.repliedAt).toEqual(after1.repliedAt);
    expect(touch.bookedAt).not.toBeNull();
    expect(touch.finalOutcome).toBe("won");
  });

  it("event hooks attribute outcomes (booked via appointment, won via stage change)", async () => {
    const { lead } = await makeLead();
    const enrollment = await autoEnrollLead(org.id, lead.id);
    await executePlaybookStep(org.id, { enrollmentId: enrollment!.id, stepIndex: 0 });

    await runEvent(org.id, "appointment.booked", { leadId: lead.id });
    await runEvent(org.id, "lead.updated", {
      leadId: lead.id,
      fields: { "lead.status": "won" },
    });

    const [touch] = await db
      .select()
      .from(playbookTouchesTable)
      .where(eq(playbookTouchesTable.leadId, lead.id));
    expect(touch.bookedAt).not.toBeNull();
    expect(touch.finalOutcome).toBe("won");
  });

  it("explores under-sampled variants evenly, honors pins, exploits winners with a logged explanation", async () => {
    const { lead } = await makeLead();
    const enrollment = await autoEnrollLead(org.id, lead.id);

    // Pinned: always the pinned variant, regardless of data.
    const pinnedPb = await makeVariantPlaybook("B");
    const pinChoice = await chooseVariant(org.id, pinnedPb, 0, pinnedPb.steps[0]);
    expect(pinChoice.key).toBe("B");

    const pb = await makeVariantPlaybook();
    // No data: both under-sampled → explore (either is fine, no decision log).
    const explore = await chooseVariant(org.id, pb, 0, pb.steps[0]);
    expect(["default", "B"]).toContain(explore.key);

    // Seed both variants past MIN_VARIANT_SAMPLE; B wins decisively.
    for (let i = 0; i < MIN_VARIANT_SAMPLE; i++) {
      await seedTouch({
        playbookId: pb.id, enrollmentId: enrollment!.id, leadId: lead.id,
        variantKey: "default", replied: false,
      });
      await seedTouch({
        playbookId: pb.id, enrollmentId: enrollment!.id, leadId: lead.id,
        variantKey: "B", replied: true,
      });
    }
    // Thompson sampling is stochastic; with a 100% vs 0% split B should
    // dominate overwhelmingly across a handful of draws.
    const picks = await Promise.all(
      Array.from({ length: 5 }, () => chooseVariant(org.id, pb, 0, pb.steps[0])),
    );
    expect(picks.filter((p) => p.key === "B").length).toBeGreaterThanOrEqual(4);

    const decisions = await db
      .select()
      .from(playbookDecisionsTable)
      .where(
        and(
          eq(playbookDecisionsTable.organizationId, org.id),
          eq(playbookDecisionsTable.kind, "variant_allocation"),
        ),
      );
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions[0].explanation).toMatch(/variant/i);
  });

  it("shifts send windows only with enough data, never earlier and never >12h", async () => {
    // Not enough replies yet → no adjustment.
    const base = new Date("2026-08-03T14:00:00Z");
    const before = await adjustSendTime(org.id, base);
    expect(before.adjusted).toBe(false);

    const { lead } = await makeLead();
    const enrollment = await autoEnrollLead(org.id, lead.id);
    const pb = await makeVariantPlaybook();
    // Hour 18 replies great, hour 14 poorly — both with enough volume.
    for (let i = 0; i < MIN_WINDOW_SAMPLE; i++) {
      await seedTouch({
        playbookId: pb.id, enrollmentId: enrollment!.id, leadId: lead.id,
        variantKey: "default", hour: 18, replied: true,
      });
      await seedTouch({
        playbookId: pb.id, enrollmentId: enrollment!.id, leadId: lead.id,
        variantKey: "default", hour: 14, replied: i === 0,
      });
    }
    const after = await adjustSendTime(org.id, base);
    expect(after.adjusted).toBe(true);
    expect(after.runAt.getUTCHours()).toBe(18);
    expect(after.runAt.getTime()).toBeGreaterThan(base.getTime());
    expect(after.runAt.getTime() - base.getTime()).toBeLessThanOrEqual(12 * 3_600_000);

    const decisions = await db
      .select()
      .from(playbookDecisionsTable)
      .where(
        and(
          eq(playbookDecisionsTable.organizationId, org.id),
          eq(playbookDecisionsTable.kind, "send_window"),
        ),
      );
    expect(decisions.length).toBeGreaterThan(0);
  });

  it("conversion insights aggregate the funnel and report engine lift", async () => {
    const insights = await getConversionInsights(org.id);
    expect(insights.totalTouches).toBeGreaterThan(0);
    expect(insights.funnel.length).toBeGreaterThan(0);
    const row = insights.funnel[0];
    expect(row).toHaveProperty("playbookName");
    expect(row).toHaveProperty("variantKey");
    // Winners beat the pooled baseline in this seeded data set.
    expect(insights.engineReplyRate).toBeGreaterThanOrEqual(insights.baselineReplyRate);
    expect(insights.decisions.length).toBeGreaterThan(0);
  });
});
