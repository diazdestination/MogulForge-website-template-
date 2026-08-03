/**
 * Org knowledge base — structured facts that ground the AI concierge and
 * outreach drafting. Entries are plain admin-managed text with a category
 * and source tag; the concierge only answers from active entries and
 * otherwise says it doesn't know.
 */
import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { organizationsTable } from "./organizations";

/** Allowed knowledge categories (validated at the API layer). */
export const KNOWLEDGE_CATEGORIES = [
  "company",
  "service",
  "service_area",
  "hours",
  "faq",
  "financing",
  "warranty",
  "policy",
  "escalation",
  "disclaimer",
  "brand_voice",
] as const;
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

export const knowledgeEntriesTable = pgTable(
  "knowledge_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    /** Where this fact came from: "manual" (admin), "seed", future: "import". */
    source: text("source").notNull().default("manual"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("knowledge_entries_org_idx").on(table.organizationId)],
);

export const insertKnowledgeEntrySchema = createInsertSchema(knowledgeEntriesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertKnowledgeEntry = z.infer<typeof insertKnowledgeEntrySchema>;
export type KnowledgeEntry = typeof knowledgeEntriesTable.$inferSelect;
