import { db, usersTable, type User } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

import { hasPermission, type Permission } from "../lib/permissions";
import { createFailureLimiter, incrementShared } from "../lib/rateLimit";
import { resolveApiKey } from "../services/api-keys";
import { reportApiKeyBruteForceBlock } from "../services/security-alerts";

const INVALID_KEY_WINDOW_MS = 15 * 60 * 1000;
const INVALID_KEY_MAX_FAILURES = 10;

/** Per-key budget for programmatic API calls (requests per minute). */
const API_KEY_RATE_WINDOW_MS = 60 * 1000;
const API_KEY_RATE_MAX = 240;

/**
 * Per-IP throttle on *failed* API-key lookups so key guessing can't be
 * brute-forced. Successful key auth is never counted, so legitimate
 * clients are unaffected. Exported for tests.
 */
export const invalidApiKeyLimiter = createFailureLimiter({
  windowMs: INVALID_KEY_WINDOW_MS,
  max: INVALID_KEY_MAX_FAILURES,
});

export interface Member {
  user: User;
  organizationId: string;
  role: User["role"];
}

declare global {
  namespace Express {
    interface Request {
      member?: Member;
    }
  }
}

/**
 * Requires an authenticated session AND an active organization membership.
 * Attaches `req.member` with the org-scoped context every downstream
 * handler must use for tenant isolation.
 */
export interface RequireMemberGuard {
  (req: Request, res: Response, next: NextFunction): Promise<void>;
  /** Introspection tag used by the route-inventory test. */
  requiredPermission: Permission;
}

export function requireMember(permission: Permission): RequireMemberGuard {
  const guard = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    // API-key auth: the key acts on behalf of its creator, capped at the
    // role stored on the key. Keys can never manage settings or users.
    const rawKey =
      typeof req.header === "function"
        ? req.header("x-api-key")
        : (req.headers?.["x-api-key"] as string | undefined);
    if (rawKey) {
      // req.ip respects the app-level "trust proxy" setting.
      const ip = req.ip || req.socket?.remoteAddress || "unknown";
      // isBlockedShared falls back to the shared DB counter when the local
      // cache has no entry for this IP — so a freshly restarted instance
      // enforces an existing cluster-wide block without needing to record a
      // new failure first. The local fast path is preserved when an entry
      // already exists (no extra DB round-trip for already-known IPs).
      if (await invalidApiKeyLimiter.isBlockedShared(ip)) {
        res
          .status(429)
          .json({ error: "Too many invalid API key attempts, please try again later" });
        return;
      }
      const resolved = await resolveApiKey(rawKey);
      if (!resolved || !resolved.creator.organizationId) {
        const justBlocked = await invalidApiKeyLimiter.recordFailure(ip);
        if (justBlocked) {
          // Fire-and-forget: alerting must never delay or fail the response.
          void reportApiKeyBruteForceBlock({
            ip,
            windowMs: INVALID_KEY_WINDOW_MS,
            maxFailures: INVALID_KEY_MAX_FAILURES,
          });
        }
        res.status(401).json({ error: "Invalid API key" });
        return;
      }
      if (
        permission === "settings.manage" ||
        permission === "users.manage" ||
        !hasPermission(resolved.key.role, permission)
      ) {
        res.status(403).json({ error: "API key lacks this permission" });
        return;
      }
      // Per-key request budget for the programmatic API. Shared DB counter
      // so the limit holds across instances; fails open on DB errors.
      try {
        const bucket = await incrementShared(
          `api-key-rate:${resolved.key.id}`,
          API_KEY_RATE_WINDOW_MS,
        );
        if (bucket.count > API_KEY_RATE_MAX) {
          res
            .status(429)
            .setHeader(
              "Retry-After",
              String(Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000))),
            )
            .json({ error: "API rate limit exceeded, slow down" });
          return;
        }
      } catch {
        // fail open — availability over strictness for authed callers
      }
      req.member = {
        user: resolved.creator,
        organizationId: resolved.creator.organizationId,
        role: resolved.key.role,
      };
      next();
      return;
    }
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, req.user!.id));
    if (!user || !user.isActive) {
      res.status(403).json({ error: "Account is not active" });
      return;
    }
    if (!user.organizationId) {
      res.status(403).json({ error: "No organization membership" });
      return;
    }
    if (!hasPermission(user.role, permission)) {
      res.status(403).json({ error: "Insufficient role" });
      return;
    }
    req.member = {
      user,
      organizationId: user.organizationId,
      role: user.role,
    };
    next();
  };
  const tagged = guard as RequireMemberGuard;
  tagged.requiredPermission = permission;
  return tagged;
}
