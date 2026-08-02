import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { db, organizationsTable, usersTable } from "@workspace/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

import app from "../../app";
import { createSession } from "../../lib/auth";
import * as crm from "../../services/crm";

/**
 * Server-side scoping tests for the assignee filter that backs the mobile
 * "Mine" view: GET /v1/leads?assignedUserId=X and GET /v1/tasks?assignedUserId=X
 * must return only records assigned to X, even when other reps in the same
 * org have records — and the filter must compose with a status filter.
 */

let server: Server;
let baseUrl: string;
let sid: string;
let orgId: string;
let orgBId: string;
let repA: { id: string };
let repB: { id: string };

let leadANew: { id: string };
let leadAWon: { id: string };
let leadB: { id: string };
let taskAOpen: { id: string };
let taskADone: { id: string };
let taskB: { id: string };
let foreignRep: { id: string };

async function get(path: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${sid}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Array<{ id: string; assignedUserId: string | null }>;
}

beforeAll(async () => {
  const [org] = await db
    .insert(organizationsTable)
    .values({ name: "Assignee Scope Org", slug: `assignee-scope-${Date.now()}` })
    .returning();
  orgId = org.id;

  const [admin] = await db
    .insert(usersTable)
    .values({
      email: `assignee-admin-${Date.now()}@example.com`,
      organizationId: org.id,
      role: "admin",
    })
    .returning();
  const [a] = await db
    .insert(usersTable)
    .values({
      email: `assignee-rep-a-${Date.now()}@example.com`,
      organizationId: org.id,
      role: "sales_rep",
    })
    .returning();
  const [b] = await db
    .insert(usersTable)
    .values({
      email: `assignee-rep-b-${Date.now()}@example.com`,
      organizationId: org.id,
      role: "sales_rep",
    })
    .returning();
  repA = a;
  repB = b;

  sid = await createSession({
    user: {
      id: admin.id,
      email: null,
      firstName: null,
      lastName: null,
      profileImageUrl: null,
    },
    access_token: "test-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });

  const contact = await crm.createContact(org.id, {
    firstName: "Scope",
    lastName: "Homeowner",
  });

  leadANew = (await crm.createLead(org.id, {
    contactId: contact.id,
    assignedUserId: repA.id,
    status: "new",
  }))!;
  leadAWon = (await crm.createLead(org.id, {
    contactId: contact.id,
    assignedUserId: repA.id,
    status: "won",
  }))!;
  leadB = (await crm.createLead(org.id, {
    contactId: contact.id,
    assignedUserId: repB.id,
    status: "new",
  }))!;
  // Unassigned lead: must never show up under an assignee filter.
  await crm.createLead(org.id, { contactId: contact.id, status: "new" });

  taskAOpen = (await crm.createTask(org.id, {
    title: "Call homeowner",
    assignedUserId: repA.id,
    status: "open",
  }))!;
  taskADone = (await crm.createTask(org.id, {
    title: "Send estimate",
    assignedUserId: repA.id,
    status: "done",
  }))!;
  taskB = (await crm.createTask(org.id, {
    title: "Inspect roof",
    assignedUserId: repB.id,
    status: "open",
  }))!;
  // Unassigned task: must never show up under an assignee filter.
  await crm.createTask(org.id, { title: "Backlog item", status: "open" });

  // Second organization with its own rep + assigned records. Filtering org A's
  // endpoints by this rep's id must never leak org B's data.
  const [orgB] = await db
    .insert(organizationsTable)
    .values({ name: "Assignee Scope Org B", slug: `assignee-scope-b-${Date.now()}` })
    .returning();
  orgBId = orgB.id;
  const [f] = await db
    .insert(usersTable)
    .values({
      email: `assignee-foreign-rep-${Date.now()}@example.com`,
      organizationId: orgB.id,
      role: "sales_rep",
    })
    .returning();
  foreignRep = f;
  const foreignContact = await crm.createContact(orgB.id, {
    firstName: "Foreign",
    lastName: "Homeowner",
  });
  await crm.createLead(orgB.id, {
    contactId: foreignContact.id,
    assignedUserId: foreignRep.id,
    status: "new",
  });
  await crm.createTask(orgB.id, {
    title: "Foreign org task",
    assignedUserId: foreignRep.id,
    status: "open",
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteTestOrgs(orgId, orgBId);
});

describe("GET /v1/leads?assignedUserId", () => {
  it("returns only the requested rep's leads", async () => {
    const rows = await get(`/v1/leads?assignedUserId=${repA.id}`);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(leadANew.id);
    expect(ids).toContain(leadAWon.id);
    expect(ids).not.toContain(leadB.id);
    for (const row of rows) expect(row.assignedUserId).toBe(repA.id);
  });

  it("excludes the other rep's and unassigned leads for rep B too", async () => {
    const rows = await get(`/v1/leads?assignedUserId=${repB.id}`);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(leadB.id);
    expect(ids).not.toContain(leadANew.id);
    for (const row of rows) expect(row.assignedUserId).toBe(repB.id);
  });

  it("combines assignedUserId with a status filter", async () => {
    const rows = await get(`/v1/leads?assignedUserId=${repA.id}&status=new`);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(leadANew.id);
    expect(ids).not.toContain(leadAWon.id);
    expect(ids).not.toContain(leadB.id);
  });

  it("returns an empty array when filtering by another org's rep id", async () => {
    const rows = await get(`/v1/leads?assignedUserId=${foreignRep.id}`);
    expect(rows).toEqual([]);
  });
});

describe("GET /v1/tasks?assignedUserId", () => {
  it("returns only the requested rep's tasks", async () => {
    const rows = await get(`/v1/tasks?assignedUserId=${repA.id}`);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(taskAOpen.id);
    expect(ids).toContain(taskADone.id);
    expect(ids).not.toContain(taskB.id);
    for (const row of rows) expect(row.assignedUserId).toBe(repA.id);
  });

  it("excludes the other rep's and unassigned tasks for rep B too", async () => {
    const rows = await get(`/v1/tasks?assignedUserId=${repB.id}`);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(taskB.id);
    expect(ids).not.toContain(taskAOpen.id);
    for (const row of rows) expect(row.assignedUserId).toBe(repB.id);
  });

  it("combines assignedUserId with a status filter", async () => {
    const rows = await get(`/v1/tasks?assignedUserId=${repA.id}&status=open`);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(taskAOpen.id);
    expect(ids).not.toContain(taskADone.id);
    expect(ids).not.toContain(taskB.id);
  });

  it("returns an empty array when filtering by another org's rep id", async () => {
    const rows = await get(`/v1/tasks?assignedUserId=${foreignRep.id}`);
    expect(rows).toEqual([]);
  });
});
