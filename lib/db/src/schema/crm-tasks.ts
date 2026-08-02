import {
  index,
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
import { taskStatusEnum, urgencyEnum } from "./enums";
import { leadsTable } from "./leads";
import { organizationsTable } from "./organizations";

export const crmTasksTable = pgTable(
  "crm_tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    leadId: uuid("lead_id").references(() => leadsTable.id),
    contactId: uuid("contact_id").references(() => contactsTable.id),
    assignedUserId: varchar("assigned_user_id").references(() => usersTable.id),
    title: text("title").notNull(),
    description: text("description"),
    // Structured origin marker for automation-created tasks (e.g.
    // "assessment.abandoned"). Flows that auto-close chase tasks match on
    // this instead of description text, so rep edits can't break them.
    sourceEvent: text("source_event"),
    status: taskStatusEnum("status").notNull().default("open"),
    priority: urgencyEnum("priority").notNull().default("normal"),
    dueAt: timestamp("due_at", { withTimezone: true }),
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
    index("crm_tasks_org_status_idx").on(table.organizationId, table.status),
    index("crm_tasks_org_assigned_idx").on(
      table.organizationId,
      table.assignedUserId,
    ),
  ],
);

export const insertCrmTaskSchema = createInsertSchema(crmTasksTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCrmTask = z.infer<typeof insertCrmTaskSchema>;
export type CrmTask = typeof crmTasksTable.$inferSelect;
