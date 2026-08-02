/**
 * Confirms that the Google Places API key is preserved end-to-end after a
 * masked-sentinel round-trip through PUT /v1/settings.
 *
 * Scenario:
 *  1. Admin saves a real API key via PUT /v1/settings.
 *  2. Admin reads settings (GET) — receives the masked sentinel.
 *  3. Admin saves again with the masked sentinel (typical UI behaviour when the
 *     key field is not edited).
 *  4. GET /v1/public/google-reviews is called — the route must resolve the
 *     original (preserved) key from org settings and pass it to Google Places,
 *     NOT the sentinel string.
 *
 * Regression guard: if the preservation logic regresses and overwrites the
 * stored key with the sentinel string, step 4 would either get an error from
 * Google Places (wrong key) or pass the sentinel as-is — both caught here.
 */

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, organizationsTable, usersTable } from "@workspace/db";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import { createSession } from "../../lib/auth";

// ---------------------------------------------------------------------------
// Mock getDefaultOrganization so the google-reviews route resolves credentials
// from our test org. The return value is set in beforeAll once the org exists.
// ---------------------------------------------------------------------------
const mockGetDefaultOrg = vi.fn();
vi.mock("../../services/org", () => ({
  getDefaultOrganization: mockGetDefaultOrg,
}));

// ---------------------------------------------------------------------------
// Intercept globalThis.fetch so Google Places calls never hit the network.
// Save the real fetch first so requests to the local test server still work.
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch.bind(globalThis);

/** The raw API key we expect the route to forward to Google Places. */
const RAW_KEY = "AIzaPreserveRoundTripTest1234567890ABCD";
const PLACE_ID = "ChIJRoundTripPreserveTestPlace";

const FAKE_PLACES_RESPONSE = {
  status: "OK",
  result: {
    reviews: [
      {
        author_name: "Carol Davis",
        rating: 5,
        relative_time_description: "2 weeks ago",
        text: "Superb roofing work — highly recommend!",
        profile_photo_url: null,
      },
    ],
  },
};

/** Tracks which API key the route passed to Google Places on the last call. */
let capturedApiKey: string | undefined;

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: Parameters<typeof realFetch>[0], init?: Parameters<typeof realFetch>[1]) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("maps.googleapis.com")) {
      const match = url.match(/[?&]key=([^&]+)/);
      capturedApiKey = match ? decodeURIComponent(match[1]) : undefined;
      return {
        ok: true,
        json: async () => FAKE_PLACES_RESPONSE,
      } as Response;
    }
    // Pass non-Google requests through to the real fetch (e.g. local server).
    return realFetch(input, init);
  }),
);

// Import route modules after mocks are registered.
const { clearReviewCache } = await import("./google-reviews");
const { default: app } = await import("../../app");

// ---------------------------------------------------------------------------
// Shared server / fixtures
// ---------------------------------------------------------------------------
let server: Server;
let baseUrl: string;
let org: { id: string };
let adminSid: string;

async function api(method: string, path: string, sid: string, body?: unknown) {
  return realFetch(`${baseUrl}${path}`, {
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
      name: "API Key Round-Trip Test Org",
      slug: `api-key-rt-${Date.now()}`,
    })
    .returning();
  org = o;

  // Wire the mock so the google-reviews route resolves this org's settings.
  mockGetDefaultOrg.mockResolvedValue({ id: org.id });

  const [adminUser] = await db
    .insert(usersTable)
    .values({
      email: `api-key-rt-admin-${Date.now()}@example.com`,
      organizationId: org.id,
      role: "admin",
    })
    .returning();

  adminSid = await createSession({
    user: {
      id: adminUser.id,
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

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteTestOrgs(org.id);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("API key preservation after masked-sentinel round-trip", () => {
  it("stores the original key, round-trips with the masked sentinel, and google-reviews still fetches with the original key", async () => {
    // Step 1: Save a real API key.
    const saveRes = await api("PUT", "/v1/settings", adminSid, {
      googleReviews: { placeId: PLACE_ID, apiKey: RAW_KEY },
    });
    expect(saveRes.status, "initial PUT must succeed").toBe(200);

    // Step 2: GET settings — the admin should receive the masked sentinel.
    const getRes = await api("GET", "/v1/settings", adminSid);
    expect(getRes.status).toBe(200);
    const { googleReviews } = (await getRes.json()) as {
      googleReviews?: { apiKey?: string; placeId?: string };
    };
    expect(googleReviews?.apiKey, "admin must see a masked key").toContain("••••");
    const maskedSentinel = googleReviews!.apiKey!;

    // Step 3: PUT settings again with the masked sentinel — simulating the UI
    // submitting an unchanged key field (masked) along with other settings.
    const roundTripRes = await api("PUT", "/v1/settings", adminSid, {
      googleReviews: { placeId: PLACE_ID, apiKey: maskedSentinel },
    });
    expect(roundTripRes.status, "round-trip PUT must succeed").toBe(200);
    const roundTripBody = (await roundTripRes.json()) as {
      googleReviews?: { apiKey?: string };
    };
    // The PUT response must still return a masked key (not the raw value).
    expect(
      roundTripBody.googleReviews?.apiKey,
      "PUT response must return a masked key",
    ).toContain("••••");

    // Step 4: Bust the in-process cache so the route re-fetches from the DB,
    // then call the public reviews endpoint.
    clearReviewCache();
    capturedApiKey = undefined;

    const reviewsRes = await realFetch(`${baseUrl}/v1/public/google-reviews`);
    expect(reviewsRes.status).toBe(200);
    const reviewsBody = (await reviewsRes.json()) as {
      reviews: unknown[];
      isFallback: boolean;
    };

    // The route must return real reviews (not the fallback empty list).
    expect(reviewsBody.isFallback, "must not be in fallback mode").toBe(false);
    expect(reviewsBody.reviews.length, "must return at least one review").toBeGreaterThan(0);

    // The key forwarded to Google Places must be the original raw key.
    expect(capturedApiKey, "must forward the original API key to Google Places").toBe(RAW_KEY);
    expect(capturedApiKey, "must not forward the mask sentinel to Google Places").not.toContain("••••");
  });

  it("confirms GET /v1/settings after the round-trip still shows a masked key (stored key intact)", async () => {
    // Re-save the key to ensure a clean state for this assertion.
    await api("PUT", "/v1/settings", adminSid, {
      googleReviews: { placeId: PLACE_ID, apiKey: RAW_KEY },
    });

    // Read, get the sentinel, round-trip PUT.
    const getRes = await api("GET", "/v1/settings", adminSid);
    const { googleReviews: gr1 } = (await getRes.json()) as {
      googleReviews?: { apiKey?: string; placeId?: string };
    };
    const sentinel = gr1!.apiKey!;

    await api("PUT", "/v1/settings", adminSid, {
      googleReviews: { placeId: PLACE_ID, apiKey: sentinel },
    });

    // Subsequent GET must still show a masked key — the stored value is intact.
    const afterRes = await api("GET", "/v1/settings", adminSid);
    expect(afterRes.status).toBe(200);
    const { googleReviews: gr2 } = (await afterRes.json()) as {
      googleReviews?: { apiKey?: string };
    };
    expect(gr2?.apiKey, "key must still be present and masked after round-trip").toContain("••••");
    expect(gr2?.apiKey).not.toBe(RAW_KEY);
  });
});
