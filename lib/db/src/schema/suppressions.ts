import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

/**
 * Org-scoped send suppression list. Keyed by the normalized ADDRESS
 * (lowercase email / digits-only phone), NOT by contact id, so an
 * unsubscribe survives contact deletion and re-import: a re-imported
 * contact with the same email/phone stays suppressed.
 */
export const SUPPRESSION_REASONS = [
  "unsubscribed", // email unsubscribe link
  "stop_keyword", // inbound SMS STOP/UNSUBSCRIBE/etc.
  "hard_bounce", // provider says the address does not exist
  "invalid", // provider rejected the address as malformed/unreachable
  "manual", // suppressed by an admin
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export const suppressionsTable = pgTable(
  "suppressions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    /** "email" | "sms" */
    channel: text("channel").notNull().$type<"email" | "sms">(),
    /** Normalized address: lowercase email, or digits-only phone. */
    value: text("value").notNull(),
    reason: text("reason").notNull().$type<SuppressionReason>(),
    /** Where the suppression came from (e.g. "unsubscribe_link", "twilio_inbound", provider name). */
    source: text("source"),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("suppressions_org_channel_value_idx").on(
      table.organizationId,
      table.channel,
      table.value,
    ),
    index("suppressions_org_idx").on(table.organizationId),
  ],
);

export const insertSuppressionSchema = createInsertSchema(
  suppressionsTable,
).omit({ id: true, createdAt: true });
export type InsertSuppression = z.infer<typeof insertSuppressionSchema>;
export type Suppression = typeof suppressionsTable.$inferSelect;
