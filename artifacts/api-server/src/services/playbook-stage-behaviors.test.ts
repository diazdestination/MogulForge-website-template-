import {
  consentRecordsTable,
  db,
  leadsTable,
  organizationsTable,
  playbookEnrollmentsTable,
  playbooksTable,
  type Playbook,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

import { runEvent } from "./automation";
import * as crm from "./crm";
import {
  applyStageBehaviorToLead,
  autoEnrollLead,
  enrollLeadInPlaybookById,
  executePlaybookStep,
  pauseEnrollmentById,
} from "./playbooks";
import { updateOrgSettings } from "./settings";

let org: { id: string };

beforeAll(async () => {
  const slug = `test-stagebeh-${Date.now()}`;
  const [row] = await db
    .insert(organizationsTable)
    .values({ name: "Stage Behavior Test Org", slug })
    .returning();
  org = row;
});

afterAll(async () => {
  await deleteTestOrgs(org.id);
});

beforeEach(async () => {
  // Reset stage-behavior overrides between tests.
  await updateOrgSettings(org.id, { playbookStageBehaviors: null });
});

async function makeLead() {
  const contact = await crm.createContact(org.id, {
    firstName: "Stage",
    lastName: "Behavior",
    phone: "+15550003333",
    email: "stage-behavior@test.example",
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

async function makePlaybook(
  name: string,
  category: Playbook["category"] = "acquisition",
): Promise<Playbook> {
  const [row] = await db
    .insert(playbooksTable)
    .values({
      organizationId: org.id,
      name,
      category,
      isActive: true,
      enrollmentRules: {},
      steps: [
        { channel: "email" as const, delayMinutes: 5, subject: "Hi", prompt: "say hi" },
      ],
    })
    .returning();
  return row;
}

async function getEnrollments(leadId: string) {
  return db
    .select()
    .from(playbookEnrollmentsTable)
    .where(
      and(
        eq(playbookEnrollmentsTable.organizationId, org.id),
        eq(playbookEnrollmentsTable.leadId, leadId),
      ),
    );
}

async function setLeadStatus(leadId: string, status: string) {
  await db
    .update(leadsTable)
    .set({ status: status as never })
    .where(eq(leadsTable.id, leadId));
}

describe("stage → behavior map", () => {
  it("default: leaving the outreach stages completes the enrollment", async () => {
    const { lead } = await makeLead();
    const enrollment = await autoEnrollLead(org.id, lead.id);
    expect(enrollment?.status).toBe("active");
    await runEvent(org.id, "lead.updated", {
      leadId: lead.id,
      fields: { "lead.status": "inspection_scheduled" },
    });
    const [row] = await getEnrollments(lead.id);
    expect(row.status).toBe("completed");
    expect(row.pauseReason).toContain("inspection_scheduled");
  });

  it("default: outreach stages leave the enrollment running", async () => {
    const { lead } = await makeLead();
    await autoEnrollLead(org.id, lead.id);
    await runEvent(org.id, "lead.updated", {
      leadId: lead.id,
      fields: { "lead.status": "follow_up" },
    });
    const [row] = await getEnrollments(lead.id);
    expect(row.status).toBe("active");
  });

  it("configured continue keeps the sequence running past a normally-terminal stage", async () => {
    await updateOrgSettings(org.id, {
      playbookStageBehaviors: { estimate_sent: { action: "continue" } },
    });
    const { lead } = await makeLead();
    await autoEnrollLead(org.id, lead.id);
    await runEvent(org.id, "lead.updated", {
      leadId: lead.id,
      fields: { "lead.status": "estimate_sent" },
    });
    const [row] = await getEnrollments(lead.id);
    expect(row.status).toBe("active");
  });

  it("configured pause pauses the enrollment (resumable)", async () => {
    await updateOrgSettings(org.id, {
      playbookStageBehaviors: { estimate_sent: { action: "pause" } },
    });
    const { lead } = await makeLead();
    await autoEnrollLead(org.id, lead.id);
    await applyStageBehaviorToLead(org.id, lead.id, "estimate_sent");
    const [row] = await getEnrollments(lead.id);
    expect(row.status).toBe("paused");
  });

  it("configured cancel stops the enrollment", async () => {
    await updateOrgSettings(org.id, {
      playbookStageBehaviors: { estimate_sent: { action: "cancel" } },
    });
    const { lead } = await makeLead();
    await autoEnrollLead(org.id, lead.id);
    await applyStageBehaviorToLead(org.id, lead.id, "estimate_sent");
    const [row] = await getEnrollments(lead.id);
    expect(row.status).toBe("stopped");
  });

  it("configured enroll hands the lead to the target playbook", async () => {
    const target = await makePlaybook("Estimate follow-up", "estimate_follow_up");
    await updateOrgSettings(org.id, {
      playbookStageBehaviors: {
        estimate_sent: { action: "enroll", enrollPlaybookId: target.id },
      },
    });
    const { lead } = await makeLead();
    await autoEnrollLead(org.id, lead.id);
    await runEvent(org.id, "lead.updated", {
      leadId: lead.id,
      fields: { "lead.status": "estimate_sent" },
    });
    const rows = await getEnrollments(lead.id);
    const acquisition = rows.find((r) => r.category === "acquisition");
    const handoff = rows.find((r) => r.playbookId === target.id);
    expect(acquisition?.status).toBe("completed");
    expect(acquisition?.pauseReason).toContain("handed off");
    expect(handoff?.status).toBe("active");
    expect(handoff?.category).toBe("estimate_follow_up");
  });

  it("enroll without a valid target degrades to complete", async () => {
    await updateOrgSettings(org.id, {
      playbookStageBehaviors: {
        estimate_sent: { action: "enroll", enrollPlaybookId: "" },
      },
    });
    const { lead } = await makeLead();
    await autoEnrollLead(org.id, lead.id);
    await applyStageBehaviorToLead(org.id, lead.id, "estimate_sent");
    const rows = await getEnrollments(lead.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("completed");
  });

  it("invalid configured entries fall back to the defaults", async () => {
    await updateOrgSettings(org.id, {
      playbookStageBehaviors: {
        follow_up: { action: "explode" } as never,
      },
    });
    const { lead } = await makeLead();
    await autoEnrollLead(org.id, lead.id);
    await applyStageBehaviorToLead(org.id, lead.id, "follow_up");
    const [row] = await getEnrollments(lead.id);
    expect(row.status).toBe("active"); // default for follow_up is continue
  });
});

describe("playbook categories & concurrency", () => {
  it("allows concurrent live enrollments in different categories", async () => {
    const review = await makePlaybook("Review request", "review_request");
    const { lead } = await makeLead();
    const acq = await autoEnrollLead(org.id, lead.id);
    expect(acq?.status).toBe("active");
    const second = await enrollLeadInPlaybookById(org.id, lead.id, review.id);
    expect(second?.status).toBe("active");
    const live = await db
      .select()
      .from(playbookEnrollmentsTable)
      .where(
        and(
          eq(playbookEnrollmentsTable.leadId, lead.id),
          inArray(playbookEnrollmentsTable.status, ["active", "paused"]),
        ),
      );
    expect(live).toHaveLength(2);
  });

  it("pausing one enrollment leaves the lead's other-category sequences running", async () => {
    const review = await makePlaybook("Review request pause-scope", "review_request");
    const { lead } = await makeLead();
    const acq = await autoEnrollLead(org.id, lead.id);
    const other = await enrollLeadInPlaybookById(org.id, lead.id, review.id);
    expect(acq?.status).toBe("active");
    expect(other?.status).toBe("active");
    const paused = await pauseEnrollmentById(org.id, acq!.id, "paused by test");
    expect(paused?.status).toBe("paused");
    const rows = await getEnrollments(lead.id);
    expect(rows.find((r) => r.id === acq!.id)?.status).toBe("paused");
    expect(rows.find((r) => r.id === other!.id)?.status).toBe("active");
  });

  it("still blocks a second live enrollment in the same category", async () => {
    const other = await makePlaybook("Second acquisition", "acquisition");
    const { lead } = await makeLead();
    const acq = await autoEnrollLead(org.id, lead.id);
    expect(acq?.status).toBe("active");
    const second = await enrollLeadInPlaybookById(org.id, lead.id, other.id);
    expect(second).toBeNull();
  });

  it("auto-enrollment only considers acquisition playbooks", async () => {
    // Deactivate nothing; just add a newer non-acquisition playbook that
    // would otherwise win (playbooks are matched newest-first).
    await makePlaybook("Newest reactivation", "reactivation");
    const { lead } = await makeLead();
    const enrollment = await autoEnrollLead(org.id, lead.id);
    expect(enrollment).not.toBeNull();
    const [pb] = await db
      .select()
      .from(playbooksTable)
      .where(eq(playbooksTable.id, enrollment!.playbookId));
    expect(pb.category).toBe("acquisition");
  });
});

describe("step-execution stage guard", () => {
  it("sends a due step when the stage is configured to continue", { timeout: 60_000 }, async () => {
    await updateOrgSettings(org.id, {
      playbookStageBehaviors: { estimate_sent: { action: "continue" } },
    });
    const { lead } = await makeLead();
    const enrollment = await autoEnrollLead(org.id, lead.id);
    await setLeadStatus(lead.id, "estimate_sent");
    const result = await executePlaybookStep(org.id, {
      enrollmentId: enrollment!.id,
      stepIndex: 0,
    });
    expect(result.status).toBe("success");
  });

  it("pauses a due step when the stage is configured to pause", { timeout: 60_000 }, async () => {
    await updateOrgSettings(org.id, {
      playbookStageBehaviors: { estimate_sent: { action: "pause" } },
    });
    const { lead } = await makeLead();
    const enrollment = await autoEnrollLead(org.id, lead.id);
    await setLeadStatus(lead.id, "estimate_sent");
    const result = await executePlaybookStep(org.id, {
      enrollmentId: enrollment!.id,
      stepIndex: 0,
    });
    expect(result.status).toBe("skipped");
    const [row] = await getEnrollments(lead.id);
    expect(row.status).toBe("paused");
  });

  it("non-acquisition sequences keep running regardless of stage", { timeout: 60_000 }, async () => {
    const review = await makePlaybook("Review request 2", "review_request");
    const { lead } = await makeLead();
    const enrollment = await enrollLeadInPlaybookById(org.id, lead.id, review.id);
    await setLeadStatus(lead.id, "completed");
    const result = await executePlaybookStep(org.id, {
      enrollmentId: enrollment!.id,
      stepIndex: 0,
    });
    expect(result.status).toBe("success");
  });
});
