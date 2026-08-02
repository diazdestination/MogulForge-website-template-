import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { automationRunStatusEnum, scheduledActionStatusEnum } from "./enums";
import { organizationsTable } from "./organizations";

/** A single configured action inside an automation rule. */
export interface AutomationAction {
  type:
    | "send_email"
    | "send_sms"
    | "create_task"
    | "assign_lead"
    | "change_stage"
    | "call_webhook"
    | "add_tag"
    | "schedule_followup"
    | "appointment_reminder";
  /** Action-specific params, e.g. { templateId }, { status }, { assignedUserId }, { tagId }, { delayMinutes, action } */
  params: Record<string, unknown>;
}

/** Simple equality conditions matched against the event context (e.g. { "lead.urgency": "emergency" }). */
export type AutomationConditions = Record<string, unknown>;

export const automationsTable = pgTable(
  "automations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    name: text("name").notNull(),
    /**
     * Immutable identifier for system-seeded rules (e.g.
     * "default.assessment_abandoned_followup"). Null for admin-created rules.
     * Seeding keys on (organizationId, seedKey) so renaming a seeded rule
     * never causes it to be re-seeded. Unique per org (partial index below).
     */
    seedKey: text("seed_key"),
    /** Event key, e.g. lead.created, appointment.booked, review.request_due */
    event: text("event").notNull(),
    conditions: jsonb("conditions")
      .$type<AutomationConditions>()
      .notNull()
      .default({}),
    actions: jsonb("actions").$type<AutomationAction[]>().notNull().default([]),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("automations_org_event_idx").on(table.organizationId, table.event),
    uniqueIndex("automations_org_seed_key_idx")
      .on(table.organizationId, table.seedKey)
      .where(sql`${table.seedKey} is not null`),
  ],
);

export interface ActionResult {
  type: string;
  status: "success" | "failed" | "skipped";
  detail?: string;
}

export const automationRunsTable = pgTable(
  "automation_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automationsTable.id),
    event: text("event").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    status: automationRunStatusEnum("status").notNull(),
    actionResults: jsonb("action_results")
      .$type<ActionResult[]>()
      .notNull()
      .default([]),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("automation_runs_org_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
  ],
);

/** Delayed follow-up actions scheduled by automations. */
export const scheduledActionsTable = pgTable(
  "scheduled_actions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    automationId: uuid("automation_id").references(() => automationsTable.id),
    action: jsonb("action").$type<AutomationAction>().notNull(),
    /** Event context snapshot used when the action finally runs. */
    context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
    runAt: timestamp("run_at", { withTimezone: true }).notNull(),
    status: scheduledActionStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("scheduled_actions_status_run_idx").on(table.status, table.runAt)],
);

export const insertAutomationSchema = createInsertSchema(automationsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertAutomation = z.infer<typeof insertAutomationSchema>;
export type Automation = typeof automationsTable.$inferSelect;
export type AutomationRun = typeof automationRunsTable.$inferSelect;
export type ScheduledAction = typeof scheduledActionsTable.$inferSelect;
