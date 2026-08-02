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
 * Route-level tests proving the estimate endpoints reject negative money
 * amounts at the door: POST /v1/estimates and PATCH /v1/estimates/:id must
 * return 400 when quantity, unitPriceCents, or taxCents is negative.
 *
 * The bounds live in the OpenAPI spec (minimum: 0) and flow into the
 * generated zod schemas (CreateEstimateBody / UpdateEstimateBody). These
 * tests guard against a future codegen or route change silently dropping
 * them.
 */

let server: Server;
let baseUrl: string;
let sid: string;
let leadId: string;
let estimateId: string;
let orgId: string;

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

function lineItem(overrides: Partial<Record<string, number>> = {}) {
  return {
    description: "Shingles",
    quantity: 1,
    unitPriceCents: 1000,
    totalCents: 1000,
    ...overrides,
  };
}

beforeAll(async () => {
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Estimate Bounds Org",
      slug: `estimate-bounds-${Date.now()}`,
    })
    .returning();
  orgId = org.id;
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `estimate-bounds-${Date.now()}@example.com`,
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
    .values({ organizationId: org.id, firstName: "Est" })
    .returning();
  const [lead] = await db
    .insert(leadsTable)
    .values({ organizationId: org.id, contactId: contact.id })
    .returning();
  leadId = lead.id;

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

  // A valid estimate to PATCH against.
  const res = await api("POST", "/v1/estimates", {
    leadId,
    title: "Baseline",
    lineItems: [lineItem()],
    taxCents: 0,
  });
  if (res.status !== 201) {
    throw new Error(`baseline estimate create failed: ${res.status}`);
  }
  estimateId = ((await res.json()) as { id: string }).id;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteTestOrgs(orgId);
});

describe("POST /v1/estimates rejects negative amounts (400)", () => {
  it("rejects a negative line-item quantity", async () => {
    const res = await api("POST", "/v1/estimates", {
      leadId,
      title: "Bad quantity",
      lineItems: [lineItem({ quantity: -1 })],
    });
    expect(res.status).toBe(400);
  });

  it("rejects a negative line-item unitPriceCents", async () => {
    const res = await api("POST", "/v1/estimates", {
      leadId,
      title: "Bad unit price",
      lineItems: [lineItem({ unitPriceCents: -500 })],
    });
    expect(res.status).toBe(400);
  });

  it("rejects negative taxCents", async () => {
    const res = await api("POST", "/v1/estimates", {
      leadId,
      title: "Bad tax",
      lineItems: [lineItem()],
      taxCents: -1,
    });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /v1/estimates/:id rejects negative amounts (400)", () => {
  it("rejects a negative line-item quantity", async () => {
    const res = await api("PATCH", `/v1/estimates/${estimateId}`, {
      lineItems: [lineItem({ quantity: -2 })],
    });
    expect(res.status).toBe(400);
  });

  it("rejects a negative line-item unitPriceCents", async () => {
    const res = await api("PATCH", `/v1/estimates/${estimateId}`, {
      lineItems: [lineItem({ unitPriceCents: -1 })],
    });
    expect(res.status).toBe(400);
  });

  it("rejects negative taxCents", async () => {
    const res = await api("PATCH", `/v1/estimates/${estimateId}`, {
      taxCents: -100,
    });
    expect(res.status).toBe(400);
  });

  it("still accepts a valid update (sanity)", async () => {
    const res = await api("PATCH", `/v1/estimates/${estimateId}`, {
      taxCents: 250,
    });
    expect(res.status).toBe(200);
  });
});
