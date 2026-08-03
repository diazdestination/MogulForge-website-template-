import { apiIdempotencyKeysTable, db } from "@workspace/db";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Request, Response } from "express";

/**
 * Idempotency for the programmatic lead API (`x-idempotency-key` header),
 * using a reserve-first ("first writer owns the key") pattern so CONCURRENT
 * retries can never both execute side effects:
 *
 *   1. `beginIdempotent` atomically reserves the key (placeholder row,
 *      responseStatus 0). Exactly one request wins the insert and proceeds.
 *   2. Losers poll briefly: once the winner stores its response they replay
 *      it verbatim; if the winner is still running after the poll budget
 *      they get 409 (retry later) instead of duplicating work.
 *   3. `storeIdempotent` fills in the real response for future replays.
 *
 * A placeholder older than STALE_MS (winner crashed mid-flight) can be
 * claimed by a later retry so keys never wedge permanently.
 *
 * Usage in a route:
 *   if (!(await beginIdempotent(req, res, "leads.create"))) return; // handled
 *   ... do the work ...
 *   await storeIdempotent(req, "leads.create", 201, body);
 *   res.status(201).json(body);
 */

const PENDING_STATUS = 0;
const STALE_MS = 60_000;
const POLL_INTERVAL_MS = 150;
const POLL_ATTEMPTS = 20; // ~3s

export function idempotencyKeyFrom(req: Request): string | null {
  const raw = req.headers["x-idempotency-key"];
  const key = typeof raw === "string" ? raw.trim().slice(0, 200) : null;
  return key || null;
}

function replay(
  res: Response,
  row: { responseStatus: number; responseBody: unknown },
): void {
  res
    .status(row.responseStatus)
    .setHeader("X-Idempotent-Replay", "true")
    .json(row.responseBody);
}

/**
 * Reserve the idempotency key or handle the request from a prior reservation.
 * Returns true when the caller should proceed with the actual work; false
 * when the response has already been written (replay or 409).
 */
export async function beginIdempotent(
  req: Request,
  res: Response,
  scope: string,
): Promise<boolean> {
  const key = idempotencyKeyFrom(req);
  if (!key) return true;
  const organizationId = req.member!.organizationId;

  const inserted = await db
    .insert(apiIdempotencyKeysTable)
    .values({
      organizationId,
      scope,
      key,
      responseStatus: PENDING_STATUS,
      responseBody: {},
    })
    .onConflictDoNothing()
    .returning({ id: apiIdempotencyKeysTable.id });
  if (inserted.length > 0) return true; // we own the key

  const where = and(
    eq(apiIdempotencyKeysTable.organizationId, organizationId),
    eq(apiIdempotencyKeysTable.scope, scope),
    eq(apiIdempotencyKeysTable.key, key),
  );
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    const [row] = await db.select().from(apiIdempotencyKeysTable).where(where);
    if (!row) return true; // reservation vanished (crashed owner cleaned up)
    if (row.responseStatus !== PENDING_STATUS) {
      replay(res, row);
      return false;
    }
    // Stale placeholder: the original owner died mid-flight. Claim it by
    // bumping createdAt under a guard so only one contender takes over.
    if (Date.now() - row.createdAt.getTime() > STALE_MS) {
      const claimed = await db
        .update(apiIdempotencyKeysTable)
        .set({ createdAt: sql`now()` })
        .where(
          and(
            eq(apiIdempotencyKeysTable.id, row.id),
            eq(apiIdempotencyKeysTable.responseStatus, PENDING_STATUS),
            lt(apiIdempotencyKeysTable.createdAt, new Date(Date.now() - STALE_MS)),
          ),
        )
        .returning({ id: apiIdempotencyKeysTable.id });
      if (claimed.length > 0) return true;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  res.status(409).json({
    error:
      "A request with this idempotency key is still being processed — retry shortly",
  });
  return false;
}

/** Fill in the reserved key with the real response for future replays. */
export async function storeIdempotent(
  req: Request,
  scope: string,
  responseStatus: number,
  responseBody: unknown,
): Promise<void> {
  const key = idempotencyKeyFrom(req);
  if (!key) return;
  try {
    await db
      .update(apiIdempotencyKeysTable)
      .set({ responseStatus, responseBody })
      .where(
        and(
          eq(apiIdempotencyKeysTable.organizationId, req.member!.organizationId),
          eq(apiIdempotencyKeysTable.scope, scope),
          eq(apiIdempotencyKeysTable.key, key),
          eq(apiIdempotencyKeysTable.responseStatus, PENDING_STATUS),
        ),
      );
  } catch (err) {
    console.error("[idempotency] failed to store response:", err);
  }
}

/** Release a reservation when the work failed (so a retry can run it again). */
export async function releaseIdempotent(req: Request, scope: string): Promise<void> {
  const key = idempotencyKeyFrom(req);
  if (!key) return;
  try {
    await db
      .delete(apiIdempotencyKeysTable)
      .where(
        and(
          eq(apiIdempotencyKeysTable.organizationId, req.member!.organizationId),
          eq(apiIdempotencyKeysTable.scope, scope),
          eq(apiIdempotencyKeysTable.key, key),
          eq(apiIdempotencyKeysTable.responseStatus, PENDING_STATUS),
        ),
      );
  } catch (err) {
    console.error("[idempotency] failed to release key:", err);
  }
}
