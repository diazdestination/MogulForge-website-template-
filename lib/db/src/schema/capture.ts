import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { leadsTable } from "./leads";
import { organizationsTable } from "./organizations";

/**
 * External lead capture: inbound webhook/form-post endpoints with per-org
 * field mapping, so leads from a client's existing website forms and
 * outside systems (Zapier/Make/n8n) flow into the standard pipeline.
 */

/**
 * Mapping from EXTERNAL payload field names to MogulForge lead fields.
 * Keys are the external names (e.g. "your-email"), values are internal
 * field names from CAPTURE_TARGET_FIELDS.
 */
export type CaptureFieldMapping = Record<string, string>;

/** Internal fields an external payload can map onto. */
export const CAPTURE_TARGET_FIELDS = [
  "firstName",
  "lastName",
  "fullName",
  "email",
  "phone",
  "addressLine1",
  "city",
  "state",
  "postalCode",
  "message",
  "source",
  "campaign",
  "externalId",
] as const;
export type CaptureTargetField = (typeof CAPTURE_TARGET_FIELDS)[number];

export const captureEndpointsTable = pgTable(
  "capture_endpoints",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    name: text("name").notNull(),
    /** Public URL token (`cap_...`). Identifies org + endpoint on the public route. */
    token: text("token").notNull(),
    mapping: jsonb("mapping")
      .$type<CaptureFieldMapping>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Attribution source recorded on captured leads (e.g. "website-form"). */
    defaultSource: text("default_source").notNull().default("external-form"),
    isActive: boolean("is_active").notNull().default(true),
    lastReceivedAt: timestamp("last_received_at", { withTimezone: true }),
    receivedCount: integer("received_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("capture_endpoints_token_uq").on(t.token),
    index("capture_endpoints_org_idx").on(t.organizationId),
  ],
);
export type CaptureEndpoint = typeof captureEndpointsTable.$inferSelect;

/**
 * One row per accepted inbound delivery. The unique (endpoint, idempotency
 * key) index makes duplicate webhook deliveries safe: replays return the
 * original result instead of creating a second lead.
 */
export const captureDeliveriesTable = pgTable(
  "capture_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => captureEndpointsTable.id),
    /** Caller-supplied idempotency key; null for non-idempotent posts. */
    idempotencyKey: text("idempotency_key"),
    leadId: uuid("lead_id").references(() => leadsTable.id),
    /** "created" | "merged" (deduped into an existing lead) | "rejected" */
    outcome: text("outcome").notNull(),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("capture_deliveries_idem_uq")
      .on(t.endpointId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    index("capture_deliveries_org_idx").on(t.organizationId, t.createdAt),
  ],
);
export type CaptureDelivery = typeof captureDeliveriesTable.$inferSelect;

/**
 * Idempotency keys for the authenticated lead API (x-idempotency-key).
 * The stored response is replayed verbatim for retried requests.
 */
export const apiIdempotencyKeysTable = pgTable(
  "api_idempotency_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    /** Route scope, e.g. "leads.create", so keys never collide across endpoints. */
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBody: jsonb("response_body").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("api_idempotency_org_scope_key_uq").on(t.organizationId, t.scope, t.key),
  ],
);
export type ApiIdempotencyKey = typeof apiIdempotencyKeysTable.$inferSelect;
