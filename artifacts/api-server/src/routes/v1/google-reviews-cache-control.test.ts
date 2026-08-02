/**
 * Verifies that the `reviewCacheJustCleared` flag causes the first successful
 * response after a credentials change to carry `Cache-Control: no-cache`, and
 * that subsequent responses (served from the warm in-process cache) revert to
 * `Cache-Control: public, max-age=3600`.
 *
 * Contract under test (google-reviews.ts):
 *  - After clearReviewCache() the next GET /public/google-reviews response
 *    must include `Cache-Control: no-cache`.
 *  - A subsequent GET (same warm cache, flag already consumed) must include
 *    `Cache-Control: public, max-age=3600`.
 */

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock org / settings services so the route resolves credentials without a DB.
// These must be hoisted before the app (and route modules) are imported.
// ---------------------------------------------------------------------------
vi.mock("../../services/org", () => ({
  getDefaultOrganization: vi.fn().mockResolvedValue({ id: "test-org-id" }),
}));

vi.mock("../../services/settings", () => ({
  getOrgSettings: vi.fn().mockResolvedValue({
    googleReviews: {
      apiKey: "AIzaFakeKeyForTesting",
      placeId: "ChIJTestPlaceId",
    },
  }),
  // Other exports used elsewhere — provide safe no-ops so the app boots.
  updateOrgSettings: vi.fn(),
  getInspectionAvailability: vi.fn().mockResolvedValue({}),
}));

// ---------------------------------------------------------------------------
// Stub global fetch so the route never calls the real Google Places API.
// Save the real fetch first so test requests to the local server still work.
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch.bind(globalThis);

const FAKE_GOOGLE_RESPONSE = {
  status: "OK",
  result: {
    reviews: [
      {
        author_name: "Alice Smith",
        rating: 5,
        relative_time_description: "a week ago",
        text: "Great service!",
        profile_photo_url: null,
      },
    ],
  },
};

vi.stubGlobal(
  "fetch",
  vi.fn().mockResolvedValue({
    ok: true,
    json: async () => FAKE_GOOGLE_RESPONSE,
  }),
);

// ---------------------------------------------------------------------------
// Import app + clearReviewCache AFTER the mocks are in place.
// ---------------------------------------------------------------------------
const { clearReviewCache } = await import("./google-reviews");
const { default: app } = await import("../../app");

// ---------------------------------------------------------------------------
// Shared server
// ---------------------------------------------------------------------------
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("Cache-Control header after clearReviewCache()", () => {
  it("responds with Cache-Control: no-cache for the first request after cache is cleared", async () => {
    // Simulate a credentials change: clear the cache and set the flag.
    clearReviewCache();

    const res = await realFetch(`${baseUrl}/v1/public/google-reviews`);

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");

    const body = (await res.json()) as { reviews: unknown[]; isFallback: boolean };
    expect(body.isFallback).toBe(false);
    expect(body.reviews).toHaveLength(1);
  });

  it("responds with Cache-Control: public, max-age=3600 for a subsequent request (flag already consumed)", async () => {
    // No clearReviewCache() call — the flag should have been consumed in the
    // previous request and the in-process cache is now warm.
    const res = await realFetch(`${baseUrl}/v1/public/google-reviews`);

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");

    const body = (await res.json()) as { reviews: unknown[]; isFallback: boolean };
    expect(body.isFallback).toBe(false);
  });
});
