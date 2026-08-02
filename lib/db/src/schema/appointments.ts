import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./auth";
import { contactsTable } from "./contacts";
import { appointmentStatusEnum, appointmentTypeEnum } from "./enums";
import { leadsTable } from "./leads";
import { organizationsTable } from "./organizations";
import { propertiesTable } from "./properties";

export const appointmentsTable = pgTable(
  "appointments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    leadId: uuid("lead_id").references(() => leadsTable.id),
    contactId: uuid("contact_id").references(() => contactsTable.id),
    propertyId: uuid("property_id").references(() => propertiesTable.id),
    assignedUserId: varchar("assigned_user_id").references(() => usersTable.id),
    type: appointmentTypeEnum("type").notNull().default("inspection"),
    status: appointmentStatusEnum("status").notNull().default("scheduled"),
    scheduledStart: timestamp("scheduled_start", {
      withTimezone: true,
    }).notNull(),
    scheduledEnd: timestamp("scheduled_end", { withTimezone: true }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("appointments_org_start_idx").on(
      table.organizationId,
      table.scheduledStart,
    ),
    index("appointments_org_assigned_idx").on(
      table.organizationId,
      table.assignedUserId,
    ),
  ],
);

export const insertAppointmentSchema = createInsertSchema(
  appointmentsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAppointment = z.infer<typeof insertAppointmentSchema>;
export type Appointment = typeof appointmentsTable.$inferSelect;
