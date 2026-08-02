import { db, rateLimitCountersTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { consumeCooldown, createFailureLimiter, rateLimit } from "./rateLimit";

/**
 * The shared rate-limit counters live in the database. If that table is
 * unavailable, public endpoints must stay reachable (rateLimit fails open)
 * and the failure limiter must still block via its local cache.
 */

function fakeReqRes() {
  const req = {
    ip: "192.0.2.55",
    socket: { remoteAddress: "192.0.2.55" },
  } as unknown as Request;
  let statusCode: number | undefined;
  let body: unknown;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
  } as unknown as Response;
  return { req, res, getStatus: () => statusCode, getBody: () => body };
}

function breakSharedCounter() {
  // incrementShared starts with db.insert(...); make it blow up like an outage.
  return vi.spyOn(db, "insert").mockImplementation(() => {
    throw new Error("connection refused (simulated rate-limit db outage)");
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rate limiting after the shared counter database recovers", () => {
  it("rateLimit middleware resumes enforcing 429 once the database is back", async () => {
    const insertSpy = breakSharedCounter();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const middleware = rateLimit({
      windowMs: 60_000,
      max: 2,
      key: "recovery-ratelimit",
    });

    // During the outage every request passes regardless of count.
    for (let i = 0; i < 3; i++) {
      const { req, res, getStatus } = fakeReqRes();
      const next = vi.fn() as NextFunction;
      middleware(req, res, next);
      await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
      expect(getStatus()).toBeUndefined();
    }

    // Simulate recovery: restore the real insert so the shared counter works again.
    insertSpy.mockRestore();

    // After recovery the shared counter starts fresh for this IP/key pair.
    // Requests 1 and 2 are within the budget (count 1 and 2, not > max 2).
    for (let i = 0; i < 2; i++) {
      const { req, res, getStatus } = fakeReqRes();
      const next = vi.fn() as NextFunction;
      middleware(req, res, next);
      await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
      expect(getStatus()).toBeUndefined();
    }

    // The 3rd request after recovery pushes count to 3 which is > max 2 → 429.
    const { req, res, getStatus } = fakeReqRes();
    const next = vi.fn() as NextFunction;
    middleware(req, res, next);
    await vi.waitFor(() => expect(getStatus()).toBe(429));
    expect(next).not.toHaveBeenCalled();
  });

  it("createFailureLimiter resumes reconciling with the shared counter after recovery", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const insertSpy = breakSharedCounter();
    const limiter = createFailureLimiter({
      windowMs: 60_000,
      max: 3,
      scope: `recovery-failure-${Date.now()}`,
    });
    const id = "198.51.100.77";

    // Two failures during the outage — tracked in local cache only.
    expect(await limiter.recordFailure(id)).toBe(false);
    expect(await limiter.recordFailure(id)).toBe(false);
    expect(limiter.isBlocked(id)).toBe(false);
    // db.insert was attempted but threw; error was logged for each attempt.
    expect(insertSpy).toHaveBeenCalled();
    const errorCallsAtOutageEnd = errorSpy.mock.calls.length;
    expect(errorCallsAtOutageEnd).toBeGreaterThanOrEqual(2);

    // Simulate recovery: restore the real insert so db.insert works again.
    insertSpy.mockRestore();
    // Spy on db.insert (non-throwing) to confirm it is called successfully.
    const recoveryInsertSpy = vi.spyOn(db, "insert");

    // The third failure after recovery should:
    //   • write successfully to the shared counter (db.insert called, no new error),
    //   • reconcile the local count with the shared value,
    //   • cross the threshold and return true.
    expect(await limiter.recordFailure(id)).toBe(true);
    expect(limiter.isBlocked(id)).toBe(true);
    // db.insert was invoked (shared counter write happened after recovery).
    expect(recoveryInsertSpy).toHaveBeenCalled();
    // No new console.error calls after recovery — the shared write succeeded.
    expect(errorSpy.mock.calls.length).toBe(errorCallsAtOutageEnd);
  });
});

describe("isBlockedShared — fresh instance detects a cluster-wide block without recordFailure", () => {
  it("returns true for an id blocked in the DB even before any recordFailure call", async () => {
    const scope = `isblocked-shared-test-${Date.now()}`;
    const opts = { windowMs: 60_000, max: 3, scope };
    const id = "203.0.113.99";

    // Limiter A: the original instance records enough failures to reach threshold.
    const limiterA = createFailureLimiter(opts);
    expect(await limiterA.recordFailure(id)).toBe(false); // 1st failure
    expect(await limiterA.recordFailure(id)).toBe(false); // 2nd failure
    expect(await limiterA.recordFailure(id)).toBe(true);  // 3rd failure — crosses threshold
    expect(limiterA.isBlocked(id)).toBe(true);

    // Limiter B: simulates a restarted instance — fresh local cache, same scope.
    const limiterB = createFailureLimiter(opts);

    // Synchronous isBlocked sees nothing (local cache is empty).
    expect(limiterB.isBlocked(id)).toBe(false);

    // isBlockedShared falls back to the DB and must return true immediately,
    // without needing a preceding recordFailure call.
    expect(await limiterB.isBlockedShared(id)).toBe(true);

    // After isBlockedShared hydrated the local cache, isBlocked is also true.
    expect(limiterB.isBlocked(id)).toBe(true);

    // Cleanup shared DB rows so this test doesn't pollute others.
    limiterA.reset();
  });

  it("returns false (fails open) when the DB is unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Break db.select to simulate a DB outage during isBlockedShared.
    vi.spyOn(db, "select").mockImplementation(() => {
      throw new Error("connection refused (simulated outage)");
    });

    const limiter = createFailureLimiter({
      windowMs: 60_000,
      max: 3,
      scope: `isblocked-shared-outage-${Date.now()}`,
    });
    // No local entry, DB unavailable — must fail open.
    expect(await limiter.isBlockedShared("10.0.0.1")).toBe(false);
  });
});

describe("createFailureLimiter warmUp — fresh instance pre-loads blocked ids from the DB", () => {
  it("isBlocked returns true after warmUpPromise resolves, without any recordFailure call", async () => {
    const scope = `warmup-test-${Date.now()}`;
    const opts = { windowMs: 60_000, max: 3, scope };
    const id = "203.0.113.77";

    // Limiter A: an existing instance that has already blocked the id.
    const limiterA = createFailureLimiter(opts);
    expect(await limiterA.recordFailure(id)).toBe(false); // 1st failure
    expect(await limiterA.recordFailure(id)).toBe(false); // 2nd failure
    expect(await limiterA.recordFailure(id)).toBe(true);  // 3rd — crosses threshold
    expect(limiterA.isBlocked(id)).toBe(true);

    // Limiter B: a freshly started instance with warmUp enabled.
    const limiterB = createFailureLimiter({ ...opts, warmUp: true });

    // Before the warm-up promise resolves the local cache is still empty.
    expect(limiterB.isBlocked(id)).toBe(false);

    // After awaiting the warm-up, the blocked id is in the local cache and
    // isBlocked (synchronous) must return true — no recordFailure call needed.
    await limiterB.warmUpPromise;
    expect(limiterB.isBlocked(id)).toBe(true);

    // Cleanup shared DB rows so this test doesn't pollute others.
    limiterA.reset();
  });

  it("warmUpPromise resolves cleanly (fails open) when the DB is unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Break db.select to simulate a DB outage during warm-up.
    vi.spyOn(db, "select").mockImplementation(() => {
      throw new Error("connection refused (simulated outage)");
    });

    const limiter = createFailureLimiter({
      windowMs: 60_000,
      max: 3,
      scope: `warmup-outage-${Date.now()}`,
      warmUp: true,
    });

    // Must resolve without throwing even when the DB is down.
    await expect(limiter.warmUpPromise).resolves.toBeUndefined();
    // Local cache stays empty — isBlocked is false (fail-open).
    expect(limiter.isBlocked("10.0.0.1")).toBe(false);
  });

  it("warm-up ignores expired rows that haven't been pruned yet", async () => {
    // The opportunistic pruner only removes rows older than 1 day, so rows
    // whose resetAt is in the recent past (expired but within the pruning
    // window) can still exist in the DB.  The warm-up query must skip them
    // via its `resetAt > now()` predicate so they don't pollute the local
    // cache with phantom blocks.
    const scope = `warmup-expired-${Date.now()}`;
    const max = 3;
    const id = "203.0.113.55";

    // Derive the exact DB key the warm-up query will look for.
    // generation is 0 on a fresh limiter; testKeySuffix is `:test-<pid>`.
    const testKeySuffix = `:test-${process.pid}`;
    const dbKey = `${scope}${testKeySuffix}:0:${id}`;

    // Insert a row that is expired (resetAt in the past) but still within
    // the 1-day pruning window, and with count >= max so it looks like a
    // block to any query that ignores the expiry.
    const expiredResetAt = new Date(Date.now() - 60_000); // 1 minute ago
    await db
      .insert(rateLimitCountersTable)
      .values({ key: dbKey, count: max, resetAt: expiredResetAt });

    try {
      // Create a fresh limiter with warmUp enabled — same scope, so it will
      // scan for rows matching the prefix.
      const limiter = createFailureLimiter({ windowMs: 60_000, max, scope, warmUp: true });

      // Before warm-up resolves the local cache is empty.
      expect(limiter.isBlocked(id)).toBe(false);

      // After warm-up the expired row must NOT have been loaded.
      await limiter.warmUpPromise;
      expect(limiter.isBlocked(id)).toBe(false);
    } finally {
      // Clean up the manually inserted row.
      await db
        .delete(rateLimitCountersTable)
        .where(sql`${rateLimitCountersTable.key} = ${dbKey}`);
    }
  });
});

describe("blocked IPs survive a simulated API server restart", () => {
  it("a fresh limiter with the same scope picks up an existing block after one reconciliation call", async () => {
    const scope = `restart-test-${Date.now()}`;
    const opts = { windowMs: 60_000, max: 3, scope };
    const id = "203.0.113.42";

    // Limiter A: the original instance records enough failures to reach the block threshold.
    const limiterA = createFailureLimiter(opts);
    expect(await limiterA.recordFailure(id)).toBe(false); // 1st failure
    expect(await limiterA.recordFailure(id)).toBe(false); // 2nd failure
    expect(await limiterA.recordFailure(id)).toBe(true); // 3rd failure — crosses threshold
    expect(limiterA.isBlocked(id)).toBe(true);

    // Limiter B: simulates a restarted instance — fresh local cache, same scope.
    const limiterB = createFailureLimiter(opts);
    // Before any reconciliation the local cache is empty, so isBlocked is false.
    expect(limiterB.isBlocked(id)).toBe(false);

    // A single recordFailure triggers incrementShared, which returns the shared
    // count (>= max). The reconciliation loop adopts that count, so isBlocked
    // is true immediately after the await.
    await limiterB.recordFailure(id);
    expect(limiterB.isBlocked(id)).toBe(true);

    // Cleanup shared DB rows so this test doesn't pollute others.
    limiterA.reset();
  });
});

describe("consumeCooldown budget survives a simulated API server restart", () => {
  it("a second independent consumeCooldown call with the same key sees the spent budget and returns allowed: false", async () => {
    const key = `cooldown-restart-test-${Date.now()}`;
    const opts = { key, windowMs: 60_000, max: 1 };

    // First call: spends the only slot in the window.
    const first = await consumeCooldown(opts);
    expect(first.allowed).toBe(true);

    // Second call: simulates a fresh function invocation after an API server
    // restart. The shared DB row already has count = 1, which is > max (1),
    // so the cooldown must be enforced.
    const second = await consumeCooldown(opts);
    expect(second.allowed).toBe(false);
    expect(second.retryAfterMs).toBeGreaterThan(0);

    // Cleanup: remove the shared DB row so this test doesn't pollute others.
    await db
      .delete(rateLimitCountersTable)
      .where(sql`${rateLimitCountersTable.key} like ${`${key}%`}`);
  });
});

describe("rate limiting when the shared counter database is down", () => {
  it("rateLimit middleware fails open and lets requests through", async () => {
    const insertSpy = breakSharedCounter();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const middleware = rateLimit({ windowMs: 60_000, max: 1, key: "outage" });

    // Well past the configured max — every request must still pass through.
    for (let i = 0; i < 5; i++) {
      const { req, res, getStatus } = fakeReqRes();
      const next = vi.fn() as NextFunction;
      middleware(req, res, next);
      await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
      expect(getStatus()).toBeUndefined();
    }
    expect(insertSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("failing open"),
      expect.any(Error),
    );
  });

  it("consumeCooldown fails open and returns allowed: true", async () => {
    breakSharedCounter();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await consumeCooldown({
      key: `outage-cooldown-${Date.now()}`,
      windowMs: 60_000,
      max: 1,
    });

    expect(result.allowed).toBe(true);
    expect(result.retryAfterMs).toBe(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("failing open"),
      expect.any(Error),
    );
  });

  it("createFailureLimiter still blocks via its local cache", async () => {
    breakSharedCounter();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const limiter = createFailureLimiter({
      windowMs: 60_000,
      max: 3,
      scope: `outage-fail-${Date.now()}`,
    });
    const id = "198.51.100.99";

    expect(await limiter.recordFailure(id)).toBe(false);
    expect(await limiter.recordFailure(id)).toBe(false);
    expect(limiter.isBlocked(id)).toBe(false);
    // Third failure crosses the threshold exactly once...
    expect(await limiter.recordFailure(id)).toBe(true);
    // ...and the id is now blocked purely from the local cache.
    expect(limiter.isBlocked(id)).toBe(true);
    // Further failures don't re-signal the threshold crossing.
    expect(await limiter.recordFailure(id)).toBe(false);
    expect(limiter.isBlocked(id)).toBe(true);
    // Other ids remain unaffected.
    expect(limiter.isBlocked("198.51.100.100")).toBe(false);
  });
});
