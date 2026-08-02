import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./auth";
import { contactsTable } from "./contacts";
import { leadStatusEnum, urgencyEnum } from "./enums";
import { organizationsTable } from "./organizations";
import { propertiesTable } from "./properties";

export const leadsTable = pgTable(
  "leads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contactsTable.id),
    propertyId: uuid("property_id").references(() => propertiesTable.id),
    assignedUserId: varchar("assigned_user_id").references(() => usersTable.id),
    status: leadStatusEnum("status").notNull().default("new"),
    urgency: urgencyEnum("urgency").notNull().default("normal"),
    serviceType: text("service_type"),
    source: text("source"),
    sourceDetail: text("source_detail"),
    score: integer("score").notNull().default(0),
    scoreReasons: jsonb("score_reasons")
      .$type<string[]>()
      .notNull()
      .default([]),
    summary: text("summary"),
    estimatedValueCents: integer("estimated_value_cents"),
    firstTouch: jsonb("first_touch").$type<Record<string, unknown>>(),
    lastTouch: jsonb("last_touch").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("leads_org_status_idx").on(table.organizationId, table.status),
    index("leads_org_assigned_idx").on(
      table.organizationId,
      table.assignedUserId,
    ),
  ],
);

export const insertLeadSchema = createInsertSchema(leadsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertLead = z.infer<typeof insertLeadSchema>;
export type Lead = typeof leadsTable.$inferSelect;
