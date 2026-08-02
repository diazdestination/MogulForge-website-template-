import { db, organizationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

import * as crm from "./crm";

let org: { id: string };

async function makeOrg(slug: string) {
  await db.delete(organizationsTable).where(eq(organizationsTable.slug, slug));
  const [row] = await db
    .insert(organizationsTable)
    .values({ name: `Test Org ${slug}`, slug })
    .returning();
  return row;
}

async function makeLeadWithEstimate(firstName: string) {
  const contact = await crm.createContact(org.id, { firstName });
  const lead = await crm.createLead(org.id, { contactId: contact.id });
  if (!lead) throw new Error("failed to create lead");
  const estimate = await crm.createEstimate(org.id, {
    leadId: lead.id,
    title: `Estimate for ${firstName}`,
  });
  if (!estimate) throw new Error("failed to create estimate");
  return { lead, estimate };
}

beforeAll(async () => {
  org = await makeOrg(`test-dup-proj-${Date.now()}`);
});

afterAll(async () => {
  await deleteTestOrgs(org.id);
});

describe("duplicate estimate → project enforcement", () => {
  it("rejects creating a second project from the same estimate", async () => {
    const { lead, estimate } = await makeLeadWithEstimate("DupConcurrent");
    const first = await crm.createProject(org.id, {
      leadId: lead.id,
      estimateId: estimate.id,
      name: "First project",
    });
    expect(first).not.toBeNull();
    expect(first).not.toBe(crm.DUPLICATE_ESTIMATE);

    const second = await crm.createProject(org.id, {
      leadId: lead.id,
      estimateId: estimate.id,
      name: "Second project",
    });
    expect(second).toBe(crm.DUPLICATE_ESTIMATE);
  });

  it("rejects linking an existing project to an already-used estimate via update", async () => {
    const { lead, estimate } = await makeLeadWithEstimate("DupUpdate");
    const owner = await crm.createProject(org.id, {
      leadId: lead.id,
      estimateId: estimate.id,
      name: "Owner project",
    });
    expect(owner).not.toBe(crm.DUPLICATE_ESTIMATE);

    const other = await crm.createProject(org.id, {
      leadId: lead.id,
      name: "Unlinked project",
    });
    expect(other).not.toBeNull();
    expect(other).not.toBe(crm.DUPLICATE_ESTIMATE);
    if (!other || other === crm.DUPLICATE_ESTIMATE) throw new Error("setup failed");

    const updated = await crm.updateProject(org.id, other.id, {
      estimateId: estimate.id,
    });
    expect(updated).toBe(crm.DUPLICATE_ESTIMATE);
  });

  it("allows re-saving the project that already owns the estimate", async () => {
    const { lead, estimate } = await makeLeadWithEstimate("SelfUpdate");
    const project = await crm.createProject(org.id, {
      leadId: lead.id,
      estimateId: estimate.id,
      name: "Self project",
    });
    if (!project || project === crm.DUPLICATE_ESTIMATE) throw new Error("setup failed");

    const updated = await crm.updateProject(org.id, project.id, {
      estimateId: estimate.id,
      name: "Self project renamed",
    });
    expect(updated).not.toBe(crm.DUPLICATE_ESTIMATE);
    expect((updated as { name: string }).name).toBe("Self project renamed");
  });

  it("lets exactly one of two concurrent creates win the same estimate", async () => {
    const { lead, estimate } = await makeLeadWithEstimate("DupConcurrent");
    const [a, b] = await Promise.all([
      crm.createProject(org.id, {
        leadId: lead.id,
        estimateId: estimate.id,
        name: "Racer A",
      }),
      crm.createProject(org.id, {
        leadId: lead.id,
        estimateId: estimate.id,
        name: "Racer B",
      }),
    ]);

    const results = [a, b];
    const winners = results.filter(
      (r) => r !== null && r !== crm.DUPLICATE_ESTIMATE,
    );
    const duplicates = results.filter((r) => r === crm.DUPLICATE_ESTIMATE);
    expect(winners).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
  });

  it("still allows projects with no estimate", async () => {
    const { lead } = await makeLeadWithEstimate("NoEstimate");
    const a = await crm.createProject(org.id, { leadId: lead.id, name: "A" });
    const b = await crm.createProject(org.id, { leadId: lead.id, name: "B" });
    expect(a).not.toBe(crm.DUPLICATE_ESTIMATE);
    expect(b).not.toBe(crm.DUPLICATE_ESTIMATE);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });
});
