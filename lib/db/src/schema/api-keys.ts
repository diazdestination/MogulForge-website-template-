import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";
import { userRoleEnum } from "./enums";
import { organizationsTable } from "./organizations";

/**
 * Org-scoped API keys. Only a SHA-256 hash of the secret is stored — the
 * full key is shown once at creation. A key acts on behalf of the admin who
 * created it, capped at the role recorded on the key.
 */
export const apiKeysTable = pgTable(
  "api_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    name: text("name").notNull(),
    /** First characters of the key, for display ("pk_ab12cd…"). */
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    role: userRoleEnum("role").notNull().default("office"),
    createdByUserId: varchar("created_by_user_id")
      .notNull()
      .references(() => usersTable.id),
    isActive: boolean("is_active").notNull().default(true),
    /** Optional expiry — after this instant the key is rejected like a revoked one. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /**
     * When the pre-expiry reminder email was sent to org admins. Null means
     * no reminder has gone out yet; the scheduler claims a key by setting
     * this, so the reminder is never re-sent for the same expiry.
     */
    expiryReminderSentAt: timestamp("expiry_reminder_sent_at", {
      withTimezone: true,
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("api_keys_org_idx").on(table.organizationId)],
);

export type ApiKey = typeof apiKeysTable.$inferSelect;
export type InsertApiKey = typeof apiKeysTable.$inferInsert;
