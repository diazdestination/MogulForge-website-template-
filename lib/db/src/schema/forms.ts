import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { contactsTable } from "./contacts";
import { leadsTable } from "./leads";
import { organizationsTable } from "./organizations";

/**
 * Smart forms: org-configurable multi-step forms/assessments rendered by the
 * embeddable runtime (forms.js) and by hosted MogulForge pages.
 *
 * The definition lives in jsonb (steps → fields) and is validated/sanitized
 * at the API layer before storage; the public endpoint serves it verbatim, so
 * nothing secret may ever be stored inside `steps` or `settings`.
 */

export const FORM_FIELD_TYPES = [
  "text",
  "textarea",
  "email",
  "phone",
  "select",
  "multiselect",
  "checkbox",
  "number",
  "date",
  "photos",
  "consent",
  "hidden",
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

/** Where a field's answer lands in the CRM besides the raw submission. */
export const FORM_FIELD_MAPPINGS = [
  "contact.firstName",
  "contact.lastName",
  "contact.email",
  "contact.phone",
  "property.addressLine1",
  "property.addressLine2",
  "property.city",
  "property.state",
  "property.postalCode",
  "lead.description",
  "lead.serviceType",
  "lead.urgency",
  "lead.budget",
  "lead.timeline",
  "lead.insurance",
  "none",
] as const;
export type FormFieldMapping = (typeof FORM_FIELD_MAPPINGS)[number];

/** Condition ops for branching + conditional scoring. */
export interface FormCondition {
  /** Key of a previously answered field. */
  fieldKey: string;
  op: "eq" | "ne" | "in" | "answered" | "gte" | "lte";
  /** Comparison value(s); unused for `answered`. */
  value?: string | number | Array<string | number>;
}

export interface FormFieldScoring {
  /** Points added when the rule matches (clamped 0-100 total). */
  points: number;
  /** Score reason shown to reps. */
  reason: string;
  /** Optional condition; default = field answered (truthy). */
  when?: Omit<FormCondition, "fieldKey">;
}

export interface FormFieldOption {
  value: string;
  label: string;
  /** Optional urgency escalation when this option is chosen. */
  urgency?: "low" | "normal" | "high" | "emergency";
}

export interface FormField {
  /** Stable key, unique across the whole form (a-z0-9_-). */
  key: string;
  type: FormFieldType;
  label: string;
  required?: boolean;
  placeholder?: string;
  helpText?: string;
  /** For select/multiselect. */
  options?: FormFieldOption[];
  /** CRM mapping; defaults to "none" (stored on the submission only). */
  mapTo?: FormFieldMapping;
  /** Conditional scoring rules evaluated on submission. */
  scoring?: FormFieldScoring[];
  /** Consent fields: which channels this consent covers. */
  consentChannels?: Array<"sms" | "email">;
  /** Hidden fields: value pinned server-side is NOT supported; value comes from the page (e.g. campaign codes). */
  maxLength?: number;
}

export interface FormStep {
  key: string;
  title: string;
  description?: string;
  fields: FormField[];
  /** Step is shown only when the condition matches (evaluated client + server). */
  showIf?: FormCondition;
}

export interface FormSettings {
  /** Confirmation copy after submit, per resulting urgency. */
  confirmation?: Partial<Record<"emergency" | "high" | "default", string>>;
  /** Default lead source recorded when the page passes none. */
  defaultSource?: string;
  /** Consent disclosure version stamped on consent records. */
  disclosureVersion?: string;
  /** Submit button label. */
  submitLabel?: string;
}

export const formsTable = pgTable(
  "forms",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    /** URL-safe identifier used by embeds and hosted pages; unique per org. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").$type<"draft" | "published" | "archived">().notNull().default("draft"),
    /** Immutable key for system-seeded forms (e.g. "default.assessment"). */
    seedKey: text("seed_key"),
    steps: jsonb("steps").$type<FormStep[]>().notNull().default([]),
    settings: jsonb("settings").$type<FormSettings>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("forms_org_slug_idx").on(table.organizationId, table.slug),
    uniqueIndex("forms_org_seed_key_idx")
      .on(table.organizationId, table.seedKey)
      .where(sql`${table.seedKey} is not null`),
  ],
);

export const formSubmissionsTable = pgTable(
  "form_submissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    formId: uuid("form_id")
      .notNull()
      .references(() => formsTable.id),
    leadId: uuid("lead_id").references(() => leadsTable.id),
    contactId: uuid("contact_id").references(() => contactsTable.id),
    /** Raw answers keyed by field key (validated against the definition). */
    answers: jsonb("answers").$type<Record<string, unknown>>().notNull().default({}),
    /** Marketing attribution captured by the runtime (utm/referrer/landing page). */
    attribution: jsonb("attribution").$type<Record<string, string>>().notNull().default({}),
    /** True when the submission updated an existing open lead instead of creating one. */
    dedupedIntoExistingLead: text("dedupe_outcome")
      .$type<"new_lead" | "existing_lead">()
      .notNull()
      .default("new_lead"),
    sourceIp: text("source_ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("form_submissions_org_form_idx").on(table.organizationId, table.formId),
    index("form_submissions_org_lead_idx").on(table.organizationId, table.leadId),
  ],
);

export type FormRow = typeof formsTable.$inferSelect;
export type FormSubmissionRow = typeof formSubmissionsTable.$inferSelect;
