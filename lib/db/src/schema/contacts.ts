import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

export const contactsTable = pgTable(
  "contacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    firstName: text("first_name").notNull(),
    lastName: text("last_name"),
    email: text("email"),
    phone: text("phone"),
    preferredContactMethod: text("preferred_contact_method"),
    /** Hard do-not-contact flag: blocks ALL automated outreach on every channel. */
    doNotContact: boolean("do_not_contact").notNull().default(false),
    /**
     * Per-channel do-not-contact flags, set automatically on hard bounce /
     * unsubscribe / STOP. Blocks that channel only — the other channel can
     * keep sending (subject to its own consent and suppression checks).
     */
    doNotContactEmail: boolean("do_not_contact_email").notNull().default(false),
    doNotContactSms: boolean("do_not_contact_sms").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("contacts_org_phone_idx").on(table.organizationId, table.phone),
    index("contacts_org_email_idx").on(table.organizationId, table.email),
  ],
);

export const insertContactSchema = createInsertSchema(contactsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertContact = z.infer<typeof insertContactSchema>;
export type Contact = typeof contactsTable.$inferSelect;
