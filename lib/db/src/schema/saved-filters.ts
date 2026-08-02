import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./auth";
import { organizationsTable } from "./organizations";

export const savedFiltersTable = pgTable(
  "saved_filters",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id),
    name: text("name").notNull(),
    filters: jsonb("filters")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("saved_filters_org_user_idx").on(table.organizationId, table.userId),
  ],
);

export const insertSavedFilterSchema = createInsertSchema(
  savedFiltersTable,
).omit({
  id: true,
  createdAt: true,
});
export type InsertSavedFilter = z.infer<typeof insertSavedFilterSchema>;
export type SavedFilter = typeof savedFiltersTable.$inferSelect;
