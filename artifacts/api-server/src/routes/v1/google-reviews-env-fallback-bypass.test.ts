/**
 * Confirms that clearing the stored Google Places API key (submitting an empty
 * apiKey so the org settings row has googleReviews.apiKey absent/null) prevents
 * the google-reviews route from silently falling back to the
 * GOOGLE_PLACES_API_KEY environment variable.
 *
 * This is distinct from the "no credentials" path where the org has no
 * googleReviews settings entry at all (env var fallback IS allowed there).
 *
 * Contract under test (google-reviews.ts):
 *  - Org has a googleReviews settings entry with placeId set but apiKey empty.
 *  - GOOGLE_PLACES_API_KEY is present in the environment.
 *  - GET /v1/public/google-reviews must return isFallback: true and no reviews.
 *  - The Google Places API must NOT be called (env var not used).
 */

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock org / settings services — must be hoisted before app import.
// ---------------------------------------------------------------------------
const mockGetOrgSettings = vi.fn();

vi.mock("../../services/org", () => ({
  getDefaultOrganization: vi.fn().mockResolvedValue({ id: "test-org-cleared-key" }),
}));

vi.mock("../../services/settings", () => ({
  getOrgSettings: mockGetOrgSettings,
  updateOrgSettings: vi.fn(),
  getInspectionAvailability: vi.fn().mockResolvedValue({}),
}));

// ---------------------------------------------------------------------------
// Stub global fetch — track whether Google Places was called.
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch.bind(globalThis);
let googlePlacesCalled = false;

vi.stubGlobal(
  "fetch",
  vi.fn(
    async (
      input: Parameters<typeof realFetch>[0],
      init?: Parameters<typeof realFetch>[1],
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("maps.googleapis.com")) {
        googlePlacesCalled = true;
        // Return a successful response — if the route calls this it is a bug.
        return {
          ok: true,
          json: async () => ({ status: "OK", result: { reviews: [] } }),
        } as Response;
      }
      return realFetch(input, init);
    },
  ),
);

// ---------------------------------------------------------------------------
// Import route + app AFTER mocks are in place.
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
describe("google-reviews env-var fallback bypass after key is cleared", () => {
  it("returns isFallback:true and no reviews when the org has an empty apiKey, even with GOOGLE_PLACES_API_KEY set", async () => {
    // Simulate an admin intentionally clearing the key:
    // the org has a googleReviews entry (placeId present) but apiKey is null/empty.
    mockGetOrgSettings.mockResolvedValue({
      googleReviews: { placeId: "ChIJClearedKeyTestPlace", apiKey: null },
    });

    // Ensure GOOGLE_PLACES_API_KEY is set in the environment so that
    // a buggy fallback would have a value to pick up.
    const originalEnvKey = process.env.GOOGLE_PLACES_API_KEY;
    const originalEnvPlace = process.env.GOOGLE_PLACE_ID;
    process.env.GOOGLE_PLACES_API_KEY = "AIzaEnvFallbackShouldNotBeUsed";
    process.env.GOOGLE_PLACE_ID = "ChIJEnvPlaceShouldNotBeUsed";

    // Clear in-process cache so the route re-resolves credentials from settings.
    clearReviewCache();
    googlePlacesCalled = false;

    try {
      const res = await realFetch(`${baseUrl}/v1/public/google-reviews`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { reviews: unknown[]; isFallback: boolean };
      expect(body.isFallback, "must be in fallback mode — key was cleared").toBe(true);
      expect(body.reviews, "must return an empty list — no credentials").toHaveLength(0);
      expect(googlePlacesCalled, "must not call Google Places API").toBe(false);
    } finally {
      // Restore env vars so other tests are unaffected.
      if (originalEnvKey === undefined) {
        delete process.env.GOOGLE_PLACES_API_KEY;
      } else {
        process.env.GOOGLE_PLACES_API_KEY = originalEnvKey;
      }
      if (originalEnvPlace === undefined) {
        delete process.env.GOOGLE_PLACE_ID;
      } else {
        process.env.GOOGLE_PLACE_ID = originalEnvPlace;
      }
    }
  });

  it("returns isFallback:true when apiKey is an empty string (whitespace-only), even with env var set", async () => {
    mockGetOrgSettings.mockResolvedValue({
      googleReviews: { placeId: "ChIJClearedKeyTestPlace", apiKey: "   " },
    });

    const originalEnvKey = process.env.GOOGLE_PLACES_API_KEY;
    process.env.GOOGLE_PLACES_API_KEY = "AIzaEnvFallbackShouldNotBeUsed";

    clearReviewCache();
    googlePlacesCalled = false;

    try {
      const res = await realFetch(`${baseUrl}/v1/public/google-reviews`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { reviews: unknown[]; isFallback: boolean };
      expect(body.isFallback, "whitespace-only key must also be treated as cleared").toBe(true);
      expect(body.reviews).toHaveLength(0);
      expect(googlePlacesCalled, "must not call Google Places API").toBe(false);
    } finally {
      if (originalEnvKey === undefined) {
        delete process.env.GOOGLE_PLACES_API_KEY;
      } else {
        process.env.GOOGLE_PLACES_API_KEY = originalEnvKey;
      }
    }
  });

  it("still uses env var fallback when the org has NO googleReviews settings entry at all", async () => {
    // No googleReviews entry means the org has never configured this feature —
    // env var fallback is appropriate here.
    mockGetOrgSettings.mockResolvedValue({
      googleReviews: null,
    });

    const originalEnvKey = process.env.GOOGLE_PLACES_API_KEY;
    const originalEnvPlace = process.env.GOOGLE_PLACE_ID;
    process.env.GOOGLE_PLACES_API_KEY = "AIzaEnvFallbackShouldBeUsed";
    process.env.GOOGLE_PLACE_ID = "ChIJEnvPlaceShouldBeUsed";

    clearReviewCache();
    googlePlacesCalled = false;

    try {
      const res = await realFetch(`${baseUrl}/v1/public/google-reviews`);
      expect(res.status).toBe(200);
      // Route should attempt to call Google Places (env key is used).
      expect(googlePlacesCalled, "must call Google Places using the env var key").toBe(true);
    } finally {
      if (originalEnvKey === undefined) {
        delete process.env.GOOGLE_PLACES_API_KEY;
      } else {
        process.env.GOOGLE_PLACES_API_KEY = originalEnvKey;
      }
      if (originalEnvPlace === undefined) {
        delete process.env.GOOGLE_PLACE_ID;
      } else {
        process.env.GOOGLE_PLACE_ID = originalEnvPlace;
      }
    }
  });
});
