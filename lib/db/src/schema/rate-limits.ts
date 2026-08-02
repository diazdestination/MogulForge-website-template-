import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Shared fixed-window rate-limit counters so limits stay accurate when the
 * API runs on multiple instances (and survive restarts). Rows are upserted
 * atomically per window; expired rows are reset in place and pruned
 * opportunistically.
 */
export const rateLimitCountersTable = pgTable("rate_limit_counters", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
});
