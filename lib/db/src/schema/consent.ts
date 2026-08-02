import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { contactsTable } from "./contacts";
import { consentChannelEnum } from "./enums";
import { organizationsTable } from "./organizations";

export const consentRecordsTable = pgTable(
  "consent_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contactsTable.id),
    channel: consentChannelEnum("channel").notNull(),
    granted: boolean("granted").notNull(),
    disclosureVersion: text("disclosure_version").notNull(),
    sourceIp: text("source_ip"),
    userAgent: text("user_agent"),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("consent_org_contact_idx").on(table.organizationId, table.contactId),
  ],
);

export const insertConsentRecordSchema = createInsertSchema(
  consentRecordsTable,
).omit({ id: true, recordedAt: true });
export type InsertConsentRecord = z.infer<typeof insertConsentRecordSchema>;
export type ConsentRecord = typeof consentRecordsTable.$inferSelect;
