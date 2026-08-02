import {
  index,
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
import { leadsTable } from "./leads";
import { organizationsTable } from "./organizations";

// Activity timeline: one row per notable event on a lead/contact.
export const activitiesTable = pgTable(
  "activities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    leadId: uuid("lead_id").references(() => leadsTable.id),
    contactId: uuid("contact_id").references(() => contactsTable.id),
    actorUserId: varchar("actor_user_id").references(() => usersTable.id),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("activities_org_lead_idx").on(
      table.organizationId,
      table.leadId,
      table.occurredAt,
    ),
  ],
);

export const insertActivitySchema = createInsertSchema(activitiesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertActivity = z.infer<typeof insertActivitySchema>;
export type Activity = typeof activitiesTable.$inferSelect;
