import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db, rateLimitCountersTable } from "@workspace/db";
import { sql } from "drizzle-orm";

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

describe("OIDC callback brute-force block — window expiry", () => {
  afterEach(() => {
    // Restore real timers after every test in this suite so fake-timer leaks
    // can't affect later tests.
    vi.useRealTimers();
  });

  it("isBlocked returns false once the local window expires", async () => {
    // Use a large window so all ten DB-backed recordFailure round-trips
    // complete well before the window closes.  Vitest fake timers then
    // advance Date.now() past the window without any real waiting, keeping
    // the test fully deterministic.
    const scope = `oidc-callback-expiry-local-${Date.now()}`;
    const windowMs = 30_000;
    const opts = { windowMs, max: MAX_FAILURES, scope };
    const ip = "198.51.100.60";

    const limiter = createFailureLimiter(opts);
    for (let i = 0; i < MAX_FAILURES; i++) {
      await limiter.recordFailure(ip);
    }

    // Block is confirmed before we touch the clock.
    expect(limiter.isBlocked(ip)).toBe(true);

    // Advance Date.now() past the window — no real sleeping required.
    vi.useFakeTimers();
    vi.advanceTimersByTime(windowMs + 1_000);

    // The local bucket's resetAt is now in the past; isBlocked must evict it
    // and return false (block lifted on this instance).
    expect(limiter.isBlocked(ip)).toBe(false);

    vi.useRealTimers();
    limiter.reset();
  });

  it("isBlockedShared returns false on a fresh instance once the DB row expires", async () => {
    // Mirrors the restart-persistence test above, but after confirming the
    // block we directly expire the DB row (equivalent to the 15-minute window
    // elapsing) and verify a fresh instance no longer sees it — confirming the
    // block is truly lifted, not just absent from one instance's local cache.
    const scope = `oidc-callback-expiry-restart-${Date.now()}`;
    const windowMs = 30_000;
    const opts = { windowMs, max: MAX_FAILURES, scope };
    const ip = "198.51.100.61";

    // Limiter A — the "previous server instance" — burns the full budget.
    const limiterA = createFailureLimiter(opts);
    for (let i = 0; i < MAX_FAILURES; i++) {
      await limiterA.recordFailure(ip);
    }

    // Limiter B — fresh instance, empty local cache — detects the block via DB.
    const limiterB = createFailureLimiter(opts);
    expect(await limiterB.isBlockedShared(ip)).toBe(true);

    // Directly expire every DB row belonging to this test's scope by pushing
    // reset_at into the past.  This is the equivalent of the window elapsing
    // without having to wait for it.
    await db
      .update(rateLimitCountersTable)
      .set({ resetAt: sql`now() - interval '1 second'` })
      .where(sql`${rateLimitCountersTable.key} like ${scope + "%"}`);

    // Limiter C — another fresh instance with an empty local cache — queries
    // the DB.  readShared filters with `resetAt > now()`, so the expired row
    // is invisible and the block must be reported as lifted.
    const limiterC = createFailureLimiter(opts);
    expect(await limiterC.isBlockedShared(ip)).toBe(false);

    // An unrelated IP was never blocked.
    expect(await limiterC.isBlockedShared("198.51.100.62")).toBe(false);

    limiterA.reset();
  });
});
