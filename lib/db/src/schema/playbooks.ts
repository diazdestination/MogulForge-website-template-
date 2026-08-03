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
import { leadsTable } from "./leads";
import { organizationsTable } from "./organizations";

/**
 * One outreach step inside a playbook: wait `delayMinutes` after the
 * previous step (or after enrollment for the first step), then send an
 * AI-personalized message on `channel`. `prompt` steers the AI draft
 * (tone/angle); `subject` is used for email only.
 */
export interface PlaybookStep {
  channel: "email" | "sms";
  delayMinutes: number;
  subject?: string;
  prompt: string;
  /**
   * Optional A/B message variants. The base prompt/subject is always
   * variant "default"; entries here add alternatives the bandit allocator
   * splits traffic across (shifting toward winners once each variant has
   * enough sends). Keys must be unique within the step.
   */
  variants?: PlaybookStepVariant[];
  /**
   * Post-sale steps: append the contact's tokenized engagement link to the
   * message ("review" click-through or "referral" submission link).
   */
  linkKind?: "review" | "referral";
  /**
   * Admin override: pin a variant key ("default" or a variants[].key) to
   * disable automatic allocation for this step.
   */
  pinnedVariant?: string;
}

/** An alternative message direction for a step (A/B tested by the engine). */
export interface PlaybookStepVariant {
  key: string;
  prompt: string;
  subject?: string;
}

/**
 * Enrollment matching rules. Empty arrays / null mean "any". A lead is
 * auto-enrolled when every configured rule matches.
 */
export interface PlaybookEnrollmentRules {
  minScore?: number | null;
  urgencies?: string[];
  serviceTypes?: string[];
  sources?: string[];
  /**
   * Post-sale playbooks only: lead statuses that trigger enrollment (e.g.
   * ["won"] for a review request, ["completed"] for maintenance check-ins).
   * The milestone must actually be reached — never enrolled before.
   */
  milestoneStatuses?: string[];
}

/**
 * Playbook categories. Concurrency between live enrollments is keyed by
 * category: a lead can hold at most one live enrollment PER category, so
 * e.g. an acquisition outreach sequence and a review-request sequence can
 * run at the same time, but two acquisition sequences can not.
 */
export const PLAYBOOK_CATEGORIES = [
  "acquisition",
  "estimate_follow_up",
  "reactivation",
  "review_request",
  "referral",
] as const;
export const playbooksTable = pgTable(
  "playbooks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    name: text("name").notNull(),
    /** What kind of sequence this is; drives per-lead concurrency. */
    category: text("category")
      .$type<PlaybookCategory>()
      .notNull()
      .default("acquisition"),
    /**
     * Immutable identifier for system-seeded playbooks (e.g.
     * "default.new_lead_outreach"). Null for admin-created playbooks.
     * Seeding keys on (organizationId, seedKey) so a renamed/edited/
     * deactivated seeded playbook is never re-seeded.
     */
    seedKey: text("seed_key"),
    /**
     * "outreach" (default): pre-sale sequences auto-enrolled on lead
     * creation. "post_sale": milestone-gated sequences (review/referral/
     * maintenance) enrolled only when the lead reaches a configured
     * milestone status.
     */
    kind: text("kind").notNull().default("outreach"),
    isActive: boolean("is_active").notNull().default(true),
    enrollmentRules: jsonb("enrollment_rules")
      .$type<PlaybookEnrollmentRules>()
      .notNull()
      .default({}),
    steps: jsonb("steps").$type<PlaybookStep[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("playbooks_org_idx").on(table.organizationId),
    uniqueIndex("playbooks_org_seed_key_idx")
      .on(table.organizationId, table.seedKey)
      .where(sql`${table.seedKey} is not null`),
  ],
);

/** A history entry recorded each time an enrollment advances or changes state. */
export interface EnrollmentHistoryEntry {
  at: string;
  kind:
    | "sent"
    | "skipped"
    | "paused"
    | "resumed"
    | "completed"
    | "stopped"
    | "step_skipped"
    | "deferred";
  stepIndex?: number;
  channel?: string;
  detail?: string;
}

export const playbookEnrollmentsTable = pgTable(
  "playbook_enrollments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    playbookId: uuid("playbook_id")
      .notNull()
      .references(() => playbooksTable.id),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leadsTable.id),
    /** Denormalized copy of the playbook's kind (drives uniqueness rules). */
    kind: text("kind").notNull().default("outreach"),
    /** Denormalized playbook category at enrollment time (concurrency key). */
    category: text("category")
      .$type<PlaybookCategory>()
      .notNull()
      .default("acquisition"),
    /** active | paused | completed | stopped */
    status: text("status").notNull().default("active"),
    /** Index of the NEXT step to send (0-based). */
    currentStep: integer("current_step").notNull().default(0),
    /** Human-readable reason the enrollment stopped/paused (e.g. "lead replied"). */
    pauseReason: text("pause_reason"),
    /** When the next step is scheduled to run (mirror of the scheduled action). */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    history: jsonb("history")
      .$type<EnrollmentHistoryEntry[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("playbook_enrollments_org_lead_idx").on(
      table.organizationId,
      table.leadId,
    ),
    // At most one non-terminal OUTREACH-kind enrollment per lead PER
    // category, so differently-categorized sequences may run concurrently.
    uniqueIndex("playbook_enrollments_lead_active_idx")
      .on(table.leadId, table.category)
      .where(
        sql`${table.status} in ('active', 'paused') and ${table.kind} = 'outreach'`,
      ),
    // Post-sale playbooks may run alongside each other (review + referral +
    // maintenance), but never twice for the same lead + playbook.
    uniqueIndex("playbook_enrollments_lead_playbook_active_idx")
      .on(table.leadId, table.playbookId)
      .where(sql`${table.status} in ('active', 'paused')`),
  ],
);

export const insertPlaybookSchema = createInsertSchema(playbooksTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertPlaybook = z.infer<typeof insertPlaybookSchema>;
export type Playbook = typeof playbooksTable.$inferSelect;
export type PlaybookEnrollment = typeof playbookEnrollmentsTable.$inferSelect;

export type PlaybookCategory = (typeof PLAYBOOK_CATEGORIES)[number];
