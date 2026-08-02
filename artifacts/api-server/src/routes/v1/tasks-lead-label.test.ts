import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

import app from "../../app";
import { createSession } from "../../lib/auth";

/**
 * GET /v1/tasks must resolve each task's linked-lead display name
 * server-side (leadLabel), so clients never need to download the capped
 * lead list just to label tasks — the same guarantee estimates and
 * projects already have.
 */

let server: Server;
let baseUrl: string;
let sid: string;
let namedLeadId: string;
let summaryLeadId: string;
let orgId: string;

interface TaskResponse {
  id: string;
  leadId: string | null;
  leadLabel: string | null;
}

async function api(method: string, path: string, body?: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${sid}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

beforeAll(async () => {
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Task Lead Label Org",
      slug: `task-lead-label-${Date.now()}`,
    })
    .returning();
  orgId = org.id;
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `task-lead-label-${Date.now()}@example.com`,
      organizationId: org.id,
      role: "admin",
    })
    .returning();
  sid = await createSession({
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
  const [contact] = await db
    .insert(contactsTable)
    .values({ organizationId: org.id, firstName: "Terra", lastName: "Cotta" })
    .returning();
  const [namedLead] = await db
    .insert(leadsTable)
    .values({ organizationId: org.id, contactId: contact.id })
    .returning();
  namedLeadId = namedLead.id;
  const [namelessContact] = await db
    .insert(contactsTable)
    .values({ organizationId: org.id, firstName: "" })
    .returning();
  const [summaryLead] = await db
    .insert(leadsTable)
    .values({
      organizationId: org.id,
      contactId: namelessContact.id,
      summary: "Hail damage roof",
    })
    .returning();
  summaryLeadId = summaryLead.id;

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteTestOrgs(orgId);
});

describe("GET /v1/tasks leadLabel", () => {
  it("labels tasks with the linked lead's contact name", async () => {
    const create = await api("POST", "/v1/tasks", {
      title: "Call Terra",
      leadId: namedLeadId,
    });
    expect(create.status).toBe(201);
    const { id } = (await create.json()) as TaskResponse;

    const res = await api("GET", "/v1/tasks");
    expect(res.status).toBe(200);
    const tasks = (await res.json()) as TaskResponse[];
    const task = tasks.find((t) => t.id === id);
    expect(task?.leadLabel).toBe("Terra Cotta");
  });

  it("falls back to the lead summary when the lead has no contact name", async () => {
    const create = await api("POST", "/v1/tasks", {
      title: "Follow up hail claim",
      leadId: summaryLeadId,
    });
    expect(create.status).toBe(201);
    const { id } = (await create.json()) as TaskResponse;

    const res = await api("GET", "/v1/tasks");
    const tasks = (await res.json()) as TaskResponse[];
    const task = tasks.find((t) => t.id === id);
    expect(task?.leadLabel).toBe("Hail damage roof");
  });

  it("returns null leadLabel for tasks without a lead", async () => {
    const create = await api("POST", "/v1/tasks", { title: "Standalone task" });
    expect(create.status).toBe(201);
    const { id } = (await create.json()) as TaskResponse;

    const res = await api("GET", "/v1/tasks");
    const tasks = (await res.json()) as TaskResponse[];
    const task = tasks.find((t) => t.id === id);
    expect(task?.leadId).toBeNull();
    expect(task?.leadLabel).toBeNull();
  });
});
