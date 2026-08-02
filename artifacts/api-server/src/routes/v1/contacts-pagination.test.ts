import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { contactsTable, db, organizationsTable, usersTable } from "@workspace/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

import app from "../../app";
import { createSession } from "../../lib/auth";

/**
 * GET /v1/contacts (and /v1/properties, /v1/estimates) accept limit/offset so
 * reps can page past the first 200 rows. Ordering is deterministic
 * (createdAt desc, id desc), so consecutive pages never repeat or skip rows.
 */

let server: Server;
let baseUrl: string;
let orgId: string;
let sid: string;

const TOTAL = 5;

beforeAll(async () => {
  const [org] = await db
    .insert(organizationsTable)
    .values({ name: "Contacts Paging Org", slug: `contacts-paging-${Date.now()}` })
    .returning();
  orgId = org.id;
  const [u] = await db
    .insert(usersTable)
    .values({
      email: `contacts-paging-${Date.now()}@example.com`,
      organizationId: orgId,
      role: "admin",
    })
    .returning();
  sid = await createSession({
    user: { id: u.id, email: null, firstName: null, lastName: null, profileImageUrl: null },
    access_token: "test-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
  // Same createdAt on purpose: the id tiebreaker must keep ordering stable.
  const createdAt = new Date();
  await db.insert(contactsTable).values(
    Array.from({ length: TOTAL }, (_, i) => ({
      organizationId: orgId,
      firstName: `Page${i}`,
      createdAt,
    })),
  );
  server = app.listen(0);
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  server?.close();
  await deleteTestOrgs(orgId);
});

async function fetchContacts(query: string) {
  const res = await fetch(`${baseUrl}/api/v1/contacts${query}`, {
    headers: { Authorization: `Bearer ${sid}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Array<{ id: string }>;
}

describe("contacts pagination", () => {
  it("pages through all contacts without repeats or gaps", async () => {
    const all = await fetchContacts("");
    expect(all.length).toBe(TOTAL);

    const seen: string[] = [];
    for (let offset = 0; offset < TOTAL; offset += 2) {
      const page = await fetchContacts(`?limit=2&offset=${offset}`);
      expect(page.length).toBeLessThanOrEqual(2);
      seen.push(...page.map((c) => c.id));
    }
    expect(seen).toEqual(all.map((c) => c.id));
    expect(new Set(seen).size).toBe(TOTAL);
  });

  it("returns an empty page past the end and treats bad params safely", async () => {
    expect(await fetchContacts(`?offset=${TOTAL}`)).toEqual([]);
    // Negative offset clamps to 0; oversized limit is capped server-side.
    const clamped = await fetchContacts("?limit=9999&offset=-5");
    expect(clamped.length).toBe(TOTAL);
  });
});
