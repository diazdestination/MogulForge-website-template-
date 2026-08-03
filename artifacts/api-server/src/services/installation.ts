import { randomBytes } from "node:crypto";

import {
  authorizedDomainsTable,
  db,
  installationKeysTable,
  type AuthorizedDomain,
  type InstallationKey,
} from "@workspace/db";
import { and, asc, eq, sql } from "drizzle-orm";

/**
 * Installation keys & authorized domains.
 *
 * The installation key is a PUBLIC identifier a company pastes into its own
 * website. It maps a browser request to an organization — it is not a
 * credential. Security comes from the authorized-domain check (the request's
 * Origin/Referer must be on the org's allowlist) plus the fact that key-scoped
 * endpoints are the same unauthenticated public endpoints that already exist.
 */

export function generatePublicKey(): string {
  return `mfi_${randomBytes(18).toString("hex")}`;
}

/** Get the org's active installation key, creating one on first access. */
export async function getActiveInstallationKey(
  organizationId: string,
): Promise<InstallationKey> {
  const [existing] = await db
    .select()
    .from(installationKeysTable)
    .where(
      and(
        eq(installationKeysTable.organizationId, organizationId),
        eq(installationKeysTable.isActive, true),
      ),
    );
  if (existing) return existing;
  // First access — issue a key. A per-org advisory transaction lock plus the
  // partial unique index (one active key per org) make concurrent first
  // accesses race-safe: the second caller waits, re-checks, and reuses the
  // winner's key.
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`installation-key:${organizationId}`}))`,
    );
    const [raced] = await tx
      .select()
      .from(installationKeysTable)
      .where(
        and(
          eq(installationKeysTable.organizationId, organizationId),
          eq(installationKeysTable.isActive, true),
        ),
      );
    if (raced) return raced;
    const [created] = await tx
      .insert(installationKeysTable)
      .values({ organizationId, publicKey: generatePublicKey() })
      .returning();
    return created;
  });
}

/** Rotate: deactivate every active key for the org and issue a fresh one. */
export async function rotateInstallationKey(
  organizationId: string,
): Promise<InstallationKey> {
  return db.transaction(async (tx) => {
    // Same per-org lock as issuance so concurrent rotations serialize and the
    // partial unique index (one active key per org) is never violated.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`installation-key:${organizationId}`}))`,
    );
    await tx
      .update(installationKeysTable)
      .set({ isActive: false, revokedAt: new Date() })
      .where(
        and(
          eq(installationKeysTable.organizationId, organizationId),
          eq(installationKeysTable.isActive, true),
        ),
      );
    const [created] = await tx
      .insert(installationKeysTable)
      .values({ organizationId, publicKey: generatePublicKey() })
      .returning();
    return created;
  });
}

/** Resolve an active installation key to its organization id, or null. */
/**
 * Record a widget heartbeat: closer.js pings on every successful init, so
 * "connection health" can be shown without re-fetching the customer's site.
 * Best-effort — heartbeats never fail a page load.
 */
export async function recordHeartbeat(
  keyId: string,
  info: { version?: string; host?: string },
): Promise<void> {
  await db
    .update(installationKeysTable)
    .set({
      lastSeenAt: new Date(),
      lastSeenVersion: info.version?.slice(0, 20) ?? null,
      lastSeenHost: info.host?.slice(0, 253).toLowerCase() ?? null,
    })
    .where(eq(installationKeysTable.id, keyId));
}

export async function resolveInstallationKey(
  publicKey: string,
): Promise<InstallationKey | null> {
  if (!publicKey.startsWith("mfi_") || publicKey.length > 100) return null;
  const [key] = await db
    .select()
    .from(installationKeysTable)
    .where(
      and(
        eq(installationKeysTable.publicKey, publicKey),
        eq(installationKeysTable.isActive, true),
      ),
    );
  return key ?? null;
}

/**
 * Normalize an admin-entered domain to a lowercase hostname.
 * Accepts full URLs ("https://www.example.com/path"), bare domains, a
 * leading "*." wildcard, and localhost. Returns null when the input can't
 * be a sane hostname.
 */
export function normalizeDomain(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (!value) return null;
  let wildcard = false;
  if (value.startsWith("*.")) {
    wildcard = true;
    value = value.slice(2);
  }
  // Tolerate pasted URLs.
  if (value.includes("://")) {
    try {
      value = new URL(value).hostname;
    } catch {
      return null;
    }
  }
  // Strip any path/port fragments from bare input.
  value = value.split("/")[0].split(":")[0].replace(/\.$/, "");
  if (!value) return null;
  // Hostname sanity: letters/digits/hyphens/dots only, no empty labels.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(value)) {
    return null;
  }
  if (wildcard && !value.includes(".")) return null; // "*.com" style is useless
  return wildcard ? `*.${value}` : value;
}

export async function listAuthorizedDomains(
  organizationId: string,
): Promise<AuthorizedDomain[]> {
  return db
    .select()
    .from(authorizedDomainsTable)
    .where(eq(authorizedDomainsTable.organizationId, organizationId))
    .orderBy(asc(authorizedDomainsTable.createdAt));
}

/** Add a domain (normalized). Returns null on invalid input; idempotent. */
export async function addAuthorizedDomain(
  organizationId: string,
  rawDomain: string,
): Promise<AuthorizedDomain | null> {
  const domain = normalizeDomain(rawDomain);
  if (!domain) return null;
  const [created] = await db
    .insert(authorizedDomainsTable)
    .values({ organizationId, domain })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [existing] = await db
    .select()
    .from(authorizedDomainsTable)
    .where(
      and(
        eq(authorizedDomainsTable.organizationId, organizationId),
        eq(authorizedDomainsTable.domain, domain),
      ),
    );
  return existing ?? null;
}

export async function removeAuthorizedDomain(
  organizationId: string,
  id: string,
): Promise<AuthorizedDomain | undefined> {
  const [removed] = await db
    .delete(authorizedDomainsTable)
    .where(
      and(
        eq(authorizedDomainsTable.id, id),
        eq(authorizedDomainsTable.organizationId, organizationId),
      ),
    )
    .returning();
  return removed;
}

/**
 * Does `hostname` match one of the org's authorized domain entries?
 *
 * - Exact match: `example.com` matches `example.com`
 * - www equivalence: `example.com` also matches `www.example.com` and
 *   an entry of `www.example.com` also matches `example.com`
 * - Wildcard: `*.example.com` matches any subdomain (`a.b.example.com`)
 *   AND the apex `example.com`
 * - `localhost` matches regardless of port (ports are stripped upstream)
 */
export function isHostnameAuthorized(
  hostname: string,
  entries: readonly string[],
): boolean {
  let host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  // Loopback IPs are the same machine as localhost — treat them as one so a
  // "localhost" entry covers local dev previews served from 127.0.0.1.
  if (host === "127.0.0.1" || host === "::1" || host === "[::1]") {
    host = "localhost";
  }
  for (const entry of entries) {
    if (entry.startsWith("*.")) {
      const base = entry.slice(2);
      if (host === base || host.endsWith(`.${base}`)) return true;
      continue;
    }
    if (host === entry) return true;
    if (host === `www.${entry}` || entry === `www.${host}`) return true;
  }
  return false;
}

/**
 * Idempotently make sure an org has an installation key and that the given
 * domains are authorized. Used to seed the default org at boot so the
 * existing first-party website keeps working when it starts sending its key.
 */
export async function ensureInstallation(
  organizationId: string,
  seedDomains: string[],
): Promise<void> {
  await getActiveInstallationKey(organizationId);
  for (const raw of seedDomains) {
    await addAuthorizedDomain(organizationId, raw);
  }
}
