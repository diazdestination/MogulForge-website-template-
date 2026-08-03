import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";
import { leadsTable } from "./leads";
import { organizationsTable } from "./organizations";

/**
 * Rep responses to next-best-action recommendations. Every send / edit /
 * snooze / dismiss is captured here so the copilot can respect snoozes and
 * dismissals and the learning loop can treat them as outcome signals.
 * Org-scoped and action-generic — new action types need no schema change.
 */
export const nextActionFeedbackTable = pgTable(
  "next_action_feedback",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leadsTable.id),
    actorUserId: varchar("actor_user_id").references(() => usersTable.id),
    /** Recommendation kind, e.g. "call_now" | "send_message" | "reply_portal_message" | "follow_up_estimate" | "schedule_follow_up". */
    actionType: text("action_type").notNull(),
    /** "sent" | "edited" | "snoozed" | "dismissed" */
    response: text("response").notNull(),
    /** Only for snoozes: hide this recommendation until this time. */
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("next_action_feedback_org_lead_idx").on(
      table.organizationId,
      table.leadId,
    ),
  ],
);

export type NextActionFeedback = typeof nextActionFeedbackTable.$inferSelect;
