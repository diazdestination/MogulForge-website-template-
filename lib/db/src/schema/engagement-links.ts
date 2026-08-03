import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { contactsTable } from "./contacts";
import { leadsTable } from "./leads";
import { organizationsTable } from "./organizations";

/**
 * Tokenized post-sale engagement links. One row per (contact, lead, kind):
 * "review" links click through to the org's public review page (clicks are
 * tracked — completed third-party reviews are NOT detectable and never
 * claimed), and "referral" links accept a referral submission that becomes
 * a properly-attributed lead. The token alone identifies the org — these
 * are capability URLs sent only to the customer they belong to.
 */
export const engagementLinksTable = pgTable(
  "engagement_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contactsTable.id),
    leadId: uuid("lead_id").references(() => leadsTable.id),
    /** review | referral */
    kind: text("kind").notNull(),
    token: text("token").notNull(),
    clickCount: integer("click_count").notNull().default(0),
    lastClickedAt: timestamp("last_clicked_at", { withTimezone: true }),
    /** Referral links: how many submissions came through this link. */
    submissionCount: integer("submission_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("engagement_links_token_idx").on(table.token),
    uniqueIndex("engagement_links_contact_kind_idx").on(
      table.contactId,
      table.kind,
    ),
    index("engagement_links_org_idx").on(table.organizationId),
  ],
);

export type EngagementLink = typeof engagementLinksTable.$inferSelect;
