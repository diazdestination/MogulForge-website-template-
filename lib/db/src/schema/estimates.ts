import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { estimateStatusEnum } from "./enums";
import { leadsTable } from "./leads";
import { organizationsTable } from "./organizations";

export interface EstimateLineItem {
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
}

export const estimatesTable = pgTable(
  "estimates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leadsTable.id),
    title: text("title").notNull(),
    status: estimateStatusEnum("status").notNull().default("draft"),
    lineItems: jsonb("line_items")
      .$type<EstimateLineItem[]>()
      .notNull()
      .default([]),
    subtotalCents: integer("subtotal_cents").notNull().default(0),
    taxCents: integer("tax_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull().default(0),
    notes: text("notes"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("estimates_org_status_idx").on(table.organizationId, table.status),
    index("estimates_org_lead_idx").on(table.organizationId, table.leadId),
  ],
);

export const insertEstimateSchema = createInsertSchema(estimatesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertEstimate = z.infer<typeof insertEstimateSchema>;
export type Estimate = typeof estimatesTable.$inferSelect;
