import {
  boolean,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { messageChannelEnum } from "./enums";
import { organizationsTable } from "./organizations";

export const messageTemplatesTable = pgTable(
  "message_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    name: text("name").notNull(),
    channel: messageChannelEnum("channel").notNull(),
    /** Email only; ignored for SMS. */
    subject: text("subject"),
    /** Body with {{placeholders}}: contact.firstName, lead.serviceType, business.phone, ... */
    body: text("body").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("message_templates_org_name_idx").on(
      table.organizationId,
      table.name,
    ),
  ],
);

export const insertMessageTemplateSchema = createInsertSchema(
  messageTemplatesTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertMessageTemplate = z.infer<typeof insertMessageTemplateSchema>;
export type MessageTemplate = typeof messageTemplatesTable.$inferSelect;
