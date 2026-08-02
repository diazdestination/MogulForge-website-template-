import {
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";
import { organizationsTable } from "./organizations";

export type AssistantHistoryMessage = {
  role: "user" | "assistant";
  content: string;
  toolsRun?: string[];
};

export const assistantHistoryTable = pgTable(
  "assistant_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    userId: varchar("user_id")
      .notNull()
      .references(() => usersTable.id),
    messages: jsonb("messages")
      .$type<AssistantHistoryMessage[]>()
      .notNull()
      .default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("assistant_history_org_user_uniq").on(
      table.organizationId,
      table.userId,
    ),
  ],
);

export type AssistantHistory = typeof assistantHistoryTable.$inferSelect;
