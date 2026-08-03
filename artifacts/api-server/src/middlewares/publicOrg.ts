import type { InstallationKey, Organization } from "@workspace/db";
import { db, organizationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

import {
  isHostnameAuthorized,
  listAuthorizedDomains,
  resolveInstallationKey,
} from "../services/installation";
import { getDefaultOrganization } from "../services/org";

declare global {
  namespace Express {
    interface Request {
      /** Set by resolvePublicOrg on public routes. */
      publicOrg?: Organization;
      /** The resolved installation key, when the request carried one. */
      publicOrgKey?: InstallationKey;
    }
  }
}

/** Extract the caller's page hostname from Origin (preferred) or Referer. */
function requestHostname(req: Request): string | null {
  const raw = req.headers.origin || req.headers.referer;
  if (!raw || typeof raw !== "string") return null;
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Hostnames this API itself is served from, per trusted platform env vars
 * (development domain + published domains). Used to recognize same-origin
 * requests from our own hosted pages without trusting any request header.
 */
export function ownHostnames(): Set<string> {
  const hosts = new Set<string>();
  const dev = process.env.REPLIT_DEV_DOMAIN;
  if (dev) hosts.add(dev.toLowerCase());
  for (const d of (process.env.REPLIT_DOMAINS ?? "").split(",")) {
    const h = d.trim().toLowerCase();
    if (h) hosts.add(h);
  }
  return hosts;
}

export function installationKeyFrom(req: Request): string | null {
  const header = req.headers["x-installation-key"];
  if (typeof header === "string" && header.trim()) return header.trim();
  const query = req.query["installationKey"];
  if (typeof query === "string" && query.trim()) return query.trim();
  return null;
}

/**
 * Resolve the organization for an unauthenticated public endpoint.
 *
 * - With an `x-installation-key` header (or `installationKey` query param):
 *   the key must map to an active installation key AND the request's
 *   Origin/Referer hostname must be on that org's authorized-domain list.
 *   Unknown keys get 401, unauthorized (or missing) origins get 403 — both
 *   checked server-side; client-side CORS is never relied on.
 * - Without a key: legacy single-tenant behavior — the default organization
 *   is used, exactly as before installation keys existed. This keeps the
 *   first-party website working and will be retired once every consumer
 *   sends a key. Routes that only exist for keyed embeds (the closer.js
 *   widget) opt out of the fallback with `requireKey: true` — keyless
 *   requests there get 401 instead of silently landing on the default org.
 */
export function resolvePublicOrg(opts: { requireKey?: boolean } = {}) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const rawKey = installationKeyFrom(req);
      if (!rawKey) {
        if (opts.requireKey) {
          res.status(401).json({ error: "Installation key required" });
          return;
        }
        req.publicOrg = await getDefaultOrganization();
        next();
        return;
      }
      const key = await resolveInstallationKey(rawKey);
      if (!key) {
        res.status(401).json({ error: "Unknown installation key" });
        return;
      }
      const hostname = requestHostname(req);
      // Hosted MogulForge pages (e.g. /public/form-page/:slug) are served
      // from this API's own host, so keyed requests they make are
      // same-origin. Browsers set Origin/Referer truthfully, so matching
      // our own host is proof the page is ours — no domain allow-list entry
      // needed for hosted surfaces. The "own host" set comes ONLY from
      // trusted deployment env vars — never from request headers, which a
      // caller could forge (x-forwarded-host/host are client-suppliable).
      if (hostname && ownHostnames().has(hostname)) {
        const [selfOrg] = await db
          .select()
          .from(organizationsTable)
          .where(eq(organizationsTable.id, key.organizationId));
        if (!selfOrg) {
          res.status(401).json({ error: "Unknown installation key" });
          return;
        }
        req.publicOrg = selfOrg;
        req.publicOrgKey = key;
        next();
        return;
      }
      if (!hostname) {
        res.status(403).json({
          error: "Origin required — requests with an installation key must come from an authorized website",
        });
        return;
      }
      const domains = await listAuthorizedDomains(key.organizationId);
      if (!isHostnameAuthorized(hostname, domains.map((d) => d.domain))) {
        res.status(403).json({ error: "Domain not authorized for this installation key" });
        return;
      }
      const [org] = await db
        .select()
        .from(organizationsTable)
        .where(eq(organizationsTable.id, key.organizationId));
      if (!org) {
        res.status(401).json({ error: "Unknown installation key" });
        return;
      }
      req.publicOrg = org;
      req.publicOrgKey = key;
      next();
    } catch (err) {
      next(err);
    }
  };
}
