/**
 * Contract tests for Google Places API key masking on settings routes.
 *
 * GET /v1/settings:
 *  - Admin callers see a masked key (contains "••••"), never the raw value.
 *  - Non-admin callers see no apiKey at all.
 *
 * PUT /v1/settings:
 *  - Response also returns a masked key, never the raw value.
 *  - Submitting the masked sentinel preserves the stored key (no overwrite).
 *  - Submitting an empty/absent apiKey clears the stored key.
 */

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, organizationsTable, usersTable } from "@workspace/db";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { createSession } from "../../lib/auth";

const { default: app } = await import("../../app");

let server: Server;
let baseUrl: string;
let org: { id: string };
let adminSid: string;
let viewerSid: string;

const RAW_KEY = "AIzaTestKeyForMaskingXX1234567890ABCD";
const MASK_SENTINEL = "••••";

async function api(
  method: string,
  path: string,
  sid: string,
  body?: unknown,
) {
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
  const [o] = await db
    .insert(organizationsTable)
    .values({
      name: "API Key Mask Test Org",
      slug: `api-key-mask-test-${Date.now()}`,
    })
    .returning();
  org = o;

  const [adminUser] = await db
    .insert(usersTable)
    .values({
      email: `api-key-mask-admin-${Date.now()}@example.com`,
      organizationId: org.id,
      role: "admin",
    })
    .returning();

  const [viewerUser] = await db
    .insert(usersTable)
    .values({
      email: `api-key-mask-viewer-${Date.now()}@example.com`,
      organizationId: org.id,
      role: "viewer",
    })
    .returning();

  adminSid = await createSession({
    user: { id: adminUser.id, email: null, firstName: null, lastName: null, profileImageUrl: null },
    access_token: "test-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });

  viewerSid = await createSession({
    user: { id: viewerUser.id, email: null, firstName: null, lastName: null, profileImageUrl: null },
    access_token: "test-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

  // Seed a real API key so masking tests have something to mask.
  const res = await api("PUT", "/v1/settings", adminSid, {
    googleReviews: { placeId: "ChIJTestPlace", apiKey: RAW_KEY },
  });
  expect(res.status).toBe(200);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteTestOrgs(org.id);
});

describe("GET /v1/settings — API key masking", () => {
  it("returns a masked key (contains ••••) for admins, not the raw value", async () => {
    const res = await api("GET", "/v1/settings", adminSid);
    expect(res.status).toBe(200);
    const body = await res.json() as { googleReviews?: { apiKey?: string } };
    expect(body.googleReviews?.apiKey).toBeDefined();
    expect(body.googleReviews?.apiKey).toContain(MASK_SENTINEL);
    expect(body.googleReviews?.apiKey).not.toBe(RAW_KEY);
  });

  it("strips the apiKey entirely for non-admin callers", async () => {
    const res = await api("GET", "/v1/settings", viewerSid);
    expect(res.status).toBe(200);
    const body = await res.json() as { googleReviews?: { apiKey?: string } };
    expect(body.googleReviews?.apiKey).toBeUndefined();
  });
});

describe("PUT /v1/settings — API key masking in response", () => {
  it("returns a masked key in the PUT response, never the raw value", async () => {
    const res = await api("PUT", "/v1/settings", adminSid, {
      googleReviews: { placeId: "ChIJTestPlace", apiKey: RAW_KEY },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { googleReviews?: { apiKey?: string } };
    expect(body.googleReviews?.apiKey).toContain(MASK_SENTINEL);
    expect(body.googleReviews?.apiKey).not.toBe(RAW_KEY);
  });
});

describe("PUT /v1/settings — masked sentinel preserves stored key", () => {
  it("keeps the stored key when the admin submits the masked sentinel", async () => {
    // First read to get the masked sentinel.
    const getRes = await api("GET", "/v1/settings", adminSid);
    const { googleReviews } = await getRes.json() as { googleReviews?: { apiKey?: string; placeId?: string } };
    const maskedKey = googleReviews?.apiKey;
    expect(maskedKey).toContain(MASK_SENTINEL);

    // PUT with the masked sentinel — key must not change.
    const putRes = await api("PUT", "/v1/settings", adminSid, {
      googleReviews: { placeId: "ChIJUpdatedPlace", apiKey: maskedKey },
    });
    expect(putRes.status).toBe(200);

    // A subsequent GET must still return a masked key (stored key intact).
    const afterRes = await api("GET", "/v1/settings", adminSid);
    const after = await afterRes.json() as { googleReviews?: { apiKey?: string } };
    expect(after.googleReviews?.apiKey).toContain(MASK_SENTINEL);
  });
});

describe("PUT /v1/settings — empty apiKey clears the stored key", () => {
  it("removes the stored key when the admin submits an empty apiKey", async () => {
    // Ensure a key is stored.
    await api("PUT", "/v1/settings", adminSid, {
      googleReviews: { placeId: "ChIJTestPlace", apiKey: RAW_KEY },
    });

    // PUT with no apiKey — should clear it.
    const clearRes = await api("PUT", "/v1/settings", adminSid, {
      googleReviews: { placeId: "ChIJTestPlace" },
    });
    expect(clearRes.status).toBe(200);

    // Subsequent GET should have no apiKey.
    const afterRes = await api("GET", "/v1/settings", adminSid);
    const after = await afterRes.json() as { googleReviews?: { apiKey?: string } };
    expect(after.googleReviews?.apiKey).toBeUndefined();
  });
});
