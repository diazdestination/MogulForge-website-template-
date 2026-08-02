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
 * Route-level tests proving the server never trusts a client-provided
 * lineItem totalCents. POST /v1/estimates and PATCH /v1/estimates/:id must
 * recompute each line's totalCents as quantity × unitPriceCents (and the
 * estimate's subtotal/total from those recomputed lines), so a mismatched
 * totalCents from the client can never surface to homeowners.
 */

let server: Server;
let baseUrl: string;
let sid: string;
let leadId: string;
let orgId: string;

interface EstimateResponse {
  id: string;
  lineItems: Array<{ quantity: number; unitPriceCents: number; totalCents: number }>;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
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
      name: "Estimate Line Total Org",
      slug: `estimate-line-total-${Date.now()}`,
    })
    .returning();
  orgId = org.id;
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `estimate-line-total-${Date.now()}@example.com`,
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
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteTestOrgs(orgId);
});

describe("POST /v1/estimates recomputes mismatched line totals", () => {
  it("overrides a client totalCents that doesn't match quantity × unitPriceCents", async () => {
    const res = await api("POST", "/v1/estimates", {
      leadId,
      title: "Mismatched total",
      lineItems: [
        { description: "Shingles", quantity: 2, unitPriceCents: 1000, totalCents: 5 },
      ],
      taxCents: 100,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as EstimateResponse;
    expect(body.lineItems[0].totalCents).toBe(2000);
    expect(body.subtotalCents).toBe(2000);
    expect(body.totalCents).toBe(2100);
  });

  it("recomputes every line when several totals are wrong", async () => {
    const res = await api("POST", "/v1/estimates", {
      leadId,
      title: "Multiple mismatched totals",
      lineItems: [
        { description: "Shingles", quantity: 3, unitPriceCents: 500, totalCents: 1 },
        { description: "Labor", quantity: 2, unitPriceCents: 2500, totalCents: 999999 },
      ],
      taxCents: 0,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as EstimateResponse;
    expect(body.lineItems.map((li) => li.totalCents)).toEqual([1500, 5000]);
    expect(body.subtotalCents).toBe(6500);
    expect(body.totalCents).toBe(6500);
  });
});

describe("PATCH /v1/estimates/:id recomputes mismatched line totals", () => {
  it("overrides a client totalCents that doesn't match quantity × unitPriceCents", async () => {
    const createRes = await api("POST", "/v1/estimates", {
      leadId,
      title: "Baseline",
      lineItems: [
        { description: "Shingles", quantity: 1, unitPriceCents: 1000, totalCents: 1000 },
      ],
      taxCents: 0,
    });
    expect(createRes.status).toBe(201);
    const { id } = (await createRes.json()) as EstimateResponse;

    const res = await api("PATCH", `/v1/estimates/${id}`, {
      lineItems: [
        { description: "Shingles", quantity: 4, unitPriceCents: 250, totalCents: 7 },
      ],
      taxCents: 50,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as EstimateResponse;
    expect(body.lineItems[0].totalCents).toBe(1000);
    expect(body.subtotalCents).toBe(1000);
    expect(body.totalCents).toBe(1050);
  });
});
