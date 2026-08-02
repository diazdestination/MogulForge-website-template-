import {
  automationRunsTable,
  automationsTable,
  consentRecordsTable,
  db,
  messageTemplatesTable,
  organizationsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

import {
  createAutomation,
  DEFAULT_ABANDONED_EMAIL_TEMPLATE_NAME,
  DEFAULT_ABANDONED_FOLLOWUP_NAME,
  DEFAULT_ABANDONED_FOLLOWUP_SEED_KEY,
  DEFAULT_ABANDONED_SMS_TEMPLATE_NAME,
  deleteAutomation,
  ensureDefaultAutomations,
  runEvent,
  updateAutomation,
  updateTemplate,
} from "./automation";
import * as crm from "./crm";
import { providers } from "./providers";

let org: { id: string };
/** Extra orgs created inside individual tests, cleaned up in afterAll. */
const extraOrgIds: string[] = [];

beforeAll(async () => {
  const slug = `test-auto-${Date.now()}`;
  const [row] = await db
    .insert(organizationsTable)
    .values({ name: "Automation Test Org", slug })
    .returning();
  org = row;
});

afterAll(async () => {
  await deleteTestOrgs(org.id, ...extraOrgIds);
});

async function makeLead(smsGranted: boolean) {
  const contact = await crm.createContact(org.id, {
    firstName: "Auto",
    lastName: "Test",
    phone: "+15550001111",
    email: "auto@test.example",
  });
  await db.insert(consentRecordsTable).values({
    organizationId: org.id,
    contactId: contact.id,
    channel: "sms",
    granted: smsGranted,
    disclosureVersion: "v1",
  });
  const lead = await crm.createLead(org.id, { contactId: contact.id });
  return { contact, lead: lead! };
}

describe("automation engine", () => {
  it("records a run and sends SMS when consent is granted", async () => {
    const rule = await createAutomation(org.id, {
      name: "sms on lead",
      event: "lead.created",
      actions: [
        { type: "send_sms", params: { body: "Hi {{contact.firstName}}" } },
      ],
    });
    const { lead } = await makeLead(true);
    await runEvent(org.id, "lead.created", { leadId: lead.id });

    const runs = await db
      .select()
      .from(automationRunsTable)
      .where(eq(automationRunsTable.automationId, rule.id));
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("success");
    expect(runs[0].actionResults[0].status).toBe("success");
  });

  it("blocks SMS without consent (skipped, never sent)", async () => {
    const rule = await createAutomation(org.id, {
      name: "sms no consent",
      event: "lead.created",
      actions: [{ type: "send_sms", params: { body: "Hello" } }],
      conditions: {},
    });
    const { lead } = await makeLead(false);
    await runEvent(org.id, "lead.created", { leadId: lead.id });

    const runs = await db
      .select()
      .from(automationRunsTable)
      .where(eq(automationRunsTable.automationId, rule.id));
    const blocked = runs.find((r) => r.entityId === lead.id);
    expect(blocked).toBeDefined();
    expect(blocked!.actionResults[0].status).toBe("skipped");
    expect(blocked!.actionResults[0].detail).toContain("consent");
  });

  it("skips rules whose conditions do not match", async () => {
    const rule = await createAutomation(org.id, {
      name: "emergency only",
      event: "lead.created",
      conditions: { "lead.urgency": "emergency" },
      actions: [{ type: "create_task", params: { title: "Urgent!" } }],
    });
    const { lead } = await makeLead(true);
    await runEvent(org.id, "lead.created", {
      leadId: lead.id,
      fields: { "lead.urgency": "normal" },
    });
    const runs = await db
      .select()
      .from(automationRunsTable)
      .where(eq(automationRunsTable.automationId, rule.id));
    expect(runs).toHaveLength(0);
  });

  it("does not run rules from another org", async () => {
    const [otherOrg] = await db
      .insert(organizationsTable)
      .values({ name: "Other Org", slug: `test-auto-other-${Date.now()}` })
      .returning();
    extraOrgIds.push(otherOrg.id);
    const rule = await createAutomation(otherOrg.id, {
      name: "foreign rule",
      event: "lead.created",
      actions: [{ type: "create_task", params: { title: "Should not run" } }],
    });
    const { lead } = await makeLead(true);
    await runEvent(org.id, "lead.created", { leadId: lead.id });
    const runs = await db
      .select()
      .from(automationRunsTable)
      .where(eq(automationRunsTable.automationId, rule.id));
    expect(runs).toHaveLength(0);
  });
});

describe("default automation seeding", () => {
  it("seeds an active assessment.abandoned rule once and stays idempotent", async () => {
    await ensureDefaultAutomations(org.id);
    await ensureDefaultAutomations(org.id);
    const rules = await db
      .select()
      .from(automationsTable)
      .where(eq(automationsTable.organizationId, org.id));
    const seeded = rules.filter(
      (r) => r.seedKey === DEFAULT_ABANDONED_FOLLOWUP_SEED_KEY,
    );
    expect(seeded).toHaveLength(1);
    expect(seeded[0].event).toBe("assessment.abandoned");
    expect(seeded[0].isActive).toBe(true);
    expect(seeded[0].actions.map((a) => a.type)).toEqual([
      "send_sms",
      "send_email",
      "create_task",
    ]);
  });

  it("seeds editable message templates and wires the rule's actions to them", async () => {
    await ensureDefaultAutomations(org.id);
    const [seeded] = await db
      .select()
      .from(automationsTable)
      .where(
        and(
          eq(automationsTable.organizationId, org.id),
          eq(automationsTable.seedKey, DEFAULT_ABANDONED_FOLLOWUP_SEED_KEY),
        ),
      );
    const templates = await db
      .select()
      .from(messageTemplatesTable)
      .where(eq(messageTemplatesTable.organizationId, org.id));
    const smsTemplate = templates.find(
      (t) => t.name === DEFAULT_ABANDONED_SMS_TEMPLATE_NAME,
    );
    const emailTemplate = templates.find(
      (t) => t.name === DEFAULT_ABANDONED_EMAIL_TEMPLATE_NAME,
    );
    expect(smsTemplate).toBeDefined();
    expect(emailTemplate).toBeDefined();

    const sms = seeded.actions.find((a) => a.type === "send_sms");
    const email = seeded.actions.find((a) => a.type === "send_email");
    expect((sms?.params as { templateId?: string }).templateId).toBe(
      smsTemplate!.id,
    );
    expect((email?.params as { templateId?: string }).templateId).toBe(
      emailTemplate!.id,
    );
  });

  it("sends the edited template copy after an admin updates it", async () => {
    const [freshOrg] = await db
      .insert(organizationsTable)
      .values({
        name: "Template Edit Org",
        slug: `test-tmpl-edit-${Date.now()}`,
      })
      .returning();
    extraOrgIds.push(freshOrg.id);
    await ensureDefaultAutomations(freshOrg.id);
    const [smsTemplate] = await db
      .select()
      .from(messageTemplatesTable)
      .where(
        and(
          eq(messageTemplatesTable.organizationId, freshOrg.id),
          eq(messageTemplatesTable.name, DEFAULT_ABANDONED_SMS_TEMPLATE_NAME),
        ),
      );
    await updateTemplate(freshOrg.id, smsTemplate.id, {
      body: "Custom copy for {{contact.firstName}} from {{business.name}}",
    });

    const contact = await crm.createContact(freshOrg.id, {
      firstName: "Tmpl",
      lastName: "Edit",
      phone: "+15550002222",
      email: "tmpl@test.example",
    });
    await db.insert(consentRecordsTable).values({
      organizationId: freshOrg.id,
      contactId: contact.id,
      channel: "sms",
      granted: true,
      disclosureVersion: "v1",
    });
    const lead = await crm.createLead(freshOrg.id, { contactId: contact.id });
    const smsSpy = vi.spyOn(providers.sms, "send");
    try {
      await runEvent(freshOrg.id, "assessment.abandoned", { leadId: lead!.id });

      const runs = await db
        .select()
        .from(automationRunsTable)
        .where(eq(automationRunsTable.organizationId, freshOrg.id));
      expect(runs).toHaveLength(1);
      const sms = runs[0].actionResults.find((r) => r.type === "send_sms");
      expect(sms?.status).toBe("success");
      const sentBody = smsSpy.mock.calls.at(-1)?.[1];
      expect(sentBody).toContain("Custom copy for Tmpl");
    } finally {
      smsSpy.mockRestore();
    }
  });

  it("upgrades a legacy seeded rule with unedited hardcoded copy to templates", async () => {
    const [legacyOrg] = await db
      .insert(organizationsTable)
      .values({ name: "Legacy Seed Org", slug: `test-legacy-${Date.now()}` })
      .returning();
    extraOrgIds.push(legacyOrg.id);
    // Simulate a pre-templates seed: hardcoded bodies, no templateId.
    await db.insert(automationsTable).values({
      organizationId: legacyOrg.id,
      name: DEFAULT_ABANDONED_FOLLOWUP_NAME,
      seedKey: DEFAULT_ABANDONED_FOLLOWUP_SEED_KEY,
      event: "assessment.abandoned",
      conditions: {},
      isActive: true,
      actions: [
        {
          type: "send_sms",
          params: {
            body: "Hi {{contact.firstName}}, this is {{business.name}} — looks like we got disconnected. Still want help with your roof? Pick up right where you left off, or call us at {{business.phone}} to schedule your free inspection.",
          },
        },
        {
          type: "send_email",
          params: {
            subject: "Still there? Let's finish your roof assessment",
            body: "Hi {{contact.firstName}},\n\nIt looks like we got disconnected while going over your roof concern. We'd hate for a small issue to turn into a big one — you can pick up your assessment right where you left off, or call {{business.phone}} and we'll get your free inspection on the calendar.\n\n— {{business.name}}",
          },
        },
        {
          type: "create_task",
          params: { title: "Call back: homeowner abandoned concierge chat" },
        },
      ],
    });

    await ensureDefaultAutomations(legacyOrg.id);

    const [rule] = await db
      .select()
      .from(automationsTable)
      .where(eq(automationsTable.organizationId, legacyOrg.id));
    const sms = rule.actions.find((a) => a.type === "send_sms");
    const email = rule.actions.find((a) => a.type === "send_email");
    expect((sms?.params as { templateId?: string }).templateId).toBeTruthy();
    expect((email?.params as { templateId?: string }).templateId).toBeTruthy();
  });

  it("leaves a customized legacy rule's copy untouched", async () => {
    const [customOrg] = await db
      .insert(organizationsTable)
      .values({ name: "Custom Copy Org", slug: `test-custom-${Date.now()}` })
      .returning();
    extraOrgIds.push(customOrg.id);
    await db.insert(automationsTable).values({
      organizationId: customOrg.id,
      name: DEFAULT_ABANDONED_FOLLOWUP_NAME,
      seedKey: DEFAULT_ABANDONED_FOLLOWUP_SEED_KEY,
      event: "assessment.abandoned",
      conditions: {},
      isActive: true,
      actions: [
        { type: "send_sms", params: { body: "My custom SMS copy" } },
        {
          type: "send_email",
          params: { subject: "Custom subject", body: "Custom email copy" },
        },
      ],
    });

    await ensureDefaultAutomations(customOrg.id);

    const [rule] = await db
      .select()
      .from(automationsTable)
      .where(eq(automationsTable.organizationId, customOrg.id));
    const sms = rule.actions.find((a) => a.type === "send_sms");
    expect((sms?.params as { templateId?: string }).templateId).toBeUndefined();
    expect((sms?.params as { body?: string }).body).toBe("My custom SMS copy");
    const templates = await db
      .select()
      .from(messageTemplatesTable)
      .where(eq(messageTemplatesTable.organizationId, customOrg.id));
    expect(templates).toHaveLength(0);
  });

  it("does not re-seed a rule an admin deleted (deactivated)", async () => {
    await ensureDefaultAutomations(org.id);
    const [seeded] = await db
      .select()
      .from(automationsTable)
      .where(
        and(
          eq(automationsTable.organizationId, org.id),
          eq(automationsTable.seedKey, DEFAULT_ABANDONED_FOLLOWUP_SEED_KEY),
        ),
      );
    await deleteAutomation(org.id, seeded.id);
    await ensureDefaultAutomations(org.id);
    const rules = await db
      .select()
      .from(automationsTable)
      .where(
        and(
          eq(automationsTable.organizationId, org.id),
          eq(automationsTable.seedKey, DEFAULT_ABANDONED_FOLLOWUP_SEED_KEY),
        ),
      );
    expect(rules).toHaveLength(1);
    expect(rules[0].isActive).toBe(false);
  });

  it("stays idempotent under concurrent seeding", async () => {
    const [freshOrg] = await db
      .insert(organizationsTable)
      .values({ name: "Concurrent Seed Org", slug: `test-seed-${Date.now()}` })
      .returning();
    extraOrgIds.push(freshOrg.id);
    await Promise.all(
      Array.from({ length: 8 }, () => ensureDefaultAutomations(freshOrg.id)),
    );
    const rules = await db
      .select()
      .from(automationsTable)
      .where(
        and(
          eq(automationsTable.organizationId, freshOrg.id),
          eq(automationsTable.seedKey, DEFAULT_ABANDONED_FOLLOWUP_SEED_KEY),
        ),
      );
    expect(rules).toHaveLength(1);
  });

  it("does not re-seed after an admin renames the seeded rule", async () => {
    const [renameOrg] = await db
      .insert(organizationsTable)
      .values({ name: "Rename Seed Org", slug: `test-seed-rn-${Date.now()}` })
      .returning();
    extraOrgIds.push(renameOrg.id);
    await ensureDefaultAutomations(renameOrg.id);
    const [seeded] = await db
      .select()
      .from(automationsTable)
      .where(eq(automationsTable.organizationId, renameOrg.id));
    await updateAutomation(renameOrg.id, seeded.id, { name: "My custom name" });
    await ensureDefaultAutomations(renameOrg.id);
    const rules = await db
      .select()
      .from(automationsTable)
      .where(eq(automationsTable.organizationId, renameOrg.id));
    expect(rules).toHaveLength(1);
    expect(rules[0].name).toBe("My custom name");
    expect(rules[0].seedKey).toBe(DEFAULT_ABANDONED_FOLLOWUP_SEED_KEY);
  });
});
