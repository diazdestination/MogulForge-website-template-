import {
  boolean,
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
import { webhookDeliveryStatusEnum } from "./enums";
import { organizationsTable } from "./organizations";

export const webhookEndpointsTable = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    url: text("url").notNull(),
    /**
     * HMAC-SHA256 signing secret, encrypted at rest (AES-256-GCM,
     * `enc:v1:` prefix). Plaintext is returned only once on creation.
     */
    secret: text("secret").notNull(),
    /**
     * Previous signing secret kept during a rotation grace window
     * (encrypted at rest). Deliveries carry signatures for both secrets
     * until `previousSecretExpiresAt`, then this is ignored.
     */
    previousSecret: text("previous_secret"),
    /** When the previous secret stops being honored. Null = no grace window. */
    previousSecretExpiresAt: timestamp("previous_secret_expires_at", {
      withTimezone: true,
    }),
    /** Event keys this endpoint subscribes to; empty = all events. */
    events: jsonb("events").$type<string[]>().notNull().default([]),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("webhook_endpoints_org_idx").on(table.organizationId)],
);

export const webhookDeliveriesTable = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => webhookEndpointsTable.id),
    event: text("event").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /**
     * Last-sent X-Painless-Signature header value
     * (`t=<unix_ts>,v1=<hex hmac>`), recomputed at each send attempt.
     */
    signature: text("signature").notNull(),
    /** Signing scheme version used for this delivery (currently "v1"). */
    signatureVersion: text("signature_version").notNull().default("v1"),
    status: webhookDeliveryStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    responseStatus: integer("response_status"),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("webhook_deliveries_org_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    index("webhook_deliveries_status_next_idx").on(
      table.status,
      table.nextAttemptAt,
    ),
  ],
);

export const insertWebhookEndpointSchema = createInsertSchema(
  webhookEndpointsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertWebhookEndpoint = z.infer<typeof insertWebhookEndpointSchema>;
export type WebhookEndpoint = typeof webhookEndpointsTable.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveriesTable.$inferSelect;
