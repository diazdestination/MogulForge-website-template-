import { db, rateLimitCountersTable } from "@workspace/db";
import { and, gt, sql } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

interface Bucket {
  count: number;
  resetAt: number;
}

// In tests, namespace shared counters per process so parallel vitest workers
// don't consume each other's budgets. Empty (fully shared) in production.
const testKeySuffix =
  process.env.NODE_ENV === "test" || process.env.VITEST
    ? `:test-${process.pid}`
    : "";

/**
 * Atomically increment the shared counter for `key` in the database and
 * return the current count/reset for its fixed window. Expired windows are
 * reset in place, so the row count stays bounded by distinct keys.
 */
export async function incrementShared(
  key: string,
  windowMs: number,
): Promise<Bucket> {
  const now = new Date();
  const resetAt = new Date(now.getTime() + windowMs);
  const result = await db
    .insert(rateLimitCountersTable)
    .values({ key, count: 1, resetAt })
    .onConflictDoUpdate({
      target: rateLimitCountersTable.key,
      set: {
        count: sql`case when ${rateLimitCountersTable.resetAt} <= now() then 1 else ${rateLimitCountersTable.count} + 1 end`,
        resetAt: sql`case when ${rateLimitCountersTable.resetAt} <= now() then ${resetAt.toISOString()}::timestamptz else ${rateLimitCountersTable.resetAt} end`,
      },
    })
    .returning({
      count: rateLimitCountersTable.count,
      resetAt: rateLimitCountersTable.resetAt,
    });
  const row = result[0];
  // Opportunistically prune long-expired rows (~1% of increments).
  if (Math.random() < 0.01) {
    void db
      .delete(rateLimitCountersTable)
      .where(sql`${rateLimitCountersTable.resetAt} < now() - interval '1 day'`)
      .catch(() => {});
  }
  return { count: row.count, resetAt: row.resetAt.getTime() };
}
/**
 * Fixed-window rate limiter for public endpoints, backed by the shared
 * database so limits stay accurate across instances and restarts.
 * Fails open on database errors so an outage can't take endpoints down;
 * that tradeoff is acceptable because these limits guard abuse, not auth.
 */
export function rateLimit(opts: { windowMs: number; max: number; key: string }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // req.ip is derived by Express using the app-level "trust proxy" setting,
    // so it cannot be spoofed via arbitrary X-Forwarded-For values.
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const key = `${opts.key}:${ip}${testKeySuffix}`;
    incrementShared(key, opts.windowMs)
      .then((bucket) => {
        if (bucket.count > opts.max) {
          res
            .status(429)
            .json({ error: "Too many requests, please try again later" });
          return;
        }
        next();
      })
      .catch((err) => {
        console.error("rateLimit: shared counter unavailable, failing open", err);
        next();
      });
  };
}

/**
 * Consume one attempt from a shared fixed-window cooldown identified by
 * `key`. Returns `{ allowed: true }` when this call is within budget, or
 * `{ allowed: false, retryAfterMs }` when the budget for the window is
 * already spent. Backed by the shared rate-limit table, so the cooldown
 * holds across instances and restarts. Fails open on database errors —
 * these cooldowns guard against accidental spam, not auth.
 */
export async function consumeCooldown(opts: {
  key: string;
  windowMs: number;
  max?: number;
}): Promise<{ allowed: boolean; retryAfterMs: number }> {
  try {
    const bucket = await incrementShared(
      `${opts.key}${testKeySuffix}`,
      opts.windowMs,
    );
    if (bucket.count > (opts.max ?? 1)) {
      return {
        allowed: false,
        retryAfterMs: Math.max(0, bucket.resetAt - Date.now()),
      };
    }
    return { allowed: true, retryAfterMs: 0 };
  } catch (err) {
    console.error("consumeCooldown: shared counter unavailable, failing open", err);
    return { allowed: true, retryAfterMs: 0 };
  }
}

/**
 * Read the current shared counter for `key` without incrementing it.
 * Returns null when no unexpired row exists.
 */
async function readShared(key: string): Promise<Bucket | null> {
  const rows = await db
    .select({
      count: rateLimitCountersTable.count,
      resetAt: rateLimitCountersTable.resetAt,
    })
    .from(rateLimitCountersTable)
    .where(
      and(
        sql`${rateLimitCountersTable.key} = ${key}`,
        gt(rateLimitCountersTable.resetAt, sql`now()`),
      ),
    )
    .limit(1);
  if (rows.length === 0) return null;
  return { count: rows[0].count, resetAt: rows[0].resetAt.getTime() };
}

/**
 * Fixed-window counter for *failed* attempts (e.g. invalid API keys).
 * Unlike `rateLimit`, callers record failures explicitly, so successful
 * requests are never counted and legitimate clients are unaffected.
 *
 * Counters are write-through: each failure synchronously increments a local
 * cache (so blocking is immediate on this instance) and asynchronously
 * increments a shared database row. The shared count is reconciled back into
 * the local cache, so other instances' failures against the same id are
 * picked up as soon as this instance records its own failure for that id —
 * every failed attempt anywhere counts against one shared budget, and the
 * budget survives restarts. Worst case an attacker gets a few extra attempts
 * per instance during the reconciliation race, never a full extra budget.
 */
export function createFailureLimiter(opts: {
  windowMs: number;
  max: number;
  /** Namespace for the shared database counter rows. */
  scope?: string;
  /**
   * When true, asynchronously hydrate the local cache from the database on
   * construction by loading all currently-blocked ids (count >= max, resetAt >
   * now) for this scope. Off by default — no behaviour change for existing
   * callers. Await `warmUpPromise` before relying on synchronous `isBlocked`
   * for ids that may have been blocked by another instance.
   */
  warmUp?: boolean;
}) {
  const scope = `${opts.scope ?? "failure"}${testKeySuffix}`;
  const failures = new Map<string, Bucket>();
  // Bumped by reset() so tests get a fresh shared namespace synchronously.
  // Never bumped in production, so all instances share generation 0.
  let generation = 0;

  // When warmUp is requested, immediately start loading all blocked ids from
  // the shared DB into the local cache. The promise resolves (never rejects)
  // once the hydration is done; callers can await it before serving traffic.
  const warmUpPromise: Promise<void> | undefined = opts.warmUp
    ? (async () => {
        try {
          const prefix = `${scope}:${generation}:`;
          const rows = await db
            .select({
              key: rateLimitCountersTable.key,
              count: rateLimitCountersTable.count,
              resetAt: rateLimitCountersTable.resetAt,
            })
            .from(rateLimitCountersTable)
            .where(
              and(
                sql`${rateLimitCountersTable.key} like ${prefix + "%"}`,
                gt(rateLimitCountersTable.resetAt, sql`now()`),
                sql`${rateLimitCountersTable.count} >= ${opts.max}`,
              ),
            );
          for (const row of rows) {
            const id = row.key.slice(prefix.length);
            failures.set(id, {
              count: row.count,
              resetAt: row.resetAt.getTime(),
            });
          }
        } catch (err) {
          console.error(
            "failureLimiter.warmUp: shared counter unavailable, skipping warm-up",
            err,
          );
        }
      })()
    : undefined;

  return {
    /**
     * Resolves once the initial warm-up hydration from the DB is complete.
     * Only present when the limiter was created with `warmUp: true`; undefined
     * otherwise. Await this before relying on synchronous `isBlocked` calls
     * on a freshly started instance.
     */
    warmUpPromise,
    /**
     * True when this id has exceeded the failure budget in the **local** cache.
     *
     * @deprecated **Do not use this on auth or access-control hot paths.**
     * The local cache is empty on a freshly restarted instance, so a key that
     * was blocked cluster-wide before the restart will be silently let through.
     * Use {@link isBlockedShared} instead — it falls back to the shared DB
     * counter when no local entry exists, keeping the block intact across
     * restarts and without a DB round-trip for already-cached ids.
     *
     * `isBlocked` is intentionally kept for non-auth use-cases where a stale
     * local-only check is acceptable (e.g. lightweight in-memory throttling
     * that does not guard access to protected resources).
     */
    isBlocked(id: string): boolean {
      const bucket = failures.get(id);
      if (!bucket) return false;
      if (bucket.resetAt <= Date.now()) {
        failures.delete(id);
        return false;
      }
      return bucket.count >= opts.max;
    },
    /**
     * Like `isBlocked`, but when no local entry exists for the id, falls back
     * to querying the shared DB counter. Use this on paths where a freshly
     * restarted instance might not have seen any failures yet for an id that
     * is already blocked cluster-wide. The local fast path is preserved: if a
     * local entry is present it is used without a DB round-trip. Fails open
     * (returns false) on DB errors so an outage can't take endpoints down.
     */
    async isBlockedShared(id: string): Promise<boolean> {
      const bucket = failures.get(id);
      if (bucket) {
        if (bucket.resetAt <= Date.now()) {
          failures.delete(id);
          return false;
        }
        return bucket.count >= opts.max;
      }
      // No local entry — query the shared counter without incrementing.
      try {
        const shared = await readShared(`${scope}:${generation}:${id}`);
        if (!shared) return false;
        // Hydrate the local cache so subsequent isBlocked calls are fast.
        failures.set(id, shared);
        return shared.count >= opts.max;
      } catch (err) {
        console.error("failureLimiter.isBlockedShared: shared counter unavailable, failing open", err);
        return false;
      }
    },
    /**
     * Record one failed attempt for this id. Resolves once the shared
     * counter has been updated; the local cache is updated synchronously.
     * Resolves true exactly once per window on this instance: on the
     * attempt that crosses the block threshold, so callers can alert
     * without spamming on every subsequent failure.
     */
    async recordFailure(id: string): Promise<boolean> {
      const now = Date.now();
      let bucket = failures.get(id);
      if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + opts.windowMs };
        failures.set(id, bucket);
      }
      const blockedBefore = bucket.count >= opts.max;
      bucket.count += 1;
      try {
        const shared = await incrementShared(
          `${scope}:${generation}:${id}`,
          opts.windowMs,
        );
        // Reconcile: adopt the shared window and the higher of the counts so
        // failures recorded by other instances are honored here too.
        const current = failures.get(id);
        if (current && current.resetAt > Date.now()) {
          current.count = Math.max(current.count, shared.count);
          current.resetAt = shared.resetAt;
        }
      } catch (err) {
        // Local counting still applies; shared budget catches up later.
        console.error("failureLimiter: shared counter unavailable", err);
      }
      const current = failures.get(id);
      const blockedNow = !!current && current.count >= opts.max;
      return blockedNow && !blockedBefore;
    },
    /** Test-only: forget all recorded failures (local and shared). */
    reset(): void {
      failures.clear();
      generation += 1;
      void db
        .delete(rateLimitCountersTable)
        .where(sql`${rateLimitCountersTable.key} like ${`${scope}:%`}`)
        .catch(() => {});
    },
  };
}
