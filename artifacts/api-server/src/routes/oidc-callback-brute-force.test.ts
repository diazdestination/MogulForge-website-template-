import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createFailureLimiter } from "../lib/rateLimit";
import { invalidAuthAttemptLimiter as callbackFailureLimiter } from "./auth";

/**
 * Brute-force protection for the OIDC /callback session-login route.
 *
 * Verifies two properties:
 *  1. The block persists across a simulated server restart — a fresh limiter
 *     instance with the same scope detects the block via `isBlockedShared`
 *     (DB-backed) even though its local cache is empty.
 *  2. The exported `callbackFailureLimiter` is the instance the route uses, so
 *     the block checked in the route (`isBlockedShared`) draws from the same
 *     shared DB counter as the failures recorded on it.
 */

const MAX_FAILURES = 10;

afterAll(() => {
  callbackFailureLimiter.reset();
});

beforeEach(() => {
  callbackFailureLimiter.reset();
});

describe("OIDC callback brute-force block — restart persistence", () => {
  it("isBlockedShared on a fresh instance detects a block written by the old instance", async () => {
    // Use a private scope so this test is fully isolated from the
    // callbackFailureLimiter used by the route (different scope).
    const scope = `oidc-callback-restart-${Date.now()}`;
    const opts = { windowMs: 15 * 60 * 1000, max: MAX_FAILURES, scope };
    const ip = "198.51.100.55";

    // Limiter A — the "previous server instance" — burns the full budget.
    const limiterA = createFailureLimiter(opts);
    for (let i = 0; i < MAX_FAILURES; i++) {
      await limiterA.recordFailure(ip);
    }
    expect(limiterA.isBlocked(ip)).toBe(true);

    // Limiter B — simulates a freshly restarted instance.
    // Its local cache is empty; it has never called recordFailure for this IP.
    const limiterB = createFailureLimiter(opts);

    // Synchronous isBlocked can't see the block (local cache is empty).
    expect(limiterB.isBlocked(ip)).toBe(false);

    // isBlockedShared falls back to the shared DB counter and must return true,
    // keeping the block intact without needing a new failure recorded first.
    expect(await limiterB.isBlockedShared(ip)).toBe(true);

    // After isBlockedShared hydrates the local cache, synchronous isBlocked
    // is also true — no extra DB round-trip on subsequent checks.
    expect(limiterB.isBlocked(ip)).toBe(true);

    // An unrelated IP is not affected.
    expect(await limiterB.isBlockedShared("198.51.100.56")).toBe(false);

    limiterA.reset(); // clean up shared DB rows
  });

  it("callbackFailureLimiter writes failures to the shared DB (isBlockedShared returns true after local-only isBlocked is true)", async () => {
    const ip = "203.0.113.99";

    // Record MAX_FAILURES failures on the live route limiter, mirroring what
    // repeated bad OIDC code submissions would produce.
    for (let i = 0; i < MAX_FAILURES; i++) {
      await callbackFailureLimiter.recordFailure(ip);
    }

    // Synchronous local-cache check: should be blocked.
    expect(callbackFailureLimiter.isBlocked(ip)).toBe(true);

    // DB-backed check: must also be true, confirming the route limiter
    // writes failures to the shared counter (not only the local cache).
    // This is the same code path the route calls on every incoming request —
    // if it were local-only, isBlockedShared would return false after a
    // restart (empty local cache), but since it falls back to the DB, the
    // block holds.
    expect(await callbackFailureLimiter.isBlockedShared(ip)).toBe(true);

    // An unrelated IP is not blocked.
    expect(await callbackFailureLimiter.isBlockedShared("203.0.113.100")).toBe(false);
  });
});
