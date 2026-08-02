import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { contactsTable, db, leadsTable, organizationsTable, usersTable } from "@workspace/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

import app from "../../app";
import { createSession } from "../../lib/auth";

/**
 * Route-level tenant-isolation tests for GET /v1/leads.
 *
 * Service-level tests (services/tenant-isolation.test.ts, "lead search tenant
 * isolation") already prove listLeads never leaks across orgs. These tests
 * prove the HTTP layer passes the *authenticated* org plus the search/limit
 * query params through to the scoped service, so a route refactor can't
 * bypass it:
 *  - an org-A session searching a term shared by both orgs only sees org-A leads;
 *  - an oversized ?limit= is capped at the service max (200), not passed raw.
 */

let server: Server;
let baseUrl: string;
let orgA: { id: string };
let orgB: { id: string };
let sidA: string;
const stamp = Date.now();

async function makeOrgWithSession(slug: string) {
  const [org] = await db
    .insert(organizationsTable)
    .values({ name: `Leads Route Org ${slug}`, slug: `${slug}-${stamp}` })
    .returning();
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `leads-route-${slug}-${stamp}@example.com`,
      organizationId: org.id,
      role: "admin",
    })
    .returning();
  const sid = await createSession({
    user: {
      id: user.id,
      email: null,
      firstName: null,
      lastName: null,
      profileImageUrl: null,
    },
    access_token: "test-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
  return { org, sid };
}

async function makeLead(orgId: string, firstName: string, lastName: string) {
  const [contact] = await db
    .insert(contactsTable)
    .values({ organizationId: orgId, firstName, lastName })
    .returning();
  const [lead] = await db
    .insert(leadsTable)
    .values({ organizationId: orgId, contactId: contact.id })
    .returning();
  return lead;
}

async function getLeads(sid: string, query: string) {
  return fetch(`${baseUrl}/v1/leads?${query}`, {
    headers: { authorization: `Bearer ${sid}` },
  });
}

beforeAll(async () => {
  const a = await makeOrgWithSession("leads-route-a");
  const b = await makeOrgWithSession("leads-route-b");
  orgA = a.org;
  sidA = a.sid;
  orgB = b.org;

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteTestOrgs(orgA.id, orgB.id);
});

describe("GET /v1/leads route-level tenant scoping", () => {
  it("search as an org-A user never returns org-B lead ids", async () => {
    const name = `Xylophone${stamp}`;
    const leadA = await makeLead(orgA.id, name, "RouteScoped");
    const leadB = await makeLead(orgB.id, name, "RouteScoped");

    const res = await getLeads(sidA, `search=${encodeURIComponent(name)}`);
    expect(res.status).toBe(200);
    const leads = (await res.json()) as { id: string; organizationId: string }[];

    expect(leads.some((l) => l.id === leadA.id)).toBe(true);
    expect(leads.some((l) => l.id === leadB.id)).toBe(false);
    expect(leads.every((l) => l.organizationId === orgA.id)).toBe(true);
  });

  it("an oversized limit query param is capped at 200, not passed through raw", async () => {
    // Seed enough org-A leads that an uncapped limit would return more than 200.
    const [contact] = await db
      .insert(contactsTable)
      .values({ organizationId: orgA.id, firstName: `Bulk${stamp}` })
      .returning();
    await db.insert(leadsTable).values(
      Array.from({ length: 205 }, () => ({
        organizationId: orgA.id,
        contactId: contact.id,
      })),
    );

    const res = await getLeads(sidA, "limit=99999");
    expect(res.status).toBe(200);
    const leads = (await res.json()) as { organizationId: string }[];
    expect(leads.length).toBe(200);
    expect(leads.every((l) => l.organizationId === orgA.id)).toBe(true);
  });

  it("a small explicit limit is honored", async () => {
    const res = await getLeads(sidA, "limit=3");
    expect(res.status).toBe(200);
    expect(((await res.json()) as unknown[]).length).toBe(3);
  });
});
