import { db, organizationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

import * as crm from "./crm";

let org: { id: string };

beforeAll(async () => {
  const slug = `test-dupscan-${Date.now()}`;
  await db.delete(organizationsTable).where(eq(organizationsTable.slug, slug));
  const [row] = await db
    .insert(organizationsTable)
    .values({ name: `Test Org ${slug}`, slug })
    .returning();
  org = row;
});

afterAll(async () => {
  await deleteTestOrgs(org.id);
});

async function makeLead(email?: string, phone?: string) {
  const contact = await crm.createContact(org.id, {
    firstName: "Dup",
    email,
    phone,
  });
  const lead = (await crm.createLead(org.id, { contactId: contact.id }))!;
  return lead;
}

describe("findDuplicateLeadGroups pagination", () => {
  it("finds duplicate pairs even when the org has more leads than one scan batch", async () => {
    // Filler leads with unique emails so no accidental groups form.
    const stamp = Date.now();
    const fillerCount = 12;
    for (let i = 0; i < fillerCount; i++) {
      await makeLead(`dupscan-filler-${stamp}-${i}@test.local`);
    }
    // A duplicate email pair and a duplicate phone pair. With a tiny batch
    // size, these land in different batches than most fillers, so the scan
    // must paginate through everything to see both members of each pair.
    const dupEmail = `dupscan-pair-${stamp}@test.local`;
    const emailA = await makeLead(dupEmail);
    const emailB = await makeLead(dupEmail);
    const dupPhone = `+1 (555) ${String(stamp).slice(-3)}-9876`;
    const phoneA = await makeLead(undefined, dupPhone);
    const phoneB = await makeLead(undefined, dupPhone);

    // batchSize far below the total lead count forces multiple batches.
    const groups = await crm.findDuplicateLeadGroups(org.id, { batchSize: 3 });

    const emailGroup = groups.find(
      (g) =>
        g.field === "email" &&
        g.leadIds.includes(emailA.id) &&
        g.leadIds.includes(emailB.id),
    );
    expect(emailGroup).toBeTruthy();
    const phoneGroup = groups.find(
      (g) =>
        g.field === "phone" &&
        g.leadIds.includes(phoneA.id) &&
        g.leadIds.includes(phoneB.id),
    );
    expect(phoneGroup).toBeTruthy();
  });

  it("returns the same groups regardless of batch size", async () => {
    const small = await crm.findDuplicateLeadGroups(org.id, { batchSize: 2 });
    const large = await crm.findDuplicateLeadGroups(org.id);
    const key = (g: crm.DuplicateLeadGroup) =>
      `${g.field}:${[...g.leadIds].sort().join(",")}`;
    expect(small.map(key).sort()).toEqual(large.map(key).sort());
  });
});
