/**
 * Smart forms: org-configurable multi-step forms/assessments.
 *
 * - Definitions are sanitized here before storage; the public endpoint serves
 *   the sanitized definition verbatim, so nothing secret may enter `steps`.
 * - Branching (`showIf`) is evaluated server-side on submission too, so
 *   required-field validation and scoring only consider *visible* steps —
 *   the client runtime cannot be tricked into skipping required questions,
 *   and hidden-branch answers are dropped.
 * - Submissions dedupe into an existing open lead (same org + same phone
 *   digits or email) instead of spawning duplicates.
 */
import {
  activitiesTable,
  auditEventsTable,
  consentRecordsTable,
  contactsTable,
  db,
  FORM_FIELD_MAPPINGS,
  FORM_FIELD_TYPES,
  formsTable,
  formSubmissionsTable,
  leadsTable,
  propertiesTable,
  type FormCondition,
  type FormField,
  type FormRow,
  type FormSettings,
  type FormStep,
  type LeadStatus,
  type LeadScoringSettings,
  type Urgency,
} from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import {
  behaviorSignals,
  buildTouch,
  clampScore,
  leadAttributionColumns,
  repeatTouchColumns,
} from "./attribution";
import { providers } from "./providers";
import { getLeadScoring } from "./settings";

const MAX_STEPS = 20;
const MAX_FIELDS_PER_STEP = 30;
const MAX_OPTIONS = 30;
const MAX_TEXT_ANSWER = 4000;
const MAX_PHOTOS = 10;
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

const URGENCY_RANK: Record<Urgency, number> = { low: 0, normal: 1, high: 2, emergency: 3 };

/** Lead statuses a new submission may merge into (pre-won/lost pipeline). */
const OPEN_LEAD_STATUSES: LeadStatus[] = [
  "new",
  "ai_qualified",
  "contact_attempted",
  "inspection_scheduled",
  "inspection_completed",
  "estimate_preparing",
  "estimate_sent",
  "claim_pending",
  "follow_up",
  "nurture",
];

// ---------------------------------------------------------------------------
// Definition sanitization
// ---------------------------------------------------------------------------

function cleanText(v: unknown, max = 300): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

function sanitizeCondition(
  raw: unknown,
  knownKeys: Set<string>,
): FormCondition | null | undefined {
  if (raw == null) return undefined;
  const c = raw as FormCondition;
  if (!c.fieldKey || !knownKeys.has(c.fieldKey)) return null;
  if (!["eq", "ne", "in", "answered", "gte", "lte"].includes(c.op)) return null;
  if (c.op === "answered") return { fieldKey: c.fieldKey, op: "answered" };
  if (c.op === "in") {
    if (!Array.isArray(c.value) || c.value.length === 0 || c.value.length > MAX_OPTIONS) return null;
    return { fieldKey: c.fieldKey, op: "in", value: c.value.map((v) => String(v).slice(0, 200)) };
  }
  if (c.value === undefined || (typeof c.value !== "string" && typeof c.value !== "number")) {
    return null;
  }
  return {
    fieldKey: c.fieldKey,
    op: c.op,
    value: typeof c.value === "number" ? c.value : String(c.value).slice(0, 200),
  };
}

/**
 * Validate + normalize a form definition. Returns null (with a reason) when
 * structurally invalid. Field keys must be unique form-wide; conditions may
 * only reference fields defined in EARLIER steps (so branching is evaluable
 * in order).
 */
export function sanitizeFormDefinition(
  rawSteps: unknown,
  rawSettings?: unknown,
): { steps: FormStep[]; settings: FormSettings } | { error: string } {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return { error: "At least one step is required" };
  if (rawSteps.length > MAX_STEPS) return { error: `At most ${MAX_STEPS} steps` };

  const seenKeys = new Set<string>();
  const priorFieldKeys = new Set<string>();
  const steps: FormStep[] = [];

  for (const rawStep of rawSteps) {
    const s = rawStep as FormStep;
    if (!s || typeof s !== "object") return { error: "Invalid step" };
    const key = cleanText(s.key, 64);
    const title = cleanText(s.title, 200);
    if (!key || !KEY_RE.test(key)) return { error: `Invalid step key "${String(s.key)}"` };
    if (seenKeys.has(key)) return { error: `Duplicate key "${key}"` };
    seenKeys.add(key);
    if (!title) return { error: `Step "${key}" needs a title` };
    if (!Array.isArray(s.fields) || s.fields.length === 0) return { error: `Step "${key}" needs fields` };
    if (s.fields.length > MAX_FIELDS_PER_STEP) return { error: `Step "${key}" has too many fields` };

    const showIf = sanitizeCondition(s.showIf, priorFieldKeys);
    if (showIf === null) return { error: `Step "${key}" has an invalid branching rule` };

    const fields: FormField[] = [];
    for (const rawField of s.fields) {
      const f = rawField as FormField;
      const fKey = cleanText(f.key, 64);
      const label = cleanText(f.label, 300);
      if (!fKey || !KEY_RE.test(fKey)) return { error: `Invalid field key in step "${key}"` };
      if (seenKeys.has(fKey)) return { error: `Duplicate key "${fKey}"` };
      seenKeys.add(fKey);
      if (!label) return { error: `Field "${fKey}" needs a label` };
      if (!FORM_FIELD_TYPES.includes(f.type)) return { error: `Field "${fKey}" has unknown type` };

      const mapTo = f.mapTo ?? "none";
      if (!FORM_FIELD_MAPPINGS.includes(mapTo)) return { error: `Field "${fKey}" has unknown mapping` };

      let options: FormField["options"];
      if (f.type === "select" || f.type === "multiselect") {
        if (!Array.isArray(f.options) || f.options.length === 0) {
          return { error: `Field "${fKey}" needs options` };
        }
        if (f.options.length > MAX_OPTIONS) return { error: `Field "${fKey}" has too many options` };
        options = [];
        const seenValues = new Set<string>();
        for (const o of f.options) {
          const value = cleanText(o?.value, 200);
          const oLabel = cleanText(o?.label, 200) ?? value;
          if (!value || seenValues.has(value)) return { error: `Field "${fKey}" has invalid options` };
          seenValues.add(value);
          const urgency =
            o.urgency && ["low", "normal", "high", "emergency"].includes(o.urgency)
              ? o.urgency
              : undefined;
          options.push({ value, label: oLabel!, ...(urgency ? { urgency } : {}) });
        }
      }

      let scoring: FormField["scoring"];
      if (Array.isArray(f.scoring)) {
        scoring = [];
        for (const rule of f.scoring.slice(0, 10)) {
          const points = Number(rule?.points);
          const reason = cleanText(rule?.reason, 200);
          if (!Number.isFinite(points) || !reason) return { error: `Field "${fKey}" has invalid scoring` };
          let when: NonNullable<FormField["scoring"]>[number]["when"];
          if (rule.when) {
            const cond = sanitizeCondition({ ...rule.when, fieldKey: fKey }, new Set([fKey]));
            if (!cond) return { error: `Field "${fKey}" has an invalid scoring rule` };
            const { fieldKey: _fk, ...rest } = cond;
            when = rest;
          }
          scoring.push({
            points: Math.max(-100, Math.min(100, Math.round(points))),
            reason,
            ...(when ? { when } : {}),
          });
        }
      }

      const consentChannels =
        f.type === "consent"
          ? (Array.isArray(f.consentChannels) && f.consentChannels.length
              ? f.consentChannels.filter((ch) => ch === "sms" || ch === "email")
              : ["sms", "email"]) as Array<"sms" | "email">
          : undefined;

      fields.push({
        key: fKey,
        type: f.type,
        label,
        required: Boolean(f.required),
        ...(cleanText(f.placeholder) ? { placeholder: cleanText(f.placeholder) } : {}),
        ...(cleanText(f.helpText, 500) ? { helpText: cleanText(f.helpText, 500) } : {}),
        ...(options ? { options } : {}),
        mapTo,
        ...(scoring && scoring.length ? { scoring } : {}),
        ...(consentChannels ? { consentChannels } : {}),
      });
    }

    steps.push({
      key,
      title,
      ...(cleanText(s.description, 500) ? { description: cleanText(s.description, 500) } : {}),
      fields,
      ...(showIf ? { showIf } : {}),
    });
    for (const f of fields) priorFieldKeys.add(f.key);
  }

  // A usable form must be able to reach the CRM: require a phone or email
  // mapping and a first-name mapping somewhere in the form.
  const mappings = new Set(steps.flatMap((s) => s.fields.map((f) => f.mapTo)));
  if (!mappings.has("contact.phone") && !mappings.has("contact.email")) {
    return { error: "The form needs a field mapped to contact phone or email" };
  }
  if (!mappings.has("contact.firstName")) {
    return { error: "The form needs a field mapped to contact first name" };
  }

  const rawS = (rawSettings ?? {}) as FormSettings;
  const settings: FormSettings = {
    ...(rawS.confirmation
      ? {
          confirmation: {
            ...(cleanText(rawS.confirmation.emergency, 500) ? { emergency: cleanText(rawS.confirmation.emergency, 500) } : {}),
            ...(cleanText(rawS.confirmation.high, 500) ? { high: cleanText(rawS.confirmation.high, 500) } : {}),
            ...(cleanText(rawS.confirmation.default, 500) ? { default: cleanText(rawS.confirmation.default, 500) } : {}),
          },
        }
      : {}),
    ...(cleanText(rawS.defaultSource, 100) ? { defaultSource: cleanText(rawS.defaultSource, 100) } : {}),
    ...(cleanText(rawS.disclosureVersion, 100) ? { disclosureVersion: cleanText(rawS.disclosureVersion, 100) } : {}),
    ...(cleanText(rawS.submitLabel, 60) ? { submitLabel: cleanText(rawS.submitLabel, 60) } : {}),
  };

  return { steps, settings };
}

// ---------------------------------------------------------------------------
// Branching + answer validation
// ---------------------------------------------------------------------------

function answerMatches(cond: FormCondition, answers: Record<string, unknown>): boolean {
  const v = answers[cond.fieldKey];
  const answered = v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
  switch (cond.op) {
    case "answered":
      return answered;
    case "eq":
      return answered && String(v) === String(cond.value);
    case "ne":
      return !answered || String(v) !== String(cond.value);
    case "in":
      return (
        answered &&
        Array.isArray(cond.value) &&
        (Array.isArray(v)
          ? v.some((x) => (cond.value as unknown[]).map(String).includes(String(x)))
          : (cond.value as unknown[]).map(String).includes(String(v)))
      );
    case "gte":
      return answered && Number(v) >= Number(cond.value);
    case "lte":
      return answered && Number(v) <= Number(cond.value);
    default:
      return false;
  }
}

/** Steps visible for a given answer set (branching applied in order). */
export function visibleSteps(form: Pick<FormRow, "steps">, answers: Record<string, unknown>): FormStep[] {
  return form.steps.filter((s) => !s.showIf || answerMatches(s.showIf, answers));
}

/**
 * Validate raw answers against the definition. Returns cleaned answers
 * containing ONLY fields on visible steps, or an error string.
 */
export function validateAnswers(
  form: Pick<FormRow, "steps">,
  raw: unknown,
): { answers: Record<string, unknown> } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Invalid answers" };
  const input = raw as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};

  for (const step of form.steps) {
    if (step.showIf && !answerMatches(step.showIf, cleaned)) continue; // hidden branch: drop answers
    for (const f of step.fields) {
      const v = input[f.key];
      const missing = v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
      if (missing) {
        if (f.required) return { error: `"${f.label}" is required` };
        continue;
      }
      switch (f.type) {
        case "text":
        case "textarea":
        case "hidden":
          if (typeof v !== "string") return { error: `"${f.label}" must be text` };
          cleaned[f.key] = v.slice(0, f.type === "textarea" ? MAX_TEXT_ANSWER : 500);
          break;
        case "email": {
          if (typeof v !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())) {
            return { error: `"${f.label}" must be a valid email` };
          }
          cleaned[f.key] = v.trim().slice(0, 320);
          break;
        }
        case "phone": {
          const digits = typeof v === "string" ? v.replace(/\D/g, "") : "";
          if (digits.length < 7 || digits.length > 15) return { error: `"${f.label}" must be a valid phone number` };
          cleaned[f.key] = String(v).trim().slice(0, 40);
          break;
        }
        case "number": {
          const n = Number(v);
          if (!Number.isFinite(n)) return { error: `"${f.label}" must be a number` };
          cleaned[f.key] = n;
          break;
        }
        case "date": {
          if (typeof v !== "string" || Number.isNaN(Date.parse(v))) return { error: `"${f.label}" must be a date` };
          cleaned[f.key] = v.slice(0, 40);
          break;
        }
        case "checkbox":
        case "consent":
          if (f.required && v !== true) return { error: `"${f.label}" must be accepted` };
          cleaned[f.key] = v === true;
          break;
        case "select": {
          if (typeof v !== "string" || !f.options?.some((o) => o.value === v)) {
            return { error: `"${f.label}" has an invalid choice` };
          }
          cleaned[f.key] = v;
          break;
        }
        case "multiselect": {
          const arr = Array.isArray(v) ? v : [v];
          if (!arr.every((x) => typeof x === "string" && f.options?.some((o) => o.value === x))) {
            return { error: `"${f.label}" has an invalid choice` };
          }
          cleaned[f.key] = [...new Set(arr)].slice(0, MAX_OPTIONS);
          break;
        }
        case "photos": {
          const arr = Array.isArray(v) ? v : [];
          if (!arr.every((p) => typeof p === "string" && p.startsWith("/objects/"))) {
            return { error: `"${f.label}" has invalid uploads` };
          }
          cleaned[f.key] = arr.slice(0, MAX_PHOTOS);
          break;
        }
        default:
          return { error: `"${f.label}" has an unsupported type` };
      }
    }
  }
  return { answers: cleaned };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export function scoreFormSubmission(
  form: Pick<FormRow, "steps">,
  answers: Record<string, unknown>,
  weights: LeadScoringSettings,
): { score: number; scoreReasons: string[]; urgency: Urgency } {
  let score = 0;
  const reasons: string[] = [];
  const state: { urgency: Urgency } = { urgency: "normal" };

  const bump = (u?: Urgency) => {
    if (u && URGENCY_RANK[u] > URGENCY_RANK[state.urgency]) state.urgency = u;
  };

  for (const step of visibleSteps(form, answers)) {
    for (const f of step.fields) {
      const v = answers[f.key];
      const answered = v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0) && v !== false;
      if (!answered) continue;

      // Option-level urgency escalation + explicit urgency mapping.
      if (f.options) {
        const chosen = Array.isArray(v) ? v : [v];
        for (const c of chosen) bump(f.options.find((o) => o.value === c)?.urgency);
      }
      if (f.mapTo === "lead.urgency" && typeof v === "string" && v in URGENCY_RANK) {
        bump(v as Urgency);
      }

      for (const rule of f.scoring ?? []) {
        const matches = rule.when
          ? answerMatches({ ...rule.when, fieldKey: f.key }, answers)
          : true;
        if (matches) {
          score += rule.points;
          reasons.push(rule.reason);
        }
      }

      // Built-in bonuses from the org's lead-scoring settings.
      if (f.mapTo === "contact.email") {
        score += weights.emailProvidedBonus;
        reasons.push("Email provided");
      }
      if (f.type === "consent" && v === true && f.consentChannels?.includes("sms")) {
        score += weights.smsConsentBonus;
        reasons.push("SMS consent granted (fast follow-up possible)");
      }
      if (f.mapTo === "lead.description" && typeof v === "string" && v.length > 40) {
        score += weights.detailedDescriptionBonus;
        reasons.push("Detailed description provided");
      }
      if (f.type === "photos" && Array.isArray(v) && v.length > 0) {
        score += 10;
        reasons.push(`${v.length} photo${v.length === 1 ? "" : "s"} attached`);
      }
    }
  }

  if (state.urgency === "emergency") {
    score += weights.emergencyUrgencyBonus;
    reasons.push("Marked as emergency urgency");
  } else if (state.urgency === "high") {
    score += weights.highUrgencyBonus;
    reasons.push("High urgency");
  }

  return {
    score: Math.max(0, Math.min(Math.round(score), 100)),
    scoreReasons: reasons,
    urgency: state.urgency,
  };
}

// ---------------------------------------------------------------------------
// Mapped value extraction
// ---------------------------------------------------------------------------

function mappedValues(form: Pick<FormRow, "steps">, answers: Record<string, unknown>) {
  const out: Partial<Record<(typeof FORM_FIELD_MAPPINGS)[number], unknown>> = {};
  const consents: Array<{ field: FormField; granted: boolean }> = [];
  for (const step of visibleSteps(form, answers)) {
    for (const f of step.fields) {
      const v = answers[f.key];
      if (f.type === "consent") {
        consents.push({ field: f, granted: v === true });
        continue;
      }
      if (v === undefined || f.mapTo === "none" || !f.mapTo) continue;
      if (out[f.mapTo] === undefined) out[f.mapTo] = v;
    }
  }
  return { out, consents };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listForms(organizationId: string) {
  await ensureSeededForms(organizationId);
  return db
    .select()
    .from(formsTable)
    .where(eq(formsTable.organizationId, organizationId))
    .orderBy(desc(formsTable.createdAt));
}

export async function getForm(organizationId: string, id: string) {
  const [row] = await db
    .select()
    .from(formsTable)
    .where(and(eq(formsTable.id, id), eq(formsTable.organizationId, organizationId)));
  return row ?? null;
}

export async function createForm(
  organizationId: string,
  input: { name: string; slug: string; description?: string; steps: unknown; settings?: unknown; status?: string },
): Promise<FormRow | { error: string }> {
  const name = cleanText(input.name, 200);
  const slug = cleanText(input.slug, 64)?.toLowerCase();
  if (!name) return { error: "Name is required" };
  if (!slug || !SLUG_RE.test(slug)) return { error: "Slug must be lowercase letters, numbers, and dashes" };
  const def = sanitizeFormDefinition(input.steps, input.settings);
  if ("error" in def) return def;
  const status = input.status === "published" ? "published" : "draft";
  try {
    const [row] = await db
      .insert(formsTable)
      .values({
        organizationId,
        name,
        slug,
        description: cleanText(input.description, 500) ?? null,
        status,
        steps: def.steps,
        settings: def.settings,
      })
      .returning();
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) return { error: "A form with that slug already exists" };
    throw err;
  }
}

export async function updateForm(
  organizationId: string,
  id: string,
  input: Partial<{ name: string; slug: string; description: string; steps: unknown; settings: unknown; status: string }>,
): Promise<FormRow | { error: string } | null> {
  const existing = await getForm(organizationId, id);
  if (!existing) return null;

  const patch: Partial<typeof formsTable.$inferInsert> = {};
  if (input.name !== undefined) {
    const name = cleanText(input.name, 200);
    if (!name) return { error: "Name is required" };
    patch.name = name;
  }
  if (input.slug !== undefined) {
    const slug = cleanText(input.slug, 64)?.toLowerCase();
    if (!slug || !SLUG_RE.test(slug)) return { error: "Slug must be lowercase letters, numbers, and dashes" };
    patch.slug = slug;
  }
  if (input.description !== undefined) patch.description = cleanText(input.description, 500) ?? null;
  if (input.status !== undefined) {
    if (!["draft", "published", "archived"].includes(input.status)) return { error: "Invalid status" };
    patch.status = input.status as FormRow["status"];
  }
  if (input.steps !== undefined || input.settings !== undefined) {
    const def = sanitizeFormDefinition(
      input.steps ?? existing.steps,
      input.settings ?? existing.settings,
    );
    if ("error" in def) return def;
    patch.steps = def.steps;
    patch.settings = def.settings;
  }
  try {
    const [row] = await db
      .update(formsTable)
      .set(patch)
      .where(and(eq(formsTable.id, id), eq(formsTable.organizationId, organizationId)))
      .returning();
    return row ?? null;
  } catch (err) {
    if (isUniqueViolation(err)) return { error: "A form with that slug already exists" };
    throw err;
  }
}

/** Delete a form; forms with submissions are archived instead (audit trail). */
export async function deleteForm(
  organizationId: string,
  id: string,
): Promise<"deleted" | "archived" | null> {
  const existing = await getForm(organizationId, id);
  if (!existing) return null;
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(formSubmissionsTable)
    .where(and(eq(formSubmissionsTable.formId, id), eq(formSubmissionsTable.organizationId, organizationId)));
  if (n > 0) {
    await db
      .update(formsTable)
      .set({ status: "archived" })
      .where(and(eq(formsTable.id, id), eq(formsTable.organizationId, organizationId)));
    return "archived";
  }
  await db
    .delete(formsTable)
    .where(and(eq(formsTable.id, id), eq(formsTable.organizationId, organizationId)));
  return "deleted";
}

/** Full row of a published form (submission pipeline needs id + settings). */
export async function getPublicFormRow(organizationId: string, slug: string) {
  // Seed defaults on first public access too — otherwise an org's default
  // assessment link is dead until an admin opens the Forms page once.
  await ensureSeededForms(organizationId);
  const [row] = await db
    .select()
    .from(formsTable)
    .where(
      and(
        eq(formsTable.organizationId, organizationId),
        eq(formsTable.slug, slug.toLowerCase()),
        eq(formsTable.status, "published"),
      ),
    );
  return row ?? null;
}

/** Published form served to the public runtime (no org internals). */
export async function getPublicForm(organizationId: string, slug: string) {
  await ensureSeededForms(organizationId);
  const [row] = await db
    .select()
    .from(formsTable)
    .where(
      and(
        eq(formsTable.organizationId, organizationId),
        eq(formsTable.slug, slug.toLowerCase()),
        eq(formsTable.status, "published"),
      ),
    );
  if (!row) return null;
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    steps: row.steps,
    settings: { submitLabel: row.settings.submitLabel, disclosureVersion: row.settings.disclosureVersion },
  };
}

// ---------------------------------------------------------------------------
// Seeding: the Painless assessment as a form config
// ---------------------------------------------------------------------------

export const DEFAULT_ASSESSMENT_SEED_KEY = "default.assessment";

/** The original fixed roofing assessment, expressed as a form definition. */
export function defaultAssessmentForm(): { name: string; slug: string; description: string; steps: FormStep[]; settings: FormSettings } {
  return {
    name: "Free Roof Assessment",
    slug: "roof-assessment",
    description: "Multi-step damage assessment with photos and consent — the original website assessment flow.",
    steps: [
      {
        key: "situation",
        title: "What's going on?",
        description: "Help us understand the situation so we can prioritize correctly.",
        fields: [
          {
            key: "intent",
            type: "select",
            label: "What best describes your situation?",
            required: true,
            mapTo: "lead.serviceType",
            options: [
              { value: "active-leak", label: "Active leak — water is coming in", urgency: "emergency" },
              { value: "water-damage", label: "Water damage inside", urgency: "emergency" },
              { value: "storm", label: "Storm damage (wind or hail)", urgency: "high" },
              { value: "replacement", label: "Roof replacement" },
              { value: "general", label: "Something else / general question" },
            ],
            scoring: [
              { points: 40, reason: "Active leak reported", when: { op: "eq", value: "active-leak" } },
              { points: 35, reason: "Water damage reported", when: { op: "eq", value: "water-damage" } },
              { points: 30, reason: "Storm damage reported", when: { op: "eq", value: "storm" } },
              { points: 25, reason: "Full replacement interest", when: { op: "eq", value: "replacement" } },
              { points: 10, reason: "General inquiry", when: { op: "eq", value: "general" } },
            ],
          },
        ],
      },
      {
        key: "property",
        title: "Where is the property?",
        description: "We need the address to run digital property analytics.",
        fields: [
          { key: "address_line1", type: "text", label: "Street address", required: true, mapTo: "property.addressLine1" },
          { key: "address_line2", type: "text", label: "Apt, suite, etc. (optional)", mapTo: "property.addressLine2" },
          { key: "city", type: "text", label: "City", required: true, mapTo: "property.city" },
          { key: "state", type: "text", label: "State", required: true, mapTo: "property.state" },
          { key: "postal_code", type: "text", label: "ZIP", required: true, mapTo: "property.postalCode" },
        ],
      },
      {
        key: "context",
        title: "Provide context",
        description: "Describe what you're seeing, and attach photos of the damage if you have them.",
        fields: [
          { key: "description", type: "textarea", label: "What are you seeing?", mapTo: "lead.description" },
          { key: "photos", type: "photos", label: "Damage photos (optional)" },
        ],
      },
      {
        key: "contact",
        title: "Final step",
        description: "Where should we send your assessment?",
        fields: [
          { key: "first_name", type: "text", label: "First name", required: true, mapTo: "contact.firstName" },
          { key: "last_name", type: "text", label: "Last name", mapTo: "contact.lastName" },
          { key: "email", type: "email", label: "Email", mapTo: "contact.email" },
          { key: "phone", type: "phone", label: "Phone", required: true, mapTo: "contact.phone" },
          {
            key: "consent",
            type: "consent",
            label: "I agree to be contacted by phone, text, and email about my request.",
            required: true,
            consentChannels: ["sms", "email"],
          },
        ],
      },
    ],
    settings: {
      confirmation: {
        emergency: "This looks urgent. Our team treats active leaks and emergencies as same-day priorities — expect a call shortly.",
        high: "We prioritize storm and water-damage assessments. Expect contact within a few business hours.",
        default: "Thanks — your free assessment request is in. We'll reach out within one business day.",
      },
      disclosureVersion: "2026-08-01.v1",
      submitLabel: "Get my assessment",
    },
  };
}

/** Idempotently seed default forms (advisory-locked, keyed by seedKey). */
export async function ensureSeededForms(organizationId: string): Promise<void> {
  const existing = await db
    .select({ id: formsTable.id })
    .from(formsTable)
    .where(and(eq(formsTable.organizationId, organizationId), eq(formsTable.seedKey, DEFAULT_ASSESSMENT_SEED_KEY)))
    .limit(1);
  if (existing.length > 0) return;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId + ":forms-seed"}))`);
    const again = await tx
      .select({ id: formsTable.id })
      .from(formsTable)
      .where(and(eq(formsTable.organizationId, organizationId), eq(formsTable.seedKey, DEFAULT_ASSESSMENT_SEED_KEY)))
      .limit(1);
    if (again.length > 0) return;
    const seed = defaultAssessmentForm();
    await tx.insert(formsTable).values({
      organizationId,
      seedKey: DEFAULT_ASSESSMENT_SEED_KEY,
      name: seed.name,
      slug: seed.slug,
      description: seed.description,
      status: "published",
      steps: seed.steps,
      settings: seed.settings,
    });
  });
}

// ---------------------------------------------------------------------------
// Submission pipeline
// ---------------------------------------------------------------------------

const ATTRIBUTION_KEYS = [
  "landingPage",
  "referrer",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "utmTerm",
  "utmContent",
] as const;

function cleanAttribution(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const k of ATTRIBUTION_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, 500);
  }
  return out;
}

export async function captureFormSubmission(params: {
  organizationId: string;
  form: FormRow;
  answers: unknown;
  attribution?: unknown;
  anonymousId?: string;
  source?: string;
  sourceIp?: string;
  userAgent?: string;
}): Promise<
  | { error: string }
  | {
      submissionId: string;
      leadId: string;
      deduped: boolean;
      score: number;
      scoreReasons: string[];
      urgency: Urgency;
      guidance: string;
    }
> {
  const { organizationId, form } = params;
  const validated = validateAnswers(form, params.answers);
  if ("error" in validated) return validated;
  const answers = validated.answers;

  const weights = await getLeadScoring(organizationId);
  const scored = scoreFormSubmission(form, answers, weights);
  const { urgency } = scored;
  const behavior = await behaviorSignals(organizationId, params.anonymousId, weights);
  const score = clampScore(scored.score + behavior.points);
  const scoreReasons = [...scored.scoreReasons, ...behavior.reasons];
  const { out: mapped, consents } = mappedValues(form, answers);
  const attribution = cleanAttribution(params.attribution);
  const source =
    cleanText(params.source, 100) ?? form.settings.defaultSource ?? `form:${form.slug}`;

  const phone = typeof mapped["contact.phone"] === "string" ? (mapped["contact.phone"] as string) : null;
  const email = typeof mapped["contact.email"] === "string" ? (mapped["contact.email"] as string) : null;
  const phoneDigits = phone ? phone.replace(/\D/g, "") : null;

  const description =
    typeof mapped["lead.description"] === "string" ? (mapped["lead.description"] as string) : null;
  const serviceType =
    typeof mapped["lead.serviceType"] === "string" ? (mapped["lead.serviceType"] as string) : form.slug;

  const ai = await providers.ai.summarizeLead({
    description: description ?? undefined,
    intent: serviceType,
    urgency,
  });

  // ---- dedupe: same org + same phone digits or email → existing contact ----
  let existingContact: { id: string } | null = null;
  if (phoneDigits || email) {
    const conditions = [];
    if (phoneDigits) {
      conditions.push(sql`regexp_replace(coalesce(${contactsTable.phone}, ''), '\\D', '', 'g') = ${phoneDigits}`);
    }
    if (email) {
      conditions.push(sql`lower(coalesce(${contactsTable.email}, '')) = ${email.toLowerCase()}`);
    }
    const [row] = await db
      .select({ id: contactsTable.id })
      .from(contactsTable)
      .where(and(eq(contactsTable.organizationId, organizationId), sql`(${sql.join(conditions, sql` OR `)})`))
      .orderBy(desc(contactsTable.createdAt))
      .limit(1);
    existingContact = row ?? null;
  }

  let existingLead: {
    id: string;
    score: number | null;
    anonymousId: string | null;
    campaign: string | null;
  } | null = null;
  if (existingContact) {
    const [row] = await db
      .select({
        id: leadsTable.id,
        score: leadsTable.score,
        anonymousId: leadsTable.anonymousId,
        campaign: leadsTable.campaign,
      })
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.organizationId, organizationId),
          eq(leadsTable.contactId, existingContact.id),
          inArray(leadsTable.status, OPEN_LEAD_STATUSES),
        ),
      )
      .orderBy(desc(leadsTable.createdAt))
      .limit(1);
    existingLead = row ?? null;
  }

  const photoPaths = Object.values(answers)
    .filter((v): v is string[] => Array.isArray(v) && v.every((p) => typeof p === "string" && p.startsWith("/objects/")))
    .flat();

  const touch = buildTouch({ channel: "web", source, attribution });

  const result = await db.transaction(async (tx) => {
    let contactId: string;
    if (existingContact) {
      contactId = existingContact.id;
    } else {
      const [contact] = await tx
        .insert(contactsTable)
        .values({
          organizationId,
          firstName: String(mapped["contact.firstName"] ?? "Unknown").slice(0, 100),
          lastName: mapped["contact.lastName"] ? String(mapped["contact.lastName"]).slice(0, 100) : null,
          email,
          phone: phone ?? "",
        })
        .returning();
      contactId = contact.id;
    }

    let propertyId: string | null = null;
    if (mapped["property.addressLine1"]) {
      const [property] = await tx
        .insert(propertiesTable)
        .values({
          organizationId,
          contactId,
          addressLine1: String(mapped["property.addressLine1"]).slice(0, 300),
          addressLine2: mapped["property.addressLine2"] ? String(mapped["property.addressLine2"]).slice(0, 300) : null,
          city: String(mapped["property.city"] ?? "").slice(0, 100),
          state: String(mapped["property.state"] ?? "").slice(0, 50),
          postalCode: String(mapped["property.postalCode"] ?? "").slice(0, 20),
        })
        .returning();
      propertyId = property.id;
    }

    let leadId: string;
    if (existingLead) {
      leadId = existingLead.id;
      await tx
        .update(leadsTable)
        .set({
          ...repeatTouchColumns({
            source,
            touch,
            existing: existingLead,
            anonymousId: params.anonymousId,
          }),
          urgency: sql`CASE WHEN ${leadsTable.urgency} = 'emergency' THEN ${leadsTable.urgency} ELSE ${urgency}::urgency END`,
          score: Math.max(existingLead.score ?? 0, score),
          scoreReasons,
        })
        .where(and(eq(leadsTable.id, leadId), eq(leadsTable.organizationId, organizationId)));
    } else {
      const [lead] = await tx
        .insert(leadsTable)
        .values({
          organizationId,
          contactId,
          propertyId,
          status: "new",
          urgency,
          serviceType,
          score,
          scoreReasons,
          summary: ai.summary,
          ...leadAttributionColumns({
            source,
            creationMethod: "form",
            touch,
            anonymousId: params.anonymousId,
          }),
        })
        .returning();
      leadId = lead.id;
    }

    if (consents.length > 0) {
      const disclosureVersion = form.settings.disclosureVersion ?? "form.v1";
      const rows = consents.flatMap(({ field, granted }) =>
        (field.consentChannels ?? ["sms", "email"]).map((channel) => ({
          organizationId,
          contactId,
          channel,
          granted,
          disclosureVersion,
          sourceIp: params.sourceIp ?? null,
          userAgent: params.userAgent ?? null,
        })),
      );
      if (rows.length) await tx.insert(consentRecordsTable).values(rows);
    }

    const [submission] = await tx
      .insert(formSubmissionsTable)
      .values({
        organizationId,
        formId: form.id,
        leadId,
        contactId,
        answers,
        attribution,
        dedupedIntoExistingLead: existingLead ? "existing_lead" : "new_lead",
        sourceIp: params.sourceIp ?? null,
        userAgent: params.userAgent ?? null,
      })
      .returning();

    await tx.insert(activitiesTable).values({
      organizationId,
      leadId,
      contactId,
      type: "lead_captured",
      title: existingLead
        ? `Repeat submission via "${form.name}" form merged into existing lead`
        : `"${form.name}" form submitted`,
      body: description,
      metadata: {
        formId: form.id,
        formSlug: form.slug,
        submissionId: submission.id,
        score,
        scoreReasons,
        attribution,
        aiProvider: ai.provider,
      },
    });

    if (photoPaths.length > 0) {
      await tx.insert(activitiesTable).values({
        organizationId,
        leadId,
        contactId,
        type: "photos_attached",
        title: `Visitor attached ${photoPaths.length} photo${photoPaths.length === 1 ? "" : "s"}`,
        body: null,
        metadata: { photoPaths },
      });
    }

    await tx.insert(auditEventsTable).values({
      organizationId,
      actorUserId: null,
      action: "lead.captured_form",
      entityType: "lead",
      entityId: leadId,
      metadata: { formId: form.id, formSlug: form.slug, source, deduped: Boolean(existingLead) },
    });

    return { submissionId: submission.id, leadId, deduped: Boolean(existingLead) };
  });

  const confirmation = form.settings.confirmation ?? {};
  const guidance =
    (urgency === "emergency" && confirmation.emergency) ||
    (urgency === "high" && confirmation.high) ||
    confirmation.default ||
    "Thanks — your request is in. We'll reach out within one business day.";

  return { ...result, score, scoreReasons, urgency, guidance };
}

export async function listFormSubmissions(organizationId: string, formId: string, limit = 100) {
  return db
    .select()
    .from(formSubmissionsTable)
    .where(and(eq(formSubmissionsTable.organizationId, organizationId), eq(formSubmissionsTable.formId, formId)))
    .orderBy(desc(formSubmissionsTable.createdAt))
    .limit(Math.min(limit, 200));
}
