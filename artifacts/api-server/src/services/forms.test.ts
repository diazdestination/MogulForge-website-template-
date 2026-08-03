/**
 * Smart forms: definition sanitization, branching, dedupe, attribution,
 * scoring, seeding, and tenant isolation.
 */
import { db, leadsTable, organizationsTable, DEFAULT_LEAD_SCORING } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

import {
  captureFormSubmission,
  createForm,
  defaultAssessmentForm,
  deleteForm,
  ensureSeededForms,
  getForm,
  getPublicForm,
  getPublicFormRow,
  listForms,
  listFormSubmissions,
  sanitizeFormDefinition,
  scoreFormSubmission,
  updateForm,
  validateAnswers,
  visibleSteps,
} from "./forms";

let org: { id: string };
let otherOrg: { id: string };

beforeAll(async () => {
  const stamp = Date.now();
  const [a] = await db
    .insert(organizationsTable)
    .values({ name: "Forms Test Org", slug: `test-forms-${stamp}` })
    .returning();
  org = a;
  const [b] = await db
    .insert(organizationsTable)
    .values({ name: "Forms Other Org", slug: `test-forms-b-${stamp}` })
    .returning();
  otherOrg = b;
});

afterAll(async () => {
  await deleteTestOrgs(org.id, otherOrg.id);
});

// A small valid definition with branching used across tests.
function branchingSteps() {
  return [
    {
      key: "service",
      title: "What do you need?",
      fields: [
        {
          key: "service_type",
          type: "select",
          label: "Service",
          required: true,
          mapTo: "lead.serviceType",
          options: [
            { value: "roof", label: "Roofing", urgency: "high" },
            { value: "gutters", label: "Gutters" },
          ],
          scoring: [
            { points: 30, reason: "Roofing request", when: { op: "eq", value: "roof" } },
            { points: 10, reason: "Gutter request", when: { op: "eq", value: "gutters" } },
          ],
        },
      ],
    },
    {
      key: "roof_details",
      title: "Roof details",
      showIf: { fieldKey: "service_type", op: "eq", value: "roof" },
      fields: [
        {
          key: "leak_now",
          type: "checkbox",
          label: "Is water actively coming in?",
          scoring: [{ points: 40, reason: "Active leak", when: { op: "eq", value: "true" } }],
        },
      ],
    },
    {
      key: "contact",
      title: "Contact",
      fields: [
        { key: "first_name", type: "text", label: "First name", required: true, mapTo: "contact.firstName" },
        { key: "phone", type: "phone", label: "Phone", required: true, mapTo: "contact.phone" },
        { key: "email", type: "email", label: "Email", mapTo: "contact.email" },
        { key: "consent", type: "consent", label: "OK to contact me", required: true, consentChannels: ["sms", "email"] },
      ],
    },
  ];
}

describe("sanitizeFormDefinition", () => {
  it("rejects structural problems", () => {
    expect(sanitizeFormDefinition([])).toHaveProperty("error");
    expect(sanitizeFormDefinition([{ key: "a", title: "A", fields: [] }])).toHaveProperty("error");
    // duplicate keys
    expect(
      sanitizeFormDefinition([
        { key: "a", title: "A", fields: [{ key: "x", type: "text", label: "X" }, { key: "x", type: "text", label: "X2" }] },
      ]),
    ).toHaveProperty("error");
    // condition referencing a later/unknown field
    expect(
      sanitizeFormDefinition([
        {
          key: "a",
          title: "A",
          showIf: { fieldKey: "nope", op: "eq", value: "1" },
          fields: [{ key: "x", type: "text", label: "X", mapTo: "contact.firstName" }],
        },
      ]),
    ).toHaveProperty("error");
    // missing contact mappings
    expect(
      sanitizeFormDefinition([{ key: "a", title: "A", fields: [{ key: "x", type: "text", label: "X" }] }]),
    ).toHaveProperty("error");
  });

  it("accepts and normalizes a valid branching definition", () => {
    const result = sanitizeFormDefinition(branchingSteps());
    expect(result).not.toHaveProperty("error");
    const { steps } = result as { steps: any[] };
    expect(steps).toHaveLength(3);
    expect(steps[1].showIf).toEqual({ fieldKey: "service_type", op: "eq", value: "roof" });
    expect(steps[0].fields[0].options[0].urgency).toBe("high");
  });
});

describe("branching + answer validation", () => {
  const form = { steps: (sanitizeFormDefinition(branchingSteps()) as any).steps };

  it("hides branched steps and drops their answers when the branch is off", () => {
    const visible = visibleSteps(form, { service_type: "gutters" });
    expect(visible.map((s: any) => s.key)).toEqual(["service", "contact"]);

    const cleaned = validateAnswers(form, {
      service_type: "gutters",
      leak_now: true, // hidden branch — must be dropped
      first_name: "Ann",
      phone: "555-000-1111",
      consent: true,
    });
    expect(cleaned).not.toHaveProperty("error");
    expect((cleaned as any).answers.leak_now).toBeUndefined();
  });

  it("enforces required fields only on visible steps and rejects bad values", () => {
    expect(
      validateAnswers(form, { service_type: "roof", first_name: "Ann", phone: "555", consent: true }),
    ).toHaveProperty("error"); // bad phone
    expect(
      validateAnswers(form, { service_type: "bogus", first_name: "Ann", phone: "5550001111", consent: true }),
    ).toHaveProperty("error"); // invalid select choice
    expect(
      validateAnswers(form, { service_type: "roof", first_name: "Ann", phone: "5550001111", consent: false }),
    ).toHaveProperty("error"); // consent required
  });
});

describe("scoreFormSubmission", () => {
  const form = { steps: (sanitizeFormDefinition(branchingSteps()) as any).steps };

  it("applies conditional scoring, option urgency, and built-in bonuses", () => {
    const answers = {
      service_type: "roof",
      leak_now: true,
      first_name: "Ann",
      phone: "5550001111",
      email: "ann@example.com",
      consent: true,
    };
    const { score, scoreReasons, urgency } = scoreFormSubmission(form as any, answers, DEFAULT_LEAD_SCORING);
    expect(urgency).toBe("high"); // from the chosen option
    expect(scoreReasons).toContain("Roofing request");
    expect(scoreReasons).toContain("Active leak");
    expect(scoreReasons).toContain("Email provided");
    expect(scoreReasons).toContain("SMS consent granted (fast follow-up possible)");
    expect(score).toBeGreaterThan(50);
  });

  it("skips scoring rules on hidden branches", () => {
    const { scoreReasons } = scoreFormSubmission(
      form as any,
      { service_type: "gutters", leak_now: true, first_name: "A", phone: "5550001111" },
      DEFAULT_LEAD_SCORING,
    );
    expect(scoreReasons).not.toContain("Active leak");
    expect(scoreReasons).toContain("Gutter request");
  });
});

describe("CRUD + tenant isolation + seeding", () => {
  it("creates, updates, and deletes forms org-scoped; slugs unique per org", async () => {
    const created = await createForm(org.id, {
      name: "Test Intake",
      slug: "test-intake",
      steps: branchingSteps(),
    });
    expect(created).not.toHaveProperty("error");
    const formId = (created as { id: string }).id;

    // Same slug in the same org fails; other org is fine.
    expect(await createForm(org.id, { name: "Dup", slug: "test-intake", steps: branchingSteps() })).toHaveProperty("error");
    const other = await createForm(otherOrg.id, { name: "Other", slug: "test-intake", steps: branchingSteps() });
    expect(other).not.toHaveProperty("error");

    // Cross-org reads/updates fail.
    expect(await getForm(otherOrg.id, formId)).toBeNull();
    expect(await updateForm(otherOrg.id, formId, { name: "Hacked" })).toBeNull();

    // Publish and read via the public accessor — only for the owning org.
    const published = await updateForm(org.id, formId, { status: "published" });
    expect(published).toMatchObject({ status: "published" });
    expect(await getPublicForm(org.id, "test-intake")).not.toBeNull();

    expect(await deleteForm(otherOrg.id, formId)).toBeNull();
    expect(await deleteForm(org.id, formId)).toBe("deleted");
  });

  it("seeds the default assessment once, idempotently", async () => {
    await ensureSeededForms(org.id);
    await ensureSeededForms(org.id);
    const forms = await listForms(org.id); // listForms also triggers seeding
    const seeded = forms.filter((f) => f.seedKey === "default.assessment");
    expect(seeded).toHaveLength(1);
    expect(seeded[0].status).toBe("published");
    expect(seeded[0].slug).toBe(defaultAssessmentForm().slug);
    // The seeded definition itself passes sanitization.
    const def = defaultAssessmentForm();
    expect(sanitizeFormDefinition(def.steps, def.settings)).not.toHaveProperty("error");
  });
});

describe("submission pipeline", () => {
  async function makePublishedForm(orgId: string, slug: string) {
    const created = await createForm(orgId, { name: `Pipeline ${slug}`, slug, steps: branchingSteps(), status: "published" });
    expect(created).not.toHaveProperty("error");
    return getPublicFormRow(orgId, slug);
  }

  it("creates a lead with attribution, scoring, consent, and timeline; dedupes repeats", async () => {
    const form = (await makePublishedForm(org.id, "pipeline-a"))!;
    const answers = {
      service_type: "roof",
      leak_now: true,
      first_name: "Dede",
      phone: "(555) 123-9876",
      email: "dede@example.com",
      consent: true,
    };
    const first = await captureFormSubmission({
      organizationId: org.id,
      form,
      answers,
      attribution: { utmSource: "google", utmCampaign: "storm-2026", landingPage: "https://x.test/lp" },
      sourceIp: "1.2.3.4",
    });
    expect(first).not.toHaveProperty("error");
    const r1 = first as Exclude<typeof first, { error: string }>;
    expect(r1.deduped).toBe(false);
    expect(r1.urgency).toBe("high");
    expect(r1.guidance.length).toBeGreaterThan(0);

    const [lead] = await db
      .select()
      .from(leadsTable)
      .where(and(eq(leadsTable.id, r1.leadId), eq(leadsTable.organizationId, org.id)));
    expect(lead.source).toBe("form:pipeline-a");
    expect(lead.scoreReasons).toContain("Active leak");

    // Same phone (different formatting) → merges into the existing open lead.
    const second = await captureFormSubmission({
      organizationId: org.id,
      form,
      answers: { ...answers, phone: "555.123.9876", leak_now: false },
    });
    const r2 = second as Exclude<typeof second, { error: string }>;
    expect(r2.deduped).toBe(true);
    expect(r2.leadId).toBe(r1.leadId);

    // Submissions recorded with attribution + dedupe outcome.
    const subs = await listFormSubmissions(org.id, form.id);
    expect(subs).toHaveLength(2);
    const outcomes = subs.map((s) => s.dedupedIntoExistingLead).sort();
    expect(outcomes).toEqual(["existing_lead", "new_lead"]);
    expect(subs.some((s) => s.attribution.utmSource === "google")).toBe(true);

    // Tenant isolation: the other org sees nothing.
    expect(await listFormSubmissions(otherOrg.id, form.id)).toHaveLength(0);
  });

  it("does NOT dedupe across orgs — same phone in another org makes a fresh lead", async () => {
    const form = (await makePublishedForm(otherOrg.id, "pipeline-b"))!;
    const result = await captureFormSubmission({
      organizationId: otherOrg.id,
      form,
      answers: {
        service_type: "gutters",
        first_name: "Dede",
        phone: "(555) 123-9876", // same phone as the org-A contact
        consent: true,
      },
    });
    const r = result as Exclude<typeof result, { error: string }>;
    expect(r.deduped).toBe(false);
    const [lead] = await db
      .select()
      .from(leadsTable)
      .where(and(eq(leadsTable.id, r.leadId), eq(leadsTable.organizationId, otherOrg.id)));
    expect(lead).toBeDefined();
  });

  it("rejects invalid answers without writing anything", async () => {
    const form = (await makePublishedForm(org.id, "pipeline-c"))!;
    const bad = await captureFormSubmission({
      organizationId: org.id,
      form,
      answers: { service_type: "roof", first_name: "X", phone: "1", consent: true },
    });
    expect(bad).toHaveProperty("error");
    expect(await listFormSubmissions(org.id, form.id)).toHaveLength(0);
  });
});
