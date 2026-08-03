import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { leadsTable } from "./leads";
import { playbooksTable, playbookEnrollmentsTable } from "./playbooks";

/**
 * Closer Engine learning loop: every outreach touch is recorded here with
 * its downstream outcome chain (sent → replied → booked → won/lost),
 * attributed to the playbook step and message variant that drove it. The
 * in-process allocator reads these rows to shift traffic toward winning
 * variants and send windows — org-scoped, no cross-org learning.
 */
export const playbookTouchesTable = pgTable(
  "playbook_touches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    playbookId: uuid("playbook_id")
      .notNull()
      .references(() => playbooksTable.id),
    enrollmentId: uuid("enrollment_id")
      .notNull()
      .references(() => playbookEnrollmentsTable.id),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leadsTable.id),
    stepIndex: integer("step_index").notNull(),
    /** Message variant key ("default" when the step has no variants). */
    variantKey: text("variant_key").notNull().default("default"),
    channel: text("channel").notNull(),
    provider: text("provider").notNull(),
    /** UTC hour (0-23) the touch went out — send-window learning input. */
    sentHourUtc: integer("sent_hour_utc").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    /** Outcome chain: null until the corresponding event is observed. */
    repliedAt: timestamp("replied_at", { withTimezone: true }),
    bookedAt: timestamp("booked_at", { withTimezone: true }),
    /** "won" | "lost" once the lead reaches a terminal stage. */
    finalOutcome: text("final_outcome"),
    finalOutcomeAt: timestamp("final_outcome_at", { withTimezone: true }),
  },
  (table) => [
    index("playbook_touches_org_pb_step_variant_idx").on(
      table.organizationId,
      table.playbookId,
      table.stepIndex,
      table.variantKey,
    ),
    index("playbook_touches_org_lead_idx").on(
      table.organizationId,
      table.leadId,
    ),
  ],
);

/**
 * Explainable log of every optimization decision the engine makes —
 * which variant it picked and why, and any send-window shifts. Admins can
 * audit exactly why a homeowner got a particular message at a given time.
 */
export const playbookDecisionsTable = pgTable(
  "playbook_decisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    playbookId: uuid("playbook_id").references(() => playbooksTable.id),
    /** "variant_allocation" | "send_window" */
    kind: text("kind").notNull(),
    stepIndex: integer("step_index"),
    /** Structured decision payload (chosen variant, scores, sample sizes…). */
    decision: jsonb("decision")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** Human-readable rationale, e.g. "variant B wins 2.1x on reply rate". */
    explanation: text("explanation").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("playbook_decisions_org_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
  ],
);

export type PlaybookTouch = typeof playbookTouchesTable.$inferSelect;
export type PlaybookDecision = typeof playbookDecisionsTable.$inferSelect;
