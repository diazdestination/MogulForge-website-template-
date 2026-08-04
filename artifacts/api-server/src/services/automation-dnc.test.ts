/**
 * Per-channel do-not-contact enforcement on the NON-playbook send paths:
 * automation send_email/send_sms actions and appointment reminders must
 * block a channel whose DNC flag was flipped by a bounce or opt-out.
 */
import {
  appointmentsTable,
  automationRunsTable,
  consentRecordsTable,
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

// Never hit real providers from tests.
vi.mock("./providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers")>();
  return {
    ...actual,
    providers: {
      ...actual.providers,
      email: { send: vi.fn(async () => ({ id: "mock-email", provider: "mock" })) },
      sms: { send: vi.fn(async () => ({ id: "mock-sms", provider: "mock" })) },
    },
  };
});

import {
  createAutomation,
  processScheduledWork,
  runEvent,
  scheduleAppointmentReminder,
} from "./automation";
import { providers } from "./providers";

let org: { id: string };

async function makeContactLead(input: {
  doNotContactEmail?: boolean;
  doNotContactSms?: boolean;
  smsConsent?: boolean;
}) {
  const [contact] = await db
    .insert(contactsTable)
    .values({
      organizationId: org.id,
      firstName: "Dnc",
      email: `dnc-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
      phone: "+1 (555) 300-0001",
      doNotContactEmail: input.doNotContactEmail ?? false,
      doNotContactSms: input.doNotContactSms ?? false,
    })
    .returning();
  if (input.smsConsent) {
    await db.insert(consentRecordsTable).values({
      organizationId: org.id,
      contactId: contact.id,
      channel: "sms",
      granted: true,
      disclosureVersion: "test-v1",
    });
  }
  const [lead] = await db
    .insert(leadsTable)
    .values({ organizationId: org.id, contactId: contact.id, source: "test" })
    .returning();
  return { contact, lead };
}

beforeAll(async () => {
  const [o] = await db
    .insert(organizationsTable)
    .values({ name: "DNC Automation Test Org", slug: `test-dnc-auto-${Date.now()}` })
    .returning();
  org = o;
});

afterAll(async () => {
  await deleteTestOrgs(org.id);
});

describe("automation send actions honor per-channel DNC", () => {
  it("blocks send_email when the contact is do-not-email", async () => {
    const rule = await createAutomation(org.id, {
      name: "email dnc",
      event: "lead.created",
      actions: [{ type: "send_email", params: { subject: "Hi", body: "Hello" } }],
    });
    const { lead } = await makeContactLead({ doNotContactEmail: true });
    await runEvent(org.id, "lead.created", { leadId: lead.id });

    const runs = await db
      .select()
      .from(automationRunsTable)
      .where(eq(automationRunsTable.automationId, rule.id));
    expect(runs).toHaveLength(1);
    expect(runs[0].actionResults[0].status).not.toBe("success");
    expect(JSON.stringify(runs[0].actionResults[0])).toContain("do_not_contact_email");
    expect(providers.email.send).not.toHaveBeenCalled();
  });

  it("blocks send_sms when the contact is do-not-text even with consent", async () => {
    const rule = await createAutomation(org.id, {
      name: "sms dnc",
      event: "lead.created",
      actions: [{ type: "send_sms", params: { body: "Hello" } }],
    });
    const { lead } = await makeContactLead({ doNotContactSms: true, smsConsent: true });
    await runEvent(org.id, "lead.created", { leadId: lead.id });

    const runs = await db
      .select()
      .from(automationRunsTable)
      .where(eq(automationRunsTable.automationId, rule.id));
    expect(runs).toHaveLength(1);
    expect(runs[0].actionResults[0].status).not.toBe("success");
    expect(JSON.stringify(runs[0].actionResults[0])).toContain("do_not_contact_sms");
    expect(providers.sms.send).not.toHaveBeenCalled();
  });
});

describe("appointment reminders honor per-channel DNC", () => {
  it("sends nothing when both channels are do-not-contact", async () => {
    const { contact, lead } = await makeContactLead({
      doNotContactEmail: true,
      doNotContactSms: true,
      smsConsent: true,
    });
    // 3h out: schedulable (>2h) and its reminder is already due (24h lead).
    const start = new Date(Date.now() + 3 * 3_600_000);
    const [appt] = await db
      .insert(appointmentsTable)
      .values({
        organizationId: org.id,
        leadId: lead.id,
        contactId: contact.id,
        scheduledStart: start,
        scheduledEnd: new Date(start.getTime() + 2 * 3_600_000),
      })
      .returning();
    await scheduleAppointmentReminder(org.id, {
      id: appt.id,
      leadId: lead.id,
      contactId: contact.id,
      scheduledStart: start,
    });
    vi.mocked(providers.email.send).mockClear();
    vi.mocked(providers.sms.send).mockClear();
    await processScheduledWork(org.id);
    expect(providers.email.send).not.toHaveBeenCalled();
    expect(providers.sms.send).not.toHaveBeenCalled();
  });

  it("falls back to email when only SMS is do-not-contact", async () => {
    const { contact, lead } = await makeContactLead({
      doNotContactSms: true,
      smsConsent: true,
    });
    // 3h out: schedulable (>2h) and its reminder is already due (24h lead).
    const start = new Date(Date.now() + 3 * 3_600_000);
    const [appt] = await db
      .insert(appointmentsTable)
      .values({
        organizationId: org.id,
        leadId: lead.id,
        contactId: contact.id,
        scheduledStart: start,
        scheduledEnd: new Date(start.getTime() + 2 * 3_600_000),
      })
      .returning();
    await scheduleAppointmentReminder(org.id, {
      id: appt.id,
      leadId: lead.id,
      contactId: contact.id,
      scheduledStart: start,
    });
    vi.mocked(providers.email.send).mockClear();
    vi.mocked(providers.sms.send).mockClear();
    await processScheduledWork(org.id);
    expect(providers.sms.send).not.toHaveBeenCalled();
    expect(providers.email.send).toHaveBeenCalledTimes(1);
  });
});
