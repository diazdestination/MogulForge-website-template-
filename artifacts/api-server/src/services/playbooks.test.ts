import {
  consentRecordsTable,
  db,
  organizationsTable,
  playbookEnrollmentsTable,
  playbooksTable,
  scheduledActionsTable,
  activitiesTable,
  DEFAULT_SENDING_HOURS,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { updateOrgSettings } from "./settings";

import { runEvent } from "./automation";
import * as crm from "./crm";
import {
  autoEnrollLead,
  DEFAULT_PLAYBOOK_SEED_KEY,
  ensureDefaultPlaybook,
  executePlaybookStep,
  getLeadEnrollment,
  resumeEnrollment,
  skipEnrollmentStep,
  stopEnrollmentsForLead,
} from "./playbooks";

let org: { id: string };

beforeAll(async () => {
  const slug = `test-playbook-${Date.now()}`;
  const [row] = await db
    .insert(organizationsTable)
    .values({ name: "Playbook Test Org", slug })
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

async function makeLead(opts?: { smsGranted?: boolean; email?: string | null }) {
  const contact = await crm.createContact(org.id, {
    firstName: "Play",
    lastName: "Book",
    phone: "+15550002222",
    email: opts?.email === null ? undefined : (opts?.email ?? "playbook@test.example"),
  });
  await db.insert(consentRecordsTable).values({
    organizationId: org.id,
    contactId: contact.id,
    channel: "sms",
    granted: opts?.smsGranted ?? true,
    disclosureVersion: "v1",
  });
  const lead = await crm.createLead(org.id, { contactId: contact.id });
  return { contact, lead: lead! };
}

describe("closer engine playbooks", () => {
  it("seeds the default playbook exactly once (idempotent + concurrent)", async () => {
    await Promise.all([
      ensureDefaultPlaybook(org.id),
      ensureDefaultPlaybook(org.id),
      ensureDefaultPlaybook(org.id),
    ]);
    await ensureDefaultPlaybook(org.id);
    const rows = await db
      .select()
      .from(playbooksTable)
      .where(
        and(
          eq(playbooksTable.organizationId, org.id),
          eq(playbooksTable.seedKey, DEFAULT_PLAYBOOK_SEED_KEY),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].steps.length).toBeGreaterThan(0);
  });

  it("auto-enrolls a new lead and schedules the first step", async () => {
    const { lead } = await makeLead();
    const enrollment = await autoEnrollLead(org.id, lead.id);
    expect(enrollment).not.toBeNull();
    expect(enrollment!.status).toBe("active");
    expect(enrollment!.currentStep).toBe(0);

    const scheduled = await db
      .select()
      .from(scheduledActionsTable)
      .where(eq(scheduledActionsTable.organizationId, org.id));
    const mine = scheduled.filter(
      (s) =>
        s.action.type === "playbook_step" &&
        (s.action.params as { enrollmentId?: string }).enrollmentId ===
          enrollment!.id,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0].status).toBe("pending");

    // Second enroll attempt is a no-op (one live enrollment per lead).
    const again = await autoEnrollLead(org.id, lead.id);
    expect(again).toBeNull();
  });

  it("executes a step: sends, logs a timeline touch, and schedules the next step", async () => {
    const { lead } = await makeLead();
    const enrollment = await autoEnrollLead(org.id, lead.id);
    const result = await executePlaybookStep(org.id, {
      enrollmentId: enrollment!.id,
      stepIndex: 0,
    });
    expect(result.status).toBe("success");

    const [after] = await db
      .select()
      .from(playbookEnrollmentsTable)
      .where(eq(playbookEnrollmentsTable.id, enrollment!.id));
    expect(after.currentStep).toBe(1);
    expect(after.status).toBe("active");
    expect(after.history.some((h) => h.kind === "sent")).toBe(true);

    const touches = await db
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.leadId, lead.id),
          eq(activitiesTable.type, "playbook_touch_sent"),
        ),
      );
    expect(touches).toHaveLength(1);

    // Stale re-run of the same step is a no-op.
    const rerun = await executePlaybookStep(org.id, {
      enrollmentId: enrollment!.id,
      stepIndex: 0,
    });
    expect(rerun.status).toBe("skipped");
  });

  it("skips an SMS step without consent but still advances", async () => {
    const { lead } = await makeLead({ smsGranted: false });
    const enrollment = await autoEnrollLead(org.id, lead.id);
    // Step 1 of the default playbook is SMS.
    await db
      .update(playbookEnrollmentsTable)
      .set({ currentStep: 1 })
      .where(eq(playbookEnrollmentsTable.id, enrollment!.id));
    const result = await executePlaybookStep(org.id, {
      enrollmentId: enrollment!.id,
      stepIndex: 1,
    });
    expect(result.status).toBe("skipped");
    expect(result.detail).toContain("consent");
    const [after] = await db
      .select()
      .from(playbookEnrollmentsTable)
      .where(eq(playbookEnrollmentsTable.id, enrollment!.id));
    expect(after.currentStep).toBe(2);
  });

  it("completes the enrollment when the lead leaves the outreach stages", async () => {
    const { lead } = await makeLead();
    const enrollment = await autoEnrollLead(org.id, lead.id);
    await crm.updateLead(org.id, lead.id, { status: "won" });
    const result = await executePlaybookStep(org.id, {
      enrollmentId: enrollment!.id,
      stepIndex: 0,
    });
    expect(result.status).toBe("skipped");
    const [after] = await db
      .select()
      .from(playbookEnrollmentsTable)
      .where(eq(playbookEnrollmentsTable.id, enrollment!.id));
    expect(after.status).toBe("completed");
  });

  it("auto-enrolls via the lead.created event and stops on appointment.booked", async () => {
    const { lead } = await makeLead();
    await runEvent(org.id, "lead.created", { leadId: lead.id });
    let enrollment = await getLeadEnrollment(org.id, lead.id);
    expect(enrollment?.status).toBe("active");

    await runEvent(org.id, "appointment.booked", { leadId: lead.id });
    enrollment = await getLeadEnrollment(org.id, lead.id);
    expect(enrollment?.status).toBe("completed");
    expect(enrollment?.pauseReason).toContain("booked");
  });

  it("stops enrollment when a lead.updated event moves the lead past outreach", async () => {
    const { lead } = await makeLead();
    await autoEnrollLead(org.id, lead.id);
    await runEvent(org.id, "lead.updated", {
      leadId: lead.id,
      fields: { "lead.status": "inspection_scheduled" },
    });
    const enrollment = await getLeadEnrollment(org.id, lead.id);
    expect(enrollment?.status).toBe("completed");
  });

  it("never double-sends a step under concurrent/retried execution", async () => {
    const { lead } = await makeLead();
    const enrollment = await autoEnrollLead(org.id, lead.id);
    const results = await Promise.all([
      executePlaybookStep(org.id, { enrollmentId: enrollment!.id, stepIndex: 0 }),
      executePlaybookStep(org.id, { enrollmentId: enrollment!.id, stepIndex: 0 }),
      executePlaybookStep(org.id, { enrollmentId: enrollment!.id, stepIndex: 0 }),
    ]);
    expect(results.filter((r) => r.status === "success")).toHaveLength(1);

    const touches = await db
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.leadId, lead.id),
          eq(activitiesTable.type, "playbook_touch_sent"),
        ),
      );
    expect(touches).toHaveLength(1);

    // Exactly one follow-up step was queued despite the concurrent claims.
    const scheduled = await db
      .select()
      .from(scheduledActionsTable)
      .where(eq(scheduledActionsTable.organizationId, org.id));
    const nextSteps = scheduled.filter(
      (s) =>
        s.action.type === "playbook_step" &&
        (s.action.params as { enrollmentId?: string; stepIndex?: number })
          .enrollmentId === enrollment!.id &&
        (s.action.params as { stepIndex?: number }).stepIndex === 1,
    );
    expect(nextSteps).toHaveLength(1);
  });

  it("pause / resume / skip controls work", async () => {
    const { lead } = await makeLead();
    const enrollment = await autoEnrollLead(org.id, lead.id);

    await stopEnrollmentsForLead(org.id, lead.id, "lead replied", "paused");
    let [row] = await db
      .select()
      .from(playbookEnrollmentsTable)
      .where(eq(playbookEnrollmentsTable.id, enrollment!.id));
    expect(row.status).toBe("paused");
    // Paused enrollments don't execute.
    const paused = await executePlaybookStep(org.id, {
      enrollmentId: enrollment!.id,
      stepIndex: 0,
    });
    expect(paused.status).toBe("skipped");

    const resumed = await resumeEnrollment(org.id, enrollment!.id);
    expect(resumed?.status).toBe("active");

    const skipped = await skipEnrollmentStep(org.id, enrollment!.id);
    expect(skipped?.currentStep).toBe(1);
    expect(skipped?.status).toBe("active");
  });
});
