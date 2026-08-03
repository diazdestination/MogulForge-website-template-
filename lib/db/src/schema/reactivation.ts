import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./auth";
import { leadsTable } from "./leads";
import { organizationsTable } from "./organizations";
import { playbooksTable, playbookEnrollmentsTable } from "./playbooks";

/**
 * Cold-lead reactivation: CSV lead imports and throttled win-back campaigns
 * that drain a lead segment into a playbook at an org-configured rate.
 */

// ---------- lead imports ----------

export const leadImportsTable = pgTable(
  "lead_imports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    fileName: text("file_name"),
    /** Rows in the uploaded file (excluding the header). */
    totalRows: integer("total_rows").notNull().default(0),
    imported: integer("imported").notNull().default(0),
    /** Rows matched to an existing contact with a live lead. */
    duplicates: integer("duplicates").notNull().default(0),
    /** Rows dropped for validation errors (missing name/contact info). */
    skipped: integer("skipped").notNull().default(0),
    /** Imported rows whose address is on the suppression list (they exist
     * in the CRM but the send gate will block outreach to them). */
    suppressed: integer("suppressed").notNull().default(0),
    /** Sample of row-level error messages (capped). */
    errors: jsonb("errors").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdByUserId: varchar("created_by_user_id").references(() => usersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("lead_imports_org_idx").on(t.organizationId, t.createdAt)],
);

// ---------- reactivation campaigns ----------

/** Declarative lead segment. Empty/absent fields mean "any". */
export interface ReactivationSegment {
  /** Lead statuses to include (e.g. ["lost"], ["estimate_sent"]). */
  statuses?: string[];
  /** Lead must be at least this many days old. */
  minAgeDays?: number | null;
  /** No activity recorded on the lead in the last N days. */
  inactiveDays?: number | null;
  /** Restrict to these lead sources. */
  sources?: string[];
}

export type ReactivationCampaignStatus =
  | "draft"
  | "running"
  | "paused"
  | "completed"
  | "cancelled";

export const reactivationCampaignsTable = pgTable(
  "reactivation_campaigns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    name: text("name").notNull(),
    playbookId: uuid("playbook_id")
      .notNull()
      .references(() => playbooksTable.id),
    segment: jsonb("segment").$type<ReactivationSegment>().notNull(),
    status: text("status").$type<ReactivationCampaignStatus>().notNull().default("draft"),
    /** Throttle: how many leads enter the sequence per hour. */
    ratePerHour: integer("rate_per_hour").notNull().default(20),
    /** Segment snapshot size at launch. */
    totalLeads: integer("total_leads").notNull().default(0),
    launchedAt: timestamp("launched_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdByUserId: varchar("created_by_user_id").references(() => usersTable.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("reactivation_campaigns_org_idx").on(t.organizationId, t.status)],
);

export type ReactivationCampaignLeadStatus = "pending" | "enrolled" | "skipped";

/** Per-lead campaign progress, snapshotted at launch. */
export const reactivationCampaignLeadsTable = pgTable(
  "reactivation_campaign_leads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => reactivationCampaignsTable.id),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leadsTable.id),
    status: text("status")
      .$type<ReactivationCampaignLeadStatus>()
      .notNull()
      .default("pending"),
    enrollmentId: uuid("enrollment_id").references(() => playbookEnrollmentsTable.id),
    /** Lead status before the campaign moved it back into outreach. */
    previousLeadStatus: text("previous_lead_status"),
    detail: text("detail"),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("reactivation_campaign_leads_unique_idx").on(t.campaignId, t.leadId),
    index("reactivation_campaign_leads_status_idx").on(t.campaignId, t.status),
  ],
);

export type LeadImport = typeof leadImportsTable.$inferSelect;
export type ReactivationCampaign = typeof reactivationCampaignsTable.$inferSelect;
export type ReactivationCampaignLead =
  typeof reactivationCampaignLeadsTable.$inferSelect;
