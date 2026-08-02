import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";

/**
 * Homeowner portal login codes. A homeowner proves ownership of the email or
 * phone stored on their contact record by receiving a one-time code. Only a
 * hash of the code is stored.
 */
export const portalLoginCodesTable = pgTable(
  "portal_login_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    /** Normalized identifier: lowercased email or last-10-digit phone. */
    identifier: text("identifier").notNull(),
    channel: text("channel", { enum: ["email", "sms"] }).notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("portal_login_codes_identifier_idx").on(
      table.organizationId,
      table.identifier,
    ),
  ],
);

/**
 * Homeowner portal sessions. Keyed by an opaque bearer token hash; the session
 * is bound to the verified identifier (email/phone), so it covers every
 * contact record sharing that identifier — including future submissions.
 */
export const portalSessionsTable = pgTable(
  "portal_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    tokenHash: text("token_hash").notNull().unique(),
    identifier: text("identifier").notNull(),
    channel: text("channel", { enum: ["email", "sms"] }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("portal_sessions_token_idx").on(table.tokenHash)],
);

export type PortalSession = typeof portalSessionsTable.$inferSelect;
