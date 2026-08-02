import { isNotNull } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { projectStatusEnum } from "./enums";
import { estimatesTable } from "./estimates";
import { leadsTable } from "./leads";
import { organizationsTable } from "./organizations";

export const projectsTable = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leadsTable.id),
    estimateId: uuid("estimate_id").references(() => estimatesTable.id),
    name: text("name").notNull(),
    status: projectStatusEnum("status").notNull().default("scheduled"),
    scheduledStart: timestamp("scheduled_start", { withTimezone: true }),
    scheduledEnd: timestamp("scheduled_end", { withTimezone: true }),
    crewUserIds: jsonb("crew_user_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    crewNotes: text("crew_notes"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("projects_org_status_idx").on(table.organizationId, table.status),
    index("projects_org_lead_idx").on(table.organizationId, table.leadId),
    // A given estimate can back at most one project; the API re-checks this
    // for a friendly error, the index guarantees it under concurrency.
    uniqueIndex("projects_estimate_unique_idx")
      .on(table.estimateId)
      .where(isNotNull(table.estimateId)),
  ],
);

export const insertProjectSchema = createInsertSchema(projectsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projectsTable.$inferSelect;
