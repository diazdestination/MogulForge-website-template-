/**
 * When the admin updates org settings and the request body includes a
 * `googleReviews` key, the route must call clearReviewCache() so that the
 * next public request to GET /public/google-reviews re-fetches fresh data
 * instead of serving stale credentials.
 *
 * Contract under test:
 *  - PUT /v1/settings with googleReviews → clearReviewCache() is invoked;
 *  - PUT /v1/settings WITHOUT googleReviews → clearReviewCache() is NOT invoked.
 */

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db, organizationsTable, usersTable } from "@workspace/db";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { createSession } from "../../lib/auth";

// Mock clearReviewCache before the app (and its route modules) are imported.
// Vitest hoists vi.mock() calls, so this spy is in place when settings.ts
// pulls in "./google-reviews".
vi.mock("./google-reviews", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./google-reviews")>();
  return {
    ...original,
    clearReviewCache: vi.fn(),
  };
});

// Import after mocking so the mocked version is wired into the route.
const { clearReviewCache } = await import("./google-reviews");
const clearReviewCacheMock = clearReviewCache as ReturnType<typeof vi.fn>;

// Import app after the mock is registered.
const { default: app } = await import("../../app");

let server: Server;
let baseUrl: string;
let org: { id: string };
let adminSid: string;

async function api(method: string, path: string, body?: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${adminSid}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

beforeAll(async () => {
  const [o] = await db
    .insert(organizationsTable)
    .values({
      name: "GoogleReviews Cache Test Org",
      slug: `gr-cache-test-${Date.now()}`,
    })
    .returning();
  org = o;

  const [u] = await db
    .insert(usersTable)
    .values({
      email: `gr-cache-admin-${Date.now()}@example.com`,
      organizationId: org.id,
      role: "admin",
    })
    .returning();

  adminSid = await createSession({
    user: {
      id: u.id,
      email: null,
      firstName: null,
      lastName: null,
      profileImageUrl: null,
    },
    access_token: "test-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterEach(() => {
  clearReviewCacheMock.mockClear();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteTestOrgs(org.id);
});

describe("clearReviewCache on settings update", () => {
  it("calls clearReviewCache when googleReviews is included in the PATCH body", async () => {
    const res = await api("PUT", "/v1/settings", {
      googleReviews: {
        placeId: "ChIJN1t_tDeuEmsRUsoyG83frY4",
        apiKey: "AIzaTEST",
      },
    });
    expect(res.status).toBe(200);
    expect(clearReviewCacheMock).toHaveBeenCalledOnce();
  });

  it("calls clearReviewCache when googleReviews is present but empty", async () => {
    const res = await api("PUT", "/v1/settings", {
      googleReviews: {},
    });
    expect(res.status).toBe(200);
    expect(clearReviewCacheMock).toHaveBeenCalledOnce();
  });

  it("does NOT call clearReviewCache when googleReviews is absent from the body", async () => {
    const res = await api("PUT", "/v1/settings", {
      businessProfile: { businessName: "Test Roofing" },
    });
    expect(res.status).toBe(200);
    expect(clearReviewCacheMock).not.toHaveBeenCalled();
  });
});
