import {
  conversationsTable,
  db,
  leadsTable,
  leadTagsTable,
  organizationsTable,
  projectsTable,
  tagsTable,
  usersTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

import { captureAssessment, scoreSubmission } from "./assessment";
import * as crm from "./crm";

let orgA: { id: string };
let orgB: { id: string };

async function makeOrg(slug: string) {
  await db.delete(organizationsTable).where(eq(organizationsTable.slug, slug));
  const [org] = await db
    .insert(organizationsTable)
    .values({ name: `Test Org ${slug}`, slug })
    .returning();
  return org;
}

beforeAll(async () => {
  orgA = await makeOrg(`test-a-${Date.now()}`);
  orgB = await makeOrg(`test-b-${Date.now()}`);
});

/** Orgs created inside individual tests; cleaned up alongside the main orgs. */
const extraOrgIds: string[] = [];

afterAll(async () => {
  await deleteTestOrgs(orgA.id, orgB.id, ...extraOrgIds);
});

describe("tenant isolation", () => {
  it("contacts created in org A are invisible to org B", async () => {
    const contact = await crm.createContact(orgA.id, {
      firstName: "Isolated",
      lastName: "Tester",
    });
    expect(await crm.getContact(orgA.id, contact.id)).not.toBeNull();
    expect(await crm.getContact(orgB.id, contact.id)).toBeNull();

    const listB = await crm.listContacts(orgB.id);
    expect(listB.find((c) => c.id === contact.id)).toBeUndefined();
  });

  it("org B cannot update or delete org A contacts", async () => {
    const contact = await crm.createContact(orgA.id, { firstName: "Locked" });
    expect(
      await crm.updateContact(orgB.id, contact.id, { firstName: "Hacked" }),
    ).toBeNull();
    expect(await crm.deleteContact(orgB.id, contact.id)).toBe(false);
    const still = await crm.getContact(orgA.id, contact.id);
    expect(still?.firstName).toBe("Locked");
  });

  it("leads cannot reference a contact from another org", async () => {
    const foreignContact = await crm.createContact(orgB.id, {
      firstName: "Foreign",
    });
    const lead = await crm.createLead(orgA.id, {
      contactId: foreignContact.id,
    });
    expect(lead).toBeNull();
  });

  it("lead lists are org-scoped", async () => {
    const contact = await crm.createContact(orgA.id, { firstName: "Leady" });
    const lead = await crm.createLead(orgA.id, { contactId: contact.id });
    expect(lead).not.toBeNull();
    const leadsB = await crm.listLeads(orgB.id);
    expect(leadsB.find((l) => l.id === lead!.id)).toBeUndefined();
    expect(await crm.getLead(orgB.id, lead!.id)).toBeNull();
  });
});

async function makeLead(orgId: string, firstName: string) {
  const contact = await crm.createContact(orgId, { firstName });
  const lead = await crm.createLead(orgId, { contactId: contact.id });
  expect(lead).not.toBeNull();
  return lead!;
}

async function makeUser(orgId: string) {
  const [user] = await db
    .insert(usersTable)
    .values({ organizationId: orgId })
    .returning();
  return user;
}

async function makeTag(orgId: string, name: string) {
  const [tag] = await db
    .insert(tagsTable)
    .values({ organizationId: orgId, name })
    .returning();
  return tag;
}

describe("bulk lead actions tenant isolation", () => {
  it("bulkUpdateLeads only touches leads in the caller's org", async () => {
    const leadA = await makeLead(orgA.id, "BulkA");
    const leadB = await makeLead(orgB.id, "BulkB");

    const updated = await crm.bulkUpdateLeads(orgA.id, [leadA.id, leadB.id], {
      status: "ai_qualified",
    });
    expect(updated).toEqual([leadA.id]);

    const stillB = await crm.getLead(orgB.id, leadB.id);
    expect(stillB!.status).toBe(leadB.status);
    const changedA = await crm.getLead(orgA.id, leadA.id);
    expect(changedA!.status).toBe("ai_qualified");
  });

  it("bulkUpdateLeads rejects assigning a user from another org", async () => {
    const leadA = await makeLead(orgA.id, "AssignA");
    const foreignUser = await makeUser(orgB.id);

    const result = await crm.bulkUpdateLeads(orgA.id, [leadA.id], {
      assignedUserId: foreignUser.id,
    });
    expect(result).toBeNull();
    const lead = await crm.getLead(orgA.id, leadA.id);
    expect(lead!.assignedUserId).toBeNull();
  });

  it("bulkUpdateLeads allows assigning a same-org user", async () => {
    const leadA = await makeLead(orgA.id, "AssignOk");
    const user = await makeUser(orgA.id);
    const result = await crm.bulkUpdateLeads(orgA.id, [leadA.id], {
      assignedUserId: user.id,
    });
    expect(result).toEqual([leadA.id]);
  });

  it("bulkTagLeads rejects a tag from another org", async () => {
    const leadA = await makeLead(orgA.id, "TagVictim");
    const foreignTag = await makeTag(orgB.id, `foreign-${Date.now()}`);

    const result = await crm.bulkTagLeads(orgA.id, [leadA.id], foreignTag.id);
    expect(result).toBeNull();

    const rows = await db
      .select()
      .from(leadTagsTable)
      .where(eq(leadTagsTable.leadId, leadA.id));
    expect(rows).toHaveLength(0);
  });

  it("bulkTagLeads only tags leads owned by the caller's org", async () => {
    const leadA = await makeLead(orgA.id, "TagMine");
    const leadB = await makeLead(orgB.id, "TagTheirs");
    const tagA = await makeTag(orgA.id, `mine-${Date.now()}`);

    const result = await crm.bulkTagLeads(orgA.id, [leadA.id, leadB.id], tagA.id);
    expect(result).toEqual([leadA.id]);

    const rows = await db
      .select()
      .from(leadTagsTable)
      .where(
        and(
          eq(leadTagsTable.tagId, tagA.id),
          inArray(leadTagsTable.leadId, [leadA.id, leadB.id]),
        ),
      );
    expect(rows.map((r) => r.leadId)).toEqual([leadA.id]);
  });

  it("bulkTagLeads returns empty when no requested leads belong to the org", async () => {
    const leadB = await makeLead(orgB.id, "AllForeign");
    const tagA = await makeTag(orgA.id, `empty-${Date.now()}`);
    const result = await crm.bulkTagLeads(orgA.id, [leadB.id], tagA.id);
    expect(result).toEqual([]);
    const rows = await db
      .select()
      .from(leadTagsTable)
      .where(eq(leadTagsTable.leadId, leadB.id));
    expect(rows).toHaveLength(0);
  });
});

describe("duplicate detection tenant isolation", () => {
  it("never groups leads across organizations even with identical contact info", async () => {
    const stamp = Date.now();
    const email = `dupe-${stamp}@example.com`;
    const phone = "+15125557777";

    const mk = async (orgId: string, n: number) => {
      const contact = await crm.createContact(orgId, {
        firstName: `Dupe${n}`,
        email,
        phone,
      });
      const lead = await crm.createLead(orgId, { contactId: contact.id });
      return lead!.id;
    };
    // Two matching leads in org A, one matching lead in org B.
    const a1 = await mk(orgA.id, 1);
    const a2 = await mk(orgA.id, 2);
    const b1 = await mk(orgB.id, 3);

    const groupsA = await crm.findDuplicateLeadGroups(orgA.id);
    const idsA = new Set(groupsA.flatMap((g) => g.leadIds));
    expect(idsA.has(a1)).toBe(true);
    expect(idsA.has(a2)).toBe(true);
    expect(idsA.has(b1)).toBe(false);

    // Org B has only one lead with this contact info — no group at all.
    const groupsB = await crm.findDuplicateLeadGroups(orgB.id);
    const idsB = new Set(groupsB.flatMap((g) => g.leadIds));
    expect(idsB.has(a1)).toBe(false);
    expect(idsB.has(a2)).toBe(false);
    expect(idsB.has(b1)).toBe(false);
  });
});

async function makeAppointment(orgId: string, leadId: string) {
  const appt = await crm.createAppointment(orgId, {
    leadId,
    type: "other",
    scheduledStart: new Date(Date.now() + 24 * 60 * 60 * 1000),
    status: "scheduled",
  });
  expect(appt).not.toBeNull();
  expect(appt).not.toBe("conflict");
  expect(appt).not.toBe("past_start");
  return appt as Exclude<typeof appt, null | "conflict" | "past_start">;
}

async function makeCrmTask(orgId: string, leadId: string, title: string) {
  const task = await crm.createTask(orgId, { leadId, title });
  expect(task).not.toBeNull();
  return task!;
}

async function makeEstimate(orgId: string, leadId: string, title: string) {
  const estimate = await crm.createEstimate(orgId, { leadId, title });
  expect(estimate).not.toBeNull();
  return estimate!;
}

async function makeProject(orgId: string, leadId: string, name: string) {
  const project = await crm.createProject(orgId, { leadId, name });
  expect(project).not.toBeNull();
  expect(typeof project).toBe("object");
  return project as typeof projectsTable.$inferSelect;
}

async function makeConversation(orgId: string, leadId: string) {
  const [row] = await db
    .insert(conversationsTable)
    .values({ organizationId: orgId, leadId })
    .returning();
  return row;
}

async function getProjectRow(id: string) {
  const [row] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, id));
  return row;
}

async function getConversationRow(id: string) {
  const [row] = await db
    .select()
    .from(conversationsTable)
    .where(eq(conversationsTable.id, id));
  return row;
}

describe("lead merge tenant isolation", () => {
  it("refuses to merge when the source lead belongs to another org", async () => {
    const survivorA = await makeLead(orgA.id, "MergeSurvivorA");
    const sourceB = await makeLead(orgB.id, "MergeSourceB");
    const actor = await makeUser(orgA.id);

    // Give the foreign source lead child rows that must never move.
    const activity = await crm.createActivity(orgB.id, {
      leadId: sourceB.id,
      contactId: sourceB.contactId,
      type: "note",
      title: "Foreign note",
    });
    const tagB = await makeTag(orgB.id, `merge-b-${Date.now()}`);
    await crm.bulkTagLeads(orgB.id, [sourceB.id], tagB.id);
    const appointment = await makeAppointment(orgB.id, sourceB.id);
    const task = await makeCrmTask(orgB.id, sourceB.id, "Foreign task");
    const estimate = await makeEstimate(orgB.id, sourceB.id, "Foreign estimate");
    const project = await makeProject(orgB.id, sourceB.id, "Foreign project");
    const conversation = await makeConversation(orgB.id, sourceB.id);

    const result = await crm.mergeLeads(orgA.id, survivorA.id, sourceB.id, actor.id);
    expect(result).toEqual({ ok: false, error: "not_found" });

    // Appointments, tasks, and estimates stayed on the foreign source lead.
    const apptsB = await crm.listAppointments(orgB.id, sourceB.id);
    expect(apptsB.some((a) => a.id === appointment.id)).toBe(true);
    const apptsSurvivor = await crm.listAppointments(orgA.id, survivorA.id);
    expect(apptsSurvivor.some((a) => a.id === appointment.id)).toBe(false);

    const tasksB = await crm.listTasks(orgB.id);
    const taskRow = tasksB.find((t) => t.id === task.id);
    expect(taskRow?.leadId).toBe(sourceB.id);
    expect(taskRow?.organizationId).toBe(orgB.id);

    const estimatesB = await crm.listEstimates(orgB.id, { leadId: sourceB.id });
    expect(estimatesB.some((e) => e.id === estimate.id)).toBe(true);
    const estimatesSurvivor = await crm.listEstimates(orgA.id, {
      leadId: survivorA.id,
    });
    expect(estimatesSurvivor.some((e) => e.id === estimate.id)).toBe(false);

    // Projects and conversations stayed on the foreign source lead too.
    const projectRow = await getProjectRow(project.id);
    expect(projectRow.leadId).toBe(sourceB.id);
    expect(projectRow.organizationId).toBe(orgB.id);
    const conversationRow = await getConversationRow(conversation.id);
    expect(conversationRow.leadId).toBe(sourceB.id);
    expect(conversationRow.organizationId).toBe(orgB.id);

    // Foreign child rows stayed put.
    const activitiesB = await crm.listLeadActivities(orgB.id, sourceB.id);
    expect(activitiesB.some((a) => a.id === activity.id)).toBe(true);
    const survivorActivities = await crm.listLeadActivities(orgA.id, survivorA.id);
    expect(survivorActivities.some((a) => a.id === activity.id)).toBe(false);
    const tagRows = await db
      .select()
      .from(leadTagsTable)
      .where(eq(leadTagsTable.tagId, tagB.id));
    expect(tagRows.map((r) => r.leadId)).toEqual([sourceB.id]);

    // Foreign source lead was not marked lost.
    const sourceStill = await crm.getLead(orgB.id, sourceB.id);
    expect(sourceStill!.status).toBe(sourceB.status);
  });

  it("refuses to merge when the survivor lead belongs to another org", async () => {
    const survivorB = await makeLead(orgB.id, "MergeSurvivorB");
    const sourceA = await makeLead(orgA.id, "MergeSourceA");
    const actor = await makeUser(orgA.id);

    const activity = await crm.createActivity(orgA.id, {
      leadId: sourceA.id,
      contactId: sourceA.contactId,
      type: "note",
      title: "Home note",
    });
    const appointment = await makeAppointment(orgA.id, sourceA.id);
    const task = await makeCrmTask(orgA.id, sourceA.id, "Home task");
    const estimate = await makeEstimate(orgA.id, sourceA.id, "Home estimate");
    const project = await makeProject(orgA.id, sourceA.id, "Home project");
    const conversation = await makeConversation(orgA.id, sourceA.id);

    const result = await crm.mergeLeads(orgA.id, survivorB.id, sourceA.id, actor.id);
    expect(result).toEqual({ ok: false, error: "not_found" });

    // Source child rows never landed on the foreign survivor.
    const apptsForeign = await crm.listAppointments(orgB.id, survivorB.id);
    expect(apptsForeign.some((a) => a.id === appointment.id)).toBe(false);
    const apptsSource = await crm.listAppointments(orgA.id, sourceA.id);
    expect(apptsSource.some((a) => a.id === appointment.id)).toBe(true);

    const tasksA = await crm.listTasks(orgA.id);
    expect(tasksA.find((t) => t.id === task.id)?.leadId).toBe(sourceA.id);

    const estimatesSource = await crm.listEstimates(orgA.id, { leadId: sourceA.id });
    expect(estimatesSource.some((e) => e.id === estimate.id)).toBe(true);
    const estimatesForeign = await crm.listEstimates(orgB.id, {
      leadId: survivorB.id,
    });
    expect(estimatesForeign.some((e) => e.id === estimate.id)).toBe(false);

    // Projects and conversations never landed on the foreign survivor either.
    const projectRow = await getProjectRow(project.id);
    expect(projectRow.leadId).toBe(sourceA.id);
    expect(projectRow.organizationId).toBe(orgA.id);
    const conversationRow = await getConversationRow(conversation.id);
    expect(conversationRow.leadId).toBe(sourceA.id);
    expect(conversationRow.organizationId).toBe(orgA.id);

    // Source lead untouched: activities intact, not marked lost.
    const activitiesA = await crm.listLeadActivities(orgA.id, sourceA.id);
    expect(activitiesA.some((a) => a.id === activity.id)).toBe(true);
    const foreignSurvivorActivities = await crm.listLeadActivities(
      orgB.id,
      survivorB.id,
    );
    expect(foreignSurvivorActivities).toHaveLength(0);
    const sourceStill = await crm.getLead(orgA.id, sourceA.id);
    expect(sourceStill!.status).toBe(sourceA.status);
  });

  it("refuses to merge two leads that both belong to another org", async () => {
    const survivorB = await makeLead(orgB.id, "BothForeign1");
    const sourceB = await makeLead(orgB.id, "BothForeign2");
    const actor = await makeUser(orgA.id);

    const result = await crm.mergeLeads(orgA.id, survivorB.id, sourceB.id, actor.id);
    expect(result).toEqual({ ok: false, error: "not_found" });

    // Neither foreign lead changed state.
    expect((await crm.getLead(orgB.id, survivorB.id))!.status).toBe(survivorB.status);
    expect((await crm.getLead(orgB.id, sourceB.id))!.status).toBe(sourceB.status);
  });

  it("rejects merging a lead into itself", async () => {
    const lead = await makeLead(orgA.id, "SelfMerge");
    const actor = await makeUser(orgA.id);
    const result = await crm.mergeLeads(orgA.id, lead.id, lead.id, actor.id);
    expect(result).toEqual({ ok: false, error: "same_lead" });
  });

  it("merges same-org leads, moving only same-org child rows", async () => {
    const survivor = await makeLead(orgA.id, "MergeKeep");
    const source = await makeLead(orgA.id, "MergeGone");
    const actor = await makeUser(orgA.id);

    const activity = await crm.createActivity(orgA.id, {
      leadId: source.id,
      contactId: source.contactId,
      type: "note",
      title: "Move me",
    });
    const tag = await makeTag(orgA.id, `merge-a-${Date.now()}`);
    await crm.bulkTagLeads(orgA.id, [source.id], tag.id);
    const appointment = await makeAppointment(orgA.id, source.id);
    const task = await makeCrmTask(orgA.id, source.id, "Move my task");
    const estimate = await makeEstimate(orgA.id, source.id, "Move my estimate");
    const project = await makeProject(orgA.id, source.id, "Move my project");
    const conversation = await makeConversation(orgA.id, source.id);
    // A same-info lead in the other org must be untouched by the merge.
    const bystander = await makeLead(orgB.id, "MergeBystander");
    const bystanderAppt = await makeAppointment(orgB.id, bystander.id);
    const bystanderTask = await makeCrmTask(orgB.id, bystander.id, "Stay put");
    const bystanderEstimate = await makeEstimate(orgB.id, bystander.id, "Stay put");
    const bystanderProject = await makeProject(orgB.id, bystander.id, "Stay put");
    const bystanderConversation = await makeConversation(orgB.id, bystander.id);

    const result = await crm.mergeLeads(orgA.id, survivor.id, source.id, actor.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.movedActivities).toBe(1);
    expect(result.movedTags).toBe(1);
    expect(result.movedAppointments).toBe(1);
    expect(result.movedTasks).toBe(1);
    expect(result.movedEstimates).toBe(1);
    expect(result.movedProjects).toBe(1);
    expect(result.movedConversations).toBe(1);

    // The moved rows now sit on the survivor and stayed in org A.
    const survivorAppts = await crm.listAppointments(orgA.id, survivor.id);
    const movedAppt = survivorAppts.find((a) => a.id === appointment.id);
    expect(movedAppt?.organizationId).toBe(orgA.id);
    const survivorTasks = (await crm.listTasks(orgA.id)).filter(
      (t) => t.leadId === survivor.id,
    );
    const movedTask = survivorTasks.find((t) => t.id === task.id);
    expect(movedTask?.organizationId).toBe(orgA.id);
    const survivorEstimates = await crm.listEstimates(orgA.id, {
      leadId: survivor.id,
    });
    const movedEstimate = survivorEstimates.find((e) => e.id === estimate.id);
    expect(movedEstimate?.organizationId).toBe(orgA.id);
    const movedProject = await getProjectRow(project.id);
    expect(movedProject.leadId).toBe(survivor.id);
    expect(movedProject.organizationId).toBe(orgA.id);
    const movedConversation = await getConversationRow(conversation.id);
    expect(movedConversation.leadId).toBe(survivor.id);
    expect(movedConversation.organizationId).toBe(orgA.id);

    // The other org's rows never moved.
    const bystanderAppts = await crm.listAppointments(orgB.id, bystander.id);
    expect(bystanderAppts.some((a) => a.id === bystanderAppt.id)).toBe(true);
    expect((await crm.listTasks(orgB.id)).find((t) => t.id === bystanderTask.id)?.leadId).toBe(
      bystander.id,
    );
    const bystanderEstimates = await crm.listEstimates(orgB.id, {
      leadId: bystander.id,
    });
    expect(bystanderEstimates.some((e) => e.id === bystanderEstimate.id)).toBe(true);
    const bystanderProjectRow = await getProjectRow(bystanderProject.id);
    expect(bystanderProjectRow.leadId).toBe(bystander.id);
    expect(bystanderProjectRow.organizationId).toBe(orgB.id);
    const bystanderConversationRow = await getConversationRow(
      bystanderConversation.id,
    );
    expect(bystanderConversationRow.leadId).toBe(bystander.id);
    expect(bystanderConversationRow.organizationId).toBe(orgB.id);

    const survivorActivities = await crm.listLeadActivities(orgA.id, survivor.id);
    expect(survivorActivities.some((a) => a.id === activity.id)).toBe(true);
    // Every row that landed on the survivor stays in org A.
    expect(survivorActivities.every((a) => a.organizationId === orgA.id)).toBe(true);

    const tagRows = await db
      .select()
      .from(leadTagsTable)
      .where(eq(leadTagsTable.tagId, tag.id));
    expect(tagRows.map((r) => r.leadId)).toEqual([survivor.id]);
    expect(tagRows.every((r) => r.organizationId === orgA.id)).toBe(true);

    expect((await crm.getLead(orgA.id, source.id))!.status).toBe("lost");
  });
});

describe("lead search tenant isolation", () => {
  it("search by contact name never returns another org's leads", async () => {
    const stamp = Date.now();
    const name = `Zebulon${stamp}`;
    const contactA = await crm.createContact(orgA.id, {
      firstName: name,
      lastName: "Searchable",
    });
    const contactB = await crm.createContact(orgB.id, {
      firstName: name,
      lastName: "Searchable",
    });
    const leadA = await crm.createLead(orgA.id, { contactId: contactA.id });
    const leadB = await crm.createLead(orgB.id, { contactId: contactB.id });
    expect(leadA).not.toBeNull();
    expect(leadB).not.toBeNull();

    const resultsA = await crm.listLeads(orgA.id, { search: name });
    expect(resultsA.some((l) => l.id === leadA!.id)).toBe(true);
    expect(resultsA.some((l) => l.id === leadB!.id)).toBe(false);
    expect(resultsA.every((l) => l.organizationId === orgA.id)).toBe(true);

    const resultsB = await crm.listLeads(orgB.id, { search: name });
    expect(resultsB.some((l) => l.id === leadB!.id)).toBe(true);
    expect(resultsB.some((l) => l.id === leadA!.id)).toBe(false);
    expect(resultsB.every((l) => l.organizationId === orgB.id)).toBe(true);
  });

  it("search by full name across first and last name stays org-scoped", async () => {
    const stamp = Date.now();
    const first = `Quill${stamp}`;
    const last = `Feather${stamp}`;
    const contactA = await crm.createContact(orgA.id, {
      firstName: first,
      lastName: last,
    });
    const contactB = await crm.createContact(orgB.id, {
      firstName: first,
      lastName: last,
    });
    const leadA = await crm.createLead(orgA.id, { contactId: contactA.id });
    const leadB = await crm.createLead(orgB.id, { contactId: contactB.id });

    const results = await crm.listLeads(orgA.id, {
      search: `${first} ${last}`,
    });
    expect(results.some((l) => l.id === leadA!.id)).toBe(true);
    expect(results.some((l) => l.id === leadB!.id)).toBe(false);
  });

  it("search by service type stays org-scoped", async () => {
    const stamp = Date.now();
    const serviceType = `svc-${stamp}`;
    const contactA = await crm.createContact(orgA.id, { firstName: "SvcA" });
    const contactB = await crm.createContact(orgB.id, { firstName: "SvcB" });
    const leadA = await crm.createLead(orgA.id, {
      contactId: contactA.id,
      serviceType,
    });
    const leadB = await crm.createLead(orgB.id, {
      contactId: contactB.id,
      serviceType,
    });
    expect(leadA).not.toBeNull();
    expect(leadB).not.toBeNull();

    const results = await crm.listLeads(orgA.id, { search: serviceType });
    expect(results.some((l) => l.id === leadA!.id)).toBe(true);
    expect(results.some((l) => l.id === leadB!.id)).toBe(false);
  });
});

describe("listLeads limit cap", () => {
  it("caps limit at 200 and defaults to 200, honoring smaller limits", async () => {
    // Fresh org so seeded lead counts are deterministic.
    const org = await makeOrg(`test-limit-${Date.now()}`);
    extraOrgIds.push(org.id);
    const contact = await crm.createContact(org.id, { firstName: "Bulk" });
    await db
      .insert(leadsTable)
      .values(
        Array.from({ length: 205 }, () => ({
          organizationId: org.id,
          contactId: contact.id,
        })),
      );

    const capped = await crm.listLeads(org.id, { limit: 1000 });
    expect(capped).toHaveLength(200);

    const defaulted = await crm.listLeads(org.id);
    expect(defaulted).toHaveLength(200);

    const small = await crm.listLeads(org.id, { limit: 5 });
    expect(small).toHaveLength(5);

    // Non-finite / sub-1 values fall back sanely instead of breaking the query.
    const zero = await crm.listLeads(org.id, { limit: 0 });
    expect(zero).toHaveLength(200);
    const negative = await crm.listLeads(org.id, { limit: -10 });
    expect(negative).toHaveLength(1);
  });
});

describe("saved filters tenant + user isolation", () => {
  it("saved filters are invisible across orgs and across users", async () => {
    const userA1 = await makeUser(orgA.id);
    const userA2 = await makeUser(orgA.id);
    const userB = await makeUser(orgB.id);

    const filter = await crm.createSavedFilter(orgA.id, userA1.id, {
      name: "Hot leads",
      filters: { status: "ai_qualified" },
    });

    const mine = await crm.listSavedFilters(orgA.id, userA1.id);
    expect(mine.some((f) => f.id === filter.id)).toBe(true);

    // Other user in the same org cannot see it.
    const otherUser = await crm.listSavedFilters(orgA.id, userA2.id);
    expect(otherUser.some((f) => f.id === filter.id)).toBe(false);

    // Other org cannot see it, even with the owner's userId.
    const otherOrg = await crm.listSavedFilters(orgB.id, userA1.id);
    expect(otherOrg.some((f) => f.id === filter.id)).toBe(false);
    const otherBoth = await crm.listSavedFilters(orgB.id, userB.id);
    expect(otherBoth.some((f) => f.id === filter.id)).toBe(false);
  });

  it("saved filters cannot be deleted by another user or org", async () => {
    const owner = await makeUser(orgA.id);
    const otherUser = await makeUser(orgA.id);
    const filter = await crm.createSavedFilter(orgA.id, owner.id, {
      name: "Protected",
      filters: {},
    });

    expect(await crm.deleteSavedFilter(orgA.id, otherUser.id, filter.id)).toBe(false);
    expect(await crm.deleteSavedFilter(orgB.id, owner.id, filter.id)).toBe(false);
    // Owner in the right org can delete.
    expect(await crm.deleteSavedFilter(orgA.id, owner.id, filter.id)).toBe(true);
  });
});

describe("lead creation via public assessment", () => {
  const submission = {
    firstName: "Test",
    lastName: "Homeowner",
    email: "test.homeowner@example.com",
    phone: "+15125550999",
    addressLine1: "1 Test Way",
    city: "Austin",
    state: "TX",
    postalCode: "78701",
    intent: "active-leak" as const,
    description:
      "Water is actively dripping through the ceiling in two rooms after the storm.",
    consent: {
      smsGranted: true,
      emailGranted: false,
      disclosureVersion: "2026-01",
    },
  };

  it("scores emergency intents high with reasons", () => {
    const { score, scoreReasons, urgency } = scoreSubmission(submission);
    expect(score).toBeGreaterThanOrEqual(70);
    expect(urgency).toBe("emergency");
    expect(scoreReasons.length).toBeGreaterThan(2);
  });

  it("creates contact, property, lead, consent, and activity atomically", async () => {
    const result = await captureAssessment({
      organizationId: orgA.id,
      submission,
      sourceIp: "203.0.113.99",
      userAgent: "vitest",
    });
    expect(result.leadId).toBeTruthy();
    expect(result.urgency).toBe("emergency");

    const lead = await crm.getLead(orgA.id, result.leadId);
    expect(lead).not.toBeNull();
    expect(lead!.summary).toContain("[MOCK AI]");
    expect(lead!.scoreReasons.length).toBeGreaterThan(0);

    const activities = await crm.listLeadActivities(orgA.id, result.leadId);
    expect(activities.some((a) => a.type === "lead_captured")).toBe(true);

    // Lead is invisible to the other org.
    expect(await crm.getLead(orgB.id, result.leadId)).toBeNull();
  });
});
