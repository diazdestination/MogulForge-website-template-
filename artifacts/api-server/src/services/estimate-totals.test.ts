import { db, organizationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

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

async function makeLead(orgId: string, firstName: string) {
  const contact = await crm.createContact(orgId, { firstName });
  const lead = await crm.createLead(orgId, { contactId: contact.id });
  if (!lead) throw new Error("failed to create lead");
  return lead;
}

beforeAll(async () => {
  orgA = await makeOrg(`test-est-a-${Date.now()}`);
  orgB = await makeOrg(`test-est-b-${Date.now()}`);
});

afterAll(async () => {
  await deleteTestOrgs(orgA.id, orgB.id);
});

describe("estimate total computation", () => {
  it("computes subtotal/total from line items on create, ignoring client-sent totalCents", async () => {
    const lead = await makeLead(orgA.id, "Totals");
    const estimate = await crm.createEstimate(orgA.id, {
      leadId: lead.id,
      title: "Roof replacement",
      lineItems: [
        // Client sends a bogus totalCents; server must recompute.
        { description: "Shingles", quantity: 3, unitPriceCents: 10_000, totalCents: 1 },
        { description: "Labor", quantity: 2.5, unitPriceCents: 8_000, totalCents: 999 },
      ],
      taxCents: 2_500,
    });
    expect(estimate).not.toBeNull();
    expect(estimate!.lineItems[0]!.totalCents).toBe(30_000);
    expect(estimate!.lineItems[1]!.totalCents).toBe(20_000);
    expect(estimate!.subtotalCents).toBe(50_000);
    expect(estimate!.taxCents).toBe(2_500);
    expect(estimate!.totalCents).toBe(52_500);
  });

  it("defaults to zero totals with no line items or tax", async () => {
    const lead = await makeLead(orgA.id, "Empty");
    const estimate = await crm.createEstimate(orgA.id, {
      leadId: lead.id,
      title: "Blank",
    });
    expect(estimate!.subtotalCents).toBe(0);
    expect(estimate!.taxCents).toBe(0);
    expect(estimate!.totalCents).toBe(0);
  });

  it("rounds fractional quantities per line item", async () => {
    const lead = await makeLead(orgA.id, "Rounding");
    const estimate = await crm.createEstimate(orgA.id, {
      leadId: lead.id,
      title: "Rounding",
      lineItems: [
        { description: "Partial sq", quantity: 1.333, unitPriceCents: 999, totalCents: 0 },
      ],
    });
    expect(estimate!.lineItems[0]!.totalCents).toBe(Math.round(1.333 * 999));
    expect(estimate!.subtotalCents).toBe(Math.round(1.333 * 999));
    expect(estimate!.totalCents).toBe(estimate!.subtotalCents);
  });

  it("recomputes totals when line items change on update", async () => {
    const lead = await makeLead(orgA.id, "Update");
    const estimate = await crm.createEstimate(orgA.id, {
      leadId: lead.id,
      title: "Before",
      lineItems: [
        { description: "Old", quantity: 1, unitPriceCents: 10_000, totalCents: 10_000 },
      ],
      taxCents: 1_000,
    });
    const updated = await crm.updateEstimate(orgA.id, estimate!.id, {
      lineItems: [
        { description: "New", quantity: 4, unitPriceCents: 5_000, totalCents: 1 },
      ],
    });
    expect(updated!.subtotalCents).toBe(20_000);
    // Tax carried over from existing estimate when not sent.
    expect(updated!.taxCents).toBe(1_000);
    expect(updated!.totalCents).toBe(21_000);
  });

  it("recomputes total on a tax-only update, keeping existing line items", async () => {
    const lead = await makeLead(orgA.id, "TaxOnly");
    const estimate = await crm.createEstimate(orgA.id, {
      leadId: lead.id,
      title: "Tax",
      lineItems: [
        { description: "Work", quantity: 2, unitPriceCents: 15_000, totalCents: 30_000 },
      ],
      taxCents: 0,
    });
    const updated = await crm.updateEstimate(orgA.id, estimate!.id, {
      taxCents: 3_300,
    });
    expect(updated!.subtotalCents).toBe(30_000);
    expect(updated!.taxCents).toBe(3_300);
    expect(updated!.totalCents).toBe(33_300);
    expect(updated!.lineItems).toHaveLength(1);
    expect(updated!.lineItems[0]!.description).toBe("Work");
  });

  it("does not touch totals on a title/status-only update", async () => {
    const lead = await makeLead(orgA.id, "NoTouch");
    const estimate = await crm.createEstimate(orgA.id, {
      leadId: lead.id,
      title: "Stable",
      lineItems: [
        { description: "Work", quantity: 1, unitPriceCents: 12_345, totalCents: 12_345 },
      ],
      taxCents: 655,
    });
    const updated = await crm.updateEstimate(orgA.id, estimate!.id, {
      title: "Renamed",
      status: "sent",
    });
    expect(updated!.title).toBe("Renamed");
    expect(updated!.subtotalCents).toBe(12_345);
    expect(updated!.taxCents).toBe(655);
    expect(updated!.totalCents).toBe(13_000);
    expect(updated!.sentAt).not.toBeNull();
  });
});

describe("negative amount rejection", () => {
  it("rejects create with a negative quantity", async () => {
    const lead = await makeLead(orgA.id, "NegQty");
    const estimate = await crm.createEstimate(orgA.id, {
      leadId: lead.id,
      title: "Bad",
      lineItems: [
        { description: "Refund?", quantity: -3, unitPriceCents: 10_000, totalCents: 0 },
      ],
    });
    expect(estimate).toBeNull();
  });

  it("rejects create with a negative unitPriceCents", async () => {
    const lead = await makeLead(orgA.id, "NegPrice");
    const estimate = await crm.createEstimate(orgA.id, {
      leadId: lead.id,
      title: "Bad",
      lineItems: [
        { description: "Oops", quantity: 1, unitPriceCents: -5_000, totalCents: 0 },
      ],
    });
    expect(estimate).toBeNull();
  });

  it("rejects create with negative taxCents", async () => {
    const lead = await makeLead(orgA.id, "NegTax");
    const estimate = await crm.createEstimate(orgA.id, {
      leadId: lead.id,
      title: "Bad",
      taxCents: -1,
    });
    expect(estimate).toBeNull();
  });

  it("rejects update with negative line-item values and leaves totals untouched", async () => {
    const lead = await makeLead(orgA.id, "NegUpdate");
    const estimate = await crm.createEstimate(orgA.id, {
      leadId: lead.id,
      title: "Good",
      lineItems: [
        { description: "Work", quantity: 2, unitPriceCents: 10_000, totalCents: 20_000 },
      ],
      taxCents: 500,
    });
    const updated = await crm.updateEstimate(orgA.id, estimate!.id, {
      lineItems: [
        { description: "Bad", quantity: 1, unitPriceCents: -1, totalCents: -1 },
      ],
    });
    expect(updated).toBeNull();
    const reloaded = await crm.getEstimate(orgA.id, estimate!.id);
    expect(reloaded!.subtotalCents).toBe(20_000);
    expect(reloaded!.totalCents).toBe(20_500);
  });

  it("rejects update with negative taxCents", async () => {
    const lead = await makeLead(orgA.id, "NegTaxUpdate");
    const estimate = await crm.createEstimate(orgA.id, {
      leadId: lead.id,
      title: "Good",
      lineItems: [
        { description: "Work", quantity: 1, unitPriceCents: 1_000, totalCents: 1_000 },
      ],
    });
    const updated = await crm.updateEstimate(orgA.id, estimate!.id, {
      taxCents: -100,
    });
    expect(updated).toBeNull();
  });

  it("rejects non-finite quantities", async () => {
    const lead = await makeLead(orgA.id, "NaNQty");
    const estimate = await crm.createEstimate(orgA.id, {
      leadId: lead.id,
      title: "Bad",
      lineItems: [
        { description: "NaN", quantity: Number.NaN, unitPriceCents: 1_000, totalCents: 0 },
      ],
    });
    expect(estimate).toBeNull();
  });
});

describe("estimate org scoping", () => {
  it("rejects creating an estimate against another org's lead", async () => {
    const foreignLead = await makeLead(orgB.id, "Foreign");
    const estimate = await crm.createEstimate(orgA.id, {
      leadId: foreignLead.id,
      title: "Cross-org",
    });
    expect(estimate).toBeNull();
  });

  it("estimates are invisible and immutable across orgs", async () => {
    const lead = await makeLead(orgA.id, "Scoped");
    const estimate = await crm.createEstimate(orgA.id, {
      leadId: lead.id,
      title: "Mine",
      lineItems: [
        { description: "Work", quantity: 1, unitPriceCents: 100, totalCents: 100 },
      ],
    });
    expect(await crm.getEstimate(orgB.id, estimate!.id)).toBeNull();
    expect(
      await crm.updateEstimate(orgB.id, estimate!.id, { taxCents: 999 }),
    ).toBeNull();
    expect(await crm.deleteEstimate(orgB.id, estimate!.id)).toBe(false);
    const listB = await crm.listEstimates(orgB.id);
    expect(listB.find((e) => e.id === estimate!.id)).toBeUndefined();
    // Untouched in org A.
    const still = await crm.getEstimate(orgA.id, estimate!.id);
    expect(still?.taxCents).toBe(0);
  });
});

describe("project org scoping", () => {
  it("rejects creating a project against another org's lead", async () => {
    const foreignLead = await makeLead(orgB.id, "ProjForeign");
    const project = await crm.createProject(orgA.id, {
      leadId: foreignLead.id,
      name: "Cross-org project",
    });
    expect(project).toBeNull();
  });

  it("rejects linking a project to another org's estimate", async () => {
    const leadA = await makeLead(orgA.id, "ProjLead");
    const foreignLead = await makeLead(orgB.id, "ForeignEst");
    const foreignEstimate = await crm.createEstimate(orgB.id, {
      leadId: foreignLead.id,
      title: "Foreign estimate",
    });
    const project = await crm.createProject(orgA.id, {
      leadId: leadA.id,
      estimateId: foreignEstimate!.id,
      name: "Bad link",
    });
    expect(project).toBeNull();

    // Also rejected on update.
    const good = await crm.createProject(orgA.id, {
      leadId: leadA.id,
      name: "Good project",
    });
    if (!good || good === crm.DUPLICATE_ESTIMATE) {
      throw new Error("failed to create project");
    }
    expect(
      await crm.updateProject(orgA.id, good!.id, {
        estimateId: foreignEstimate!.id,
      }),
    ).toBeNull();
  });

  it("projects are invisible and immutable across orgs", async () => {
    const lead = await makeLead(orgA.id, "ProjScoped");
    const created = await crm.createProject(orgA.id, {
      leadId: lead.id,
      name: "Scoped project",
    });
    if (!created || created === crm.DUPLICATE_ESTIMATE) {
      throw new Error("failed to create project");
    }
    const project = created;
    expect(await crm.getProject(orgB.id, project!.id)).toBeNull();
    expect(
      await crm.updateProject(orgB.id, project!.id, { name: "Hacked" }),
    ).toBeNull();
    expect(await crm.deleteProject(orgB.id, project!.id)).toBe(false);
    const listB = await crm.listProjects(orgB.id);
    expect(listB.find((p) => p.id === project!.id)).toBeUndefined();
  });
});
