import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { contactsTable, db, organizationsTable, usersTable } from "@workspace/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

import app from "../../app";
import { createSession } from "../../lib/auth";

/**
 * Route-level tenant-isolation tests for GET /v1/contacts.
 *
 * Mirrors leads-search-scope.test.ts: proves the HTTP layer passes the
 * *authenticated* org plus the search query param through to the scoped
 * listContacts service, so a route refactor can't bypass tenant scoping.
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
    .values({ name: `Contacts Route Org ${slug}`, slug: `${slug}-${stamp}` })
    .returning();
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `contacts-route-${slug}-${stamp}@example.com`,
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

async function makeContact(orgId: string, firstName: string, lastName: string) {
  const [contact] = await db
    .insert(contactsTable)
    .values({ organizationId: orgId, firstName, lastName })
    .returning();
  return contact;
}

async function getContacts(sid: string, query: string) {
  return fetch(`${baseUrl}/v1/contacts?${query}`, {
    headers: { authorization: `Bearer ${sid}` },
  });
}

beforeAll(async () => {
  const a = await makeOrgWithSession("contacts-route-a");
  const b = await makeOrgWithSession("contacts-route-b");
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

describe("GET /v1/contacts route-level tenant scoping", () => {
  it("search as an org-A user never returns org-B contact ids", async () => {
    const name = `Quixotic${stamp}`;
    const contactA = await makeContact(orgA.id, name, "RouteScoped");
    const contactB = await makeContact(orgB.id, name, "RouteScoped");

    const res = await getContacts(sidA, `search=${encodeURIComponent(name)}`);
    expect(res.status).toBe(200);
    const contacts = (await res.json()) as { id: string; organizationId: string }[];

    expect(contacts.some((c) => c.id === contactA.id)).toBe(true);
    expect(contacts.some((c) => c.id === contactB.id)).toBe(false);
    expect(contacts.every((c) => c.organizationId === orgA.id)).toBe(true);
  });

  it("an unsearched list as an org-A user stays org-A scoped", async () => {
    const contactB = await makeContact(orgB.id, `Unsearched${stamp}`, "B");
    const res = await getContacts(sidA, "");
    expect(res.status).toBe(200);
    const contacts = (await res.json()) as { id: string; organizationId: string }[];
    expect(contacts.some((c) => c.id === contactB.id)).toBe(false);
    expect(contacts.every((c) => c.organizationId === orgA.id)).toBe(true);
  });
});
