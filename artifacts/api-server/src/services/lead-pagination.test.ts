import {
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

import * as crm from "./crm";

/**
 * Lead pagination: offset paging must return disjoint, complete, correctly
 * ordered pages (createdAt desc, id desc tiebreaker) — with and without
 * filters — and bad offsets must fall back to 0.
 */

const TOTAL = 210; // > one full page of 200
const PAGE = 200;

let org: { id: string };
let userA: { id: string };
let userB: { id: string };
let allIds: string[] = [];

beforeAll(async () => {
  const slug = `test-pagination-${Date.now()}`;
  await db.delete(organizationsTable).where(eq(organizationsTable.slug, slug));
  const [o] = await db
    .insert(organizationsTable)
    .values({ name: "Pagination Org", slug })
    .returning();
  org = o;

  const [ua] = await db
    .insert(usersTable)
    .values({ organizationId: org.id })
    .returning();
  const [ub] = await db
    .insert(usersTable)
    .values({ organizationId: org.id })
    .returning();
  userA = ua;
  userB = ub;

  const [contact] = await db
    .insert(contactsTable)
    .values({ organizationId: org.id, firstName: "Page", lastName: "Turner" })
    .returning();

  // Distinct createdAt per lead so ordering is deterministic; alternate
  // status and assignee so filtered paging has >200 matches too... no —
  // keep filters selecting a large subset: half get status "ai_qualified",
  // half get userA assigned (overlapping, deterministic by index).
  const base = Date.parse("2026-01-01T00:00:00Z");
  const values = Array.from({ length: TOTAL }, (_, i) => ({
    organizationId: org.id,
    contactId: contact.id,
    status: (i % 2 === 0 ? "ai_qualified" : "new") as "ai_qualified" | "new",
    assignedUserId: i % 3 === 0 ? userA.id : userB.id,
    createdAt: new Date(base + i * 1000),
  }));
  const rows = await db
    .insert(leadsTable)
    .values(values)
    .returning({ id: leadsTable.id, createdAt: leadsTable.createdAt });
  expect(rows).toHaveLength(TOTAL);
  allIds = rows.map((r) => r.id);
});

afterAll(async () => {
  // Remove seeded data so this suite never pollutes org-scanning suites
  // (e.g. API-key expiry reminders).
  await deleteTestOrgs(org?.id);
});

function expectOrdered(rows: { createdAt: Date; id: string }[]) {
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    const dPrev = prev.createdAt.getTime();
    const dCur = cur.createdAt.getTime();
    expect(dCur <= dPrev).toBe(true);
    if (dCur === dPrev) {
      expect(cur.id < prev.id).toBe(true);
    }
  }
}

describe("lead pagination", () => {
  it("page 2 returns the next distinct leads with no overlap or gaps", async () => {
    const page1 = await crm.listLeads(org.id, { limit: PAGE, offset: 0 });
    const page2 = await crm.listLeads(org.id, { limit: PAGE, offset: PAGE });

    expect(page1).toHaveLength(PAGE);
    expect(page2).toHaveLength(TOTAL - PAGE);

    const ids1 = new Set(page1.map((l) => l.id));
    const ids2 = new Set(page2.map((l) => l.id));
    // Disjoint
    for (const id of ids2) expect(ids1.has(id)).toBe(false);
    // Complete: union covers every seeded lead
    const union = new Set([...ids1, ...ids2]);
    for (const id of allIds) expect(union.has(id)).toBe(true);

    // Ordered across the page boundary too
    expectOrdered([...page1, ...page2]);
    const boundaryPrev = page1[page1.length - 1];
    const boundaryNext = page2[0];
    expect(
      boundaryNext.createdAt.getTime() <= boundaryPrev.createdAt.getTime(),
    ).toBe(true);
  });

  it("smaller pages tile the full list exactly", async () => {
    const seen: string[] = [];
    for (let offset = 0; offset < TOTAL; offset += 50) {
      const page = await crm.listLeads(org.id, { limit: 50, offset });
      expect(page.length).toBe(Math.min(50, TOTAL - offset));
      seen.push(...page.map((l) => l.id));
    }
    expect(new Set(seen).size).toBe(TOTAL);
    expect(new Set(seen)).toEqual(new Set(allIds));
  });

  it("paging with a status filter stays disjoint and complete", async () => {
    const expected = Math.ceil(TOTAL / 2); // even indexes → ai_qualified
    const p1 = await crm.listLeads(org.id, {
      status: "ai_qualified",
      limit: 60,
      offset: 0,
    });
    const p2 = await crm.listLeads(org.id, {
      status: "ai_qualified",
      limit: 60,
      offset: 60,
    });
    expect(p1.every((l) => l.status === "ai_qualified")).toBe(true);
    expect(p2.every((l) => l.status === "ai_qualified")).toBe(true);
    const ids1 = new Set(p1.map((l) => l.id));
    for (const l of p2) expect(ids1.has(l.id)).toBe(false);
    expectOrdered([...p1, ...p2]);

    // Full tiling over the filtered set
    const seen = new Set<string>();
    for (let offset = 0; ; offset += 60) {
      const page = await crm.listLeads(org.id, {
        status: "ai_qualified",
        limit: 60,
        offset,
      });
      page.forEach((l) => seen.add(l.id));
      if (page.length < 60) break;
    }
    expect(seen.size).toBe(expected);
  });

  it("paging with an assignedUserId filter stays disjoint and complete", async () => {
    const expected = Math.ceil(TOTAL / 3); // every 3rd → userA
    const p1 = await crm.listLeads(org.id, {
      assignedUserId: userA.id,
      limit: 40,
      offset: 0,
    });
    const p2 = await crm.listLeads(org.id, {
      assignedUserId: userA.id,
      limit: 40,
      offset: 40,
    });
    expect(p1.every((l) => l.assignedUserId === userA.id)).toBe(true);
    expect(p2.every((l) => l.assignedUserId === userA.id)).toBe(true);
    const ids1 = new Set(p1.map((l) => l.id));
    for (const l of p2) expect(ids1.has(l.id)).toBe(false);
    expectOrdered([...p1, ...p2]);

    const seen = new Set<string>();
    for (let offset = 0; ; offset += 40) {
      const page = await crm.listLeads(org.id, {
        assignedUserId: userA.id,
        limit: 40,
        offset,
      });
      page.forEach((l) => seen.add(l.id));
      if (page.length < 40) break;
    }
    expect(seen.size).toBe(expected);
  });

  it("negative, NaN, and fractional offsets fall back to sane values", async () => {
    const first = await crm.listLeads(org.id, { limit: 10, offset: 0 });
    const neg = await crm.listLeads(org.id, { limit: 10, offset: -50 });
    const nan = await crm.listLeads(org.id, { limit: 10, offset: Number.NaN });
    const inf = await crm.listLeads(org.id, {
      limit: 10,
      offset: Number.POSITIVE_INFINITY,
    });
    expect(neg.map((l) => l.id)).toEqual(first.map((l) => l.id));
    expect(nan.map((l) => l.id)).toEqual(first.map((l) => l.id));
    expect(inf.map((l) => l.id)).toEqual(first.map((l) => l.id));

    // Fractional offsets floor rather than erroring
    const frac = await crm.listLeads(org.id, { limit: 10, offset: 5.9 });
    const five = await crm.listLeads(org.id, { limit: 10, offset: 5 });
    expect(frac.map((l) => l.id)).toEqual(five.map((l) => l.id));
  });
});
