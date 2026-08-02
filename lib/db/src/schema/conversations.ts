import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { contactsTable } from "./contacts";
import {
  conversationRoleEnum,
  conversationStatusEnum,
  urgencyEnum,
} from "./enums";
import { leadsTable } from "./leads";
import { organizationsTable } from "./organizations";

/**
 * AI Concierge conversations. `state` holds the dialogue slot-filling state so
 * abandoned chats can resume and partial leads are progressively updated.
 */
export const conversationsTable = pgTable(
  "conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    leadId: uuid("lead_id").references(() => leadsTable.id),
    contactId: uuid("contact_id").references(() => contactsTable.id),
    channel: text("channel").notNull().default("web_chat"),
    status: conversationStatusEnum("status").notNull().default("active"),
    intent: text("intent"),
    urgency: urgencyEnum("urgency"),
    state: jsonb("state").$type<Record<string, unknown>>().notNull().default({}),
    salesSummary: text("sales_summary"),
    source: text("source"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("conversations_org_lead_idx").on(table.organizationId, table.leadId),
    index("conversations_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
  ],
);

export const conversationMessagesTable = pgTable(
  "conversation_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversationsTable.id),
    role: conversationRoleEnum("role").notNull(),
    content: text("content").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("conversation_messages_conv_idx").on(
      table.conversationId,
      table.createdAt,
    ),
  ],
);

export const insertConversationSchema = createInsertSchema(
  conversationsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertConversation = z.infer<typeof insertConversationSchema>;
export type Conversation = typeof conversationsTable.$inferSelect;

export const insertConversationMessageSchema = createInsertSchema(
  conversationMessagesTable,
).omit({ id: true, createdAt: true });
export type InsertConversationMessage = z.infer<
  typeof insertConversationMessageSchema
>;
export type ConversationMessage =
  typeof conversationMessagesTable.$inferSelect;
