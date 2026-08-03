import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";

/**
 * Browser-safe installation keys. Unlike `api_keys` (secret, hashed), an
 * installation key is PUBLIC — it ships inside a website snippet on the
 * client's own site — so it is stored in plaintext and grants nothing on its
 * own: requests carrying it are additionally checked against the org's
 * authorized-domain list and only reach unauthenticated public endpoints.
 *
 * Rotation deactivates the old key and issues a new one; old keys are kept
 * (inactive) for auditability.
 */
export const installationKeysTable = pgTable(
  "installation_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    /** Public key embedded in the website snippet ("mfi_…"). */
    publicKey: text("public_key").notNull().unique(),
    isActive: boolean("is_active").notNull().default(true),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** Last widget heartbeat received for this key (script init on a page). */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    /** closer.js version reported by the last heartbeat. */
    lastSeenVersion: text("last_seen_version"),
    /** Page hostname reported by the last heartbeat. */
    lastSeenHost: text("last_seen_host"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("installation_keys_org_idx").on(table.organizationId),
    // DB-level "one active key per org" invariant — issuance/rotation races
    // can never leave two valid keys.
    uniqueIndex("installation_keys_org_active_idx")
      .on(table.organizationId)
      .where(sql`${table.isActive} = true`),
  ],
);

/**
 * Domains an organization has authorized its installation key to run on.
 * Stored as normalized lowercase hostnames; a leading "*." authorizes all
 * subdomains of the remainder. A bare domain also matches its "www."
 * variant (and vice versa) so admins don't have to enter both.
 */
export const authorizedDomainsTable = pgTable(
  "authorized_domains",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    domain: text("domain").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("authorized_domains_org_domain_idx").on(
      table.organizationId,
      table.domain,
    ),
  ],
);

/**
 * Result of an admin-triggered "test installation" check: the server fetched
 * the given domain's homepage and looked for the closer.js snippet. Only the
 * latest check per (org, domain) matters for display; rows are upserted.
 */
export const installationChecksTable = pgTable(
  "installation_checks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    /** Normalized hostname that was checked. */
    domain: text("domain").notNull(),
    /**
     * installed | wrong_key | misconfigured | domain_not_authorized |
     * not_detected | unreachable
     */
    status: text("status").notNull(),
    /** Human-readable explanation shown to the admin. */
    detail: text("detail").notNull().default(""),
    checkedAt: timestamp("checked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("installation_checks_org_domain_idx").on(
      table.organizationId,
      table.domain,
    ),
  ],
);

export type InstallationKey = typeof installationKeysTable.$inferSelect;
export type InstallationCheck = typeof installationChecksTable.$inferSelect;
export type AuthorizedDomain = typeof authorizedDomainsTable.$inferSelect;
