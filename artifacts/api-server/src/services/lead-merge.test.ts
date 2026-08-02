import {
  appointmentsTable,
  conversationsTable,
  crmTasksTable,
  db,
  estimatesTable,
  organizationsTable,
  projectsTable,
  tagsTable,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

import * as crm from "./crm";

let orgA: { id: string };
let orgB: { id: string };
let actor: { id: string };

async function makeOrg(slug: string) {
  await db.delete(organizationsTable).where(eq(organizationsTable.slug, slug));
  const [org] = await db
    .insert(organizationsTable)
    .values({ name: `Test Org ${slug}`, slug })
    .returning();
  return org;
}

async function makeLeadWithData(orgId: string) {
  const contact = await crm.createContact(orgId, { firstName: "Merge" });
  const lead = await crm.createLead(orgId, { contactId: contact.id });
  return { contact, lead: lead! };
}

beforeAll(async () => {
  orgA = await makeOrg(`test-merge-a-${Date.now()}`);
  orgB = await makeOrg(`test-merge-b-${Date.now()}`);
  const [user] = await db
    .insert(usersTable)
    .values({
      id: `test-merge-actor-${Date.now()}`,
      organizationId: orgA.id,
      email: `merge-actor-${Date.now()}@test.local`,
      role: "admin",
    })
    .returning();
  actor = user;
});

afterAll(async () => {
  await deleteTestOrgs(orgA.id, orgB.id);
});

describe("mergeLeads", () => {
  it("moves activities and tags to the survivor and marks the source lost", async () => {
    const { lead: survivor } = await makeLeadWithData(orgA.id);
    const { contact: srcContact, lead: source } = await makeLeadWithData(orgA.id);

    await crm.createActivity(orgA.id, {
      leadId: source.id,
      contactId: srcContact.id,
      actorUserId: null,
      type: "note",
      title: "Source note",
      body: "from duplicate",
      metadata: {},
    });
    const [tag] = await db
      .insert(tagsTable)
      .values({ organizationId: orgA.id, name: `merge-tag-${Date.now()}` })
      .returning();
    await crm.bulkTagLeads(orgA.id, [source.id, survivor.id], tag.id);

    const result = await crm.mergeLeads(orgA.id, survivor.id, source.id, actor.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.movedActivities).toBe(1);
    expect(result.movedTags).toBe(1); // survivor already had the tag; still moved/deduped

    const survivorActivities = await crm.listLeadActivities(orgA.id, survivor.id);
    expect(survivorActivities.find((a) => a.title === "Source note")).toBeTruthy();
    expect(
      survivorActivities.find((a) => a.title === "Merged duplicate lead"),
    ).toBeTruthy();
    expect(await crm.listLeadActivities(orgA.id, source.id)).toHaveLength(0);

    const sourceAfter = await crm.getLead(orgA.id, source.id);
    expect(sourceAfter?.status).toBe("lost");
  });

  it("re-points appointments, tasks, estimates, projects, and conversations to the survivor", async () => {
    const { lead: survivor } = await makeLeadWithData(orgA.id);
    const { lead: source } = await makeLeadWithData(orgA.id);

    await db.insert(appointmentsTable).values({
      organizationId: orgA.id,
      leadId: source.id,
      scheduledStart: new Date(),
    });
    await db.insert(crmTasksTable).values({
      organizationId: orgA.id,
      leadId: source.id,
      title: "Follow up",
    });
    await db.insert(estimatesTable).values({
      organizationId: orgA.id,
      leadId: source.id,
      title: "Roof estimate",
    });
    await db.insert(projectsTable).values({
      organizationId: orgA.id,
      leadId: source.id,
      name: "Roof replacement",
    });
    await db.insert(conversationsTable).values({
      organizationId: orgA.id,
      leadId: source.id,
    });

    const result = await crm.mergeLeads(orgA.id, survivor.id, source.id, actor.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.movedAppointments).toBe(1);
    expect(result.movedTasks).toBe(1);
    expect(result.movedEstimates).toBe(1);
    expect(result.movedProjects).toBe(1);
    expect(result.movedConversations).toBe(1);

    // Each entity now points at the survivor and none remain on the source.
    for (const table of [
      appointmentsTable,
      crmTasksTable,
      estimatesTable,
      projectsTable,
      conversationsTable,
    ] as const) {
      const onSurvivor = await db
        .select({ id: table.id })
        .from(table)
        .where(eq(table.leadId, survivor.id));
      expect(onSurvivor).toHaveLength(1);
      const onSource = await db
        .select({ id: table.id })
        .from(table)
        .where(eq(table.leadId, source.id));
      expect(onSource).toHaveLength(0);
    }

    // Merge note metadata reflects what moved.
    const survivorActivities = await crm.listLeadActivities(orgA.id, survivor.id);
    const note = survivorActivities.find((a) => a.title === "Merged duplicate lead");
    expect(note).toBeTruthy();
    expect(note?.metadata).toMatchObject({
      mergedLeadId: source.id,
      movedAppointments: 1,
      movedTasks: 1,
      movedEstimates: 1,
      movedProjects: 1,
      movedConversations: 1,
    });
  });

  it("does not move another org's records that point at a same-id lead", async () => {
    // Org-scoping check: records in org B referencing org B's lead stay put
    // even when org A merges its own leads.
    const { lead: bLead } = await makeLeadWithData(orgB.id);
    await db.insert(crmTasksTable).values({
      organizationId: orgB.id,
      leadId: bLead.id,
      title: "B task",
    });
    const { lead: survivor } = await makeLeadWithData(orgA.id);
    const { lead: source } = await makeLeadWithData(orgA.id);
    const result = await crm.mergeLeads(orgA.id, survivor.id, source.id, actor.id);
    expect(result.ok).toBe(true);
    const bTasks = await db
      .select({ id: crmTasksTable.id })
      .from(crmTasksTable)
      .where(eq(crmTasksTable.leadId, bLead.id));
    expect(bTasks).toHaveLength(1);
  });

  it("no longer suggests a merged pair as a duplicate group", async () => {
    const email = `dup-merged-${Date.now()}@test.local`;
    const survivorContact = await crm.createContact(orgA.id, {
      firstName: "Dup",
      email,
    });
    const sourceContact = await crm.createContact(orgA.id, {
      firstName: "Dup2",
      email,
    });
    const survivor = (await crm.createLead(orgA.id, {
      contactId: survivorContact.id,
    }))!;
    const source = (await crm.createLead(orgA.id, {
      contactId: sourceContact.id,
    }))!;

    // Before the merge, the pair shows up as an email duplicate group.
    const before = await crm.findDuplicateLeadGroups(orgA.id);
    const groupBefore = before.find(
      (g) =>
        g.field === "email" &&
        g.leadIds.includes(survivor.id) &&
        g.leadIds.includes(source.id),
    );
    expect(groupBefore).toBeTruthy();

    const result = await crm.mergeLeads(orgA.id, survivor.id, source.id, actor.id);
    expect(result.ok).toBe(true);

    // After the merge, the lost source no longer appears in any group.
    const after = await crm.findDuplicateLeadGroups(orgA.id);
    for (const group of after) {
      expect(group.leadIds).not.toContain(source.id);
    }
  });

  it("rejects merging a lead into itself", async () => {
    const { lead } = await makeLeadWithData(orgA.id);
    const result = await crm.mergeLeads(orgA.id, lead.id, lead.id, actor.id);
    expect(result).toEqual({ ok: false, error: "same_lead" });
  });

  it("cannot merge across organizations", async () => {
    const { lead: aLead } = await makeLeadWithData(orgA.id);
    const { lead: bLead } = await makeLeadWithData(orgB.id);
    expect(
      await crm.mergeLeads(orgA.id, aLead.id, bLead.id, actor.id),
    ).toEqual({ ok: false, error: "not_found" });
    expect(
      await crm.mergeLeads(orgB.id, bLead.id, aLead.id, actor.id),
    ).toEqual({ ok: false, error: "not_found" });
    expect((await crm.getLead(orgB.id, bLead.id))?.status).not.toBe("lost");
  });
});
