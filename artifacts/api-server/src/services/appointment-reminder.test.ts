import {
  activitiesTable,
  appointmentsTable,
  consentRecordsTable,
  contactsTable,
  conversationsTable,
  db,
  DEFAULT_INSPECTION_AVAILABILITY,
  leadsTable,
  organizationsTable,
  orgSettingsTable,
  scheduledActionsTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

// Prevent real email/SMS sends in tests — the Gmail connector is configured
// in this workspace and hitting it in parallel workers triggers 429 errors.
vi.mock("./providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers")>();
  return {
    ...actual,
    providers: {
      ...actual.providers,
      email: {
        ...actual.providers.email,
        send: vi.fn(async () => ({ id: "mock-email", provider: "mock" })),
      },
      sms: {
        ...actual.providers.sms,
        send: vi.fn(async () => ({ id: "mock-sms", provider: "mock" })),
      },
    },
  };
});

import {
  APPOINTMENT_REMINDER_EVENT,
  cancelAppointmentReminders,
  processScheduledWork,
  scheduleAppointmentReminder,
} from "./automation";
import { handleMessage, startConversation } from "./concierge";
import { providers } from "./providers";
import { createAppointment as createAppointmentRaw, updateAppointment } from "./crm";

/** Unwrap createAppointment's conflict union — these tests never expect a full window. */
async function createAppointment(...args: Parameters<typeof createAppointmentRaw>) {
  const row = await createAppointmentRaw(...args);
  if (row === "conflict") throw new Error("unexpected inspection window conflict in test");
  if (row === "past_start") throw new Error("unexpected past-start rejection in test");
  return row;
}

let org: { id: string };
let contact: { id: string };
let lead: { id: string };
/** Extra orgs created inside individual tests, cleaned up in afterAll. */
const extraOrgIds: string[] = [];

const HOUR = 3_600_000;

beforeAll(async () => {
  const [o] = await db
    .insert(organizationsTable)
    .values({ name: "Reminder Test Org", slug: `test-reminder-${Date.now()}` })
    .returning();
  org = o;
  const [c] = await db
    .insert(contactsTable)
    .values({
      organizationId: org.id,
      firstName: "Rita",
      email: "rita@example.com",
      phone: "+15550000001",
    })
    .returning();
  contact = c;
  const [l] = await db
    .insert(leadsTable)
    .values({ organizationId: org.id, contactId: contact.id })
    .returning();
  lead = l;
});

afterAll(async () => {
  await deleteTestOrgs(org.id, ...extraOrgIds);
});

function pendingRemindersFor(appointmentId: string) {
  return db
    .select()
    .from(scheduledActionsTable)
    .where(
      and(
        eq(scheduledActionsTable.organizationId, org.id),
        eq(scheduledActionsTable.status, "pending"),
        sql`${scheduledActionsTable.context} ->> 'appointmentId' = ${appointmentId}`,
        sql`${scheduledActionsTable.context} ->> 'event' = ${APPOINTMENT_REMINDER_EVENT}`,
      ),
    );
}

describe("appointment reminders", () => {
  it("queues a reminder ~24h before start when a CRM appointment is created", async () => {
    const start = new Date(Date.now() + 72 * HOUR);
    const appt = await createAppointment(org.id, {
      leadId: lead.id,
      contactId: contact.id,
      scheduledStart: start,
      scheduledEnd: new Date(start.getTime() + 2 * HOUR),
    });
    expect(appt).not.toBeNull();
    const rows = await pendingRemindersFor(appt!.id);
    expect(rows).toHaveLength(1);
    expect(Math.abs(rows[0].runAt.getTime() - (start.getTime() - 24 * HOUR))).toBeLessThan(60_000);
  });

  it("skips the reminder when the booking starts within 2 hours", async () => {
    const scheduled = await scheduleAppointmentReminder(org.id, {
      id: crypto.randomUUID(),
      scheduledStart: new Date(Date.now() + HOUR),
    });
    expect(scheduled).toBe(false);
  });

  it("sends a due reminder and logs an activity on the lead", async () => {
    const start = new Date(Date.now() + 30 * HOUR);
    const appt = await createAppointment(org.id, {
      leadId: lead.id,
      contactId: contact.id,
      scheduledStart: start,
    });
    const [row] = await pendingRemindersFor(appt!.id);
    await db
      .update(scheduledActionsTable)
      .set({ runAt: new Date(Date.now() - 1000) })
      .where(eq(scheduledActionsTable.id, row.id));
    await processScheduledWork(org.id);
    const [after] = await db
      .select()
      .from(scheduledActionsTable)
      .where(eq(scheduledActionsTable.id, row.id));
    expect(after.status).toBe("done");
    const activities = await db
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.leadId, lead.id),
          eq(activitiesTable.type, "appointment_reminder_sent"),
        ),
      );
    expect(activities.length).toBeGreaterThan(0);
  });

  it("cancels the pending reminder when the appointment is cancelled", async () => {
    const start = new Date(Date.now() + 72 * HOUR);
    const appt = await createAppointment(org.id, {
      leadId: lead.id,
      contactId: contact.id,
      scheduledStart: start,
    });
    await updateAppointment(org.id, appt!.id, { status: "cancelled" });
    expect(await pendingRemindersFor(appt!.id)).toHaveLength(0);
  });

  it("re-queues the reminder against the new start on reschedule", async () => {
    const start = new Date(Date.now() + 72 * HOUR);
    const appt = await createAppointment(org.id, {
      leadId: lead.id,
      contactId: contact.id,
      scheduledStart: start,
    });
    const newStart = new Date(Date.now() + 96 * HOUR);
    await updateAppointment(org.id, appt!.id, { scheduledStart: newStart });
    const rows = await pendingRemindersFor(appt!.id);
    expect(rows).toHaveLength(1);
    expect(Math.abs(rows[0].runAt.getTime() - (newStart.getTime() - 24 * HOUR))).toBeLessThan(60_000);
    const fields = (rows[0].context as { fields?: Record<string, unknown> }).fields;
    expect(fields?.["appointment.scheduledStart"]).toBe(newStart.toISOString());
  });

  it("does not send a stale reminder even if the scheduled row survives a reschedule", async () => {
    const start = new Date(Date.now() + 72 * HOUR);
    const appt = await createAppointment(org.id, {
      leadId: lead.id,
      contactId: contact.id,
      scheduledStart: start,
    });
    const [row] = await pendingRemindersFor(appt!.id);
    // Simulate a path that changed the start without cancelling the reminder.
    await db
      .update(appointmentsTable)
      .set({ scheduledStart: new Date(start.getTime() + 24 * HOUR) })
      .where(eq(appointmentsTable.id, appt!.id));
    await db
      .update(scheduledActionsTable)
      .set({ runAt: new Date(Date.now() - 1000) })
      .where(eq(scheduledActionsTable.id, row.id));
    const before = await db
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.leadId, lead.id),
          eq(activitiesTable.type, "appointment_reminder_sent"),
        ),
      );
    await processScheduledWork(org.id);
    const after = await db
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.leadId, lead.id),
          eq(activitiesTable.type, "appointment_reminder_sent"),
        ),
      );
    expect(after.length).toBe(before.length);
  });

  async function makeContactLead(input: {
    preferredContactMethod?: string | null;
    email?: string | null;
    phone?: string | null;
    smsConsent?: boolean;
  }) {
    const [c] = await db
      .insert(contactsTable)
      .values({
        organizationId: org.id,
        firstName: "Pref",
        email: input.email ?? null,
        phone: input.phone ?? null,
        preferredContactMethod: input.preferredContactMethod ?? null,
      })
      .returning();
    if (input.smsConsent !== undefined) {
      await db.insert(consentRecordsTable).values({
        organizationId: org.id,
        contactId: c.id,
        channel: "sms",
        granted: input.smsConsent,
        disclosureVersion: "test",
      });
    }
    const [l] = await db
      .insert(leadsTable)
      .values({ organizationId: org.id, contactId: c.id })
      .returning();
    return { contact: c, lead: l };
  }

  async function runReminderNow(appointmentId: string) {
    const [row] = await pendingRemindersFor(appointmentId);
    await db
      .update(scheduledActionsTable)
      .set({ runAt: new Date(Date.now() - 1000) })
      .where(eq(scheduledActionsTable.id, row.id));
    await processScheduledWork(org.id);
  }

  async function sentChannelFor(leadId: string) {
    const rows = await db
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.leadId, leadId),
          eq(activitiesTable.type, "appointment_reminder_sent"),
        ),
      );
    return rows.map((r) => (r.metadata as { channel?: string }).channel);
  }

  it("CRM-created appointments honor the contact's stored email preference over SMS", async () => {
    const { contact: c, lead: l } = await makeContactLead({
      preferredContactMethod: "email",
      email: "pref-email@example.com",
      phone: "+15550000002",
      smsConsent: true,
    });
    const appt = await createAppointment(org.id, {
      leadId: l.id,
      contactId: c.id,
      scheduledStart: new Date(Date.now() + 30 * HOUR),
    });
    await runReminderNow(appt!.id);
    expect(await sentChannelFor(l.id)).toEqual(["email"]);
  });

  it("CRM-created appointments use SMS when the contact prefers text and consented", async () => {
    const { contact: c, lead: l } = await makeContactLead({
      preferredContactMethod: "text",
      email: "pref-text@example.com",
      phone: "+15550000003",
      smsConsent: true,
    });
    const appt = await createAppointment(org.id, {
      leadId: l.id,
      contactId: c.id,
      scheduledStart: new Date(Date.now() + 30 * HOUR),
    });
    await runReminderNow(appt!.id);
    expect(await sentChannelFor(l.id)).toEqual(["sms"]);
  });

  it("falls back to email when text is preferred but SMS consent is missing", async () => {
    const { contact: c, lead: l } = await makeContactLead({
      preferredContactMethod: "text",
      email: "no-consent@example.com",
      phone: "+15550000004",
      smsConsent: false,
    });
    const appt = await createAppointment(org.id, {
      leadId: l.id,
      contactId: c.id,
      scheduledStart: new Date(Date.now() + 30 * HOUR),
    });
    await runReminderNow(appt!.id);
    expect(await sentChannelFor(l.id)).toEqual(["email"]);
  });

  it("skips (without failing) when no channel is reachable", async () => {
    const { contact: c, lead: l } = await makeContactLead({
      phone: "+15550000005",
      smsConsent: false, // no email, no SMS consent
    });
    const appt = await createAppointment(org.id, {
      leadId: l.id,
      contactId: c.id,
      scheduledStart: new Date(Date.now() + 30 * HOUR),
    });
    const [row] = await pendingRemindersFor(appt!.id);
    await runReminderNow(appt!.id);
    const [after] = await db
      .select()
      .from(scheduledActionsTable)
      .where(eq(scheduledActionsTable.id, row.id));
    expect(after.status).toBe("done");
    expect(await sentChannelFor(l.id)).toEqual([]);
  });

  it("concierge email preference survives a CRM reschedule (reminder still emails)", async () => {
    // Drive a full concierge chat: prefers email, consents (grants SMS
    // consent too), books a slot. The preference is persisted on the
    // contact, so the re-queued reminder after a CRM reschedule still emails.
    const availability = {
      ...DEFAULT_INSPECTION_AVAILABILITY,
      timezone: "UTC",
      days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      windows: Array.from({ length: 12 }, (_, i) => ({
        startHour: i * 2,
        endHour: i * 2 + 2,
      })),
      blackoutDates: [],
    };
    await db
      .insert(orgSettingsTable)
      .values({ organizationId: org.id, inspectionAvailability: availability })
      .onConflictDoUpdate({
        target: orgSettingsTable.organizationId,
        set: { inspectionAvailability: availability },
      });
    const started = await startConversation({ organizationId: org.id });
    const id = started.conversationId;
    const say = (content: string) =>
      handleMessage({ organizationId: org.id, conversationId: id, content });
    await say("Request a quote");
    await say("A few shingles blew off last week.");
    await say("Emmy Prefers");
    await say("+15550000006");
    await say("emmy@example.com");
    await say("123 Main St");
    await say("Springfield, TX 75001");
    await say("Residential");
    await say("Email");
    const consent = await say("Yes, you have my consent");
    const booked = await say("1");
    expect(booked?.done).toBe(true);
    void consent;

    const [conversation] = await db
      .select()
      .from(conversationsTable)
      .where(eq(conversationsTable.id, id));
    const contactId = conversation.contactId!;
    const [persisted] = await db
      .select({ pref: contactsTable.preferredContactMethod })
      .from(contactsTable)
      .where(eq(contactsTable.id, contactId));
    expect(persisted.pref).toBe("email");

    const [appt] = await db
      .select()
      .from(appointmentsTable)
      .where(
        and(
          eq(appointmentsTable.organizationId, org.id),
          eq(appointmentsTable.contactId, contactId),
        ),
      );
    // Reschedule from the CRM: reminder re-queued without booking-time params.
    const newStart = new Date(Date.now() + 96 * HOUR);
    await updateAppointment(org.id, appt.id, { scheduledStart: newStart });
    await runReminderNow(appt.id);
    expect(await sentChannelFor(conversation.leadId!)).toEqual(["email"]);
  });

  it("uses the org's configured lead time when queuing", async () => {
    const [o] = await db
      .insert(organizationsTable)
      .values({ name: "Lead Time Org", slug: `test-leadtime-${Date.now()}` })
      .returning();
    extraOrgIds.push(o.id);
    await db.insert(orgSettingsTable).values({
      organizationId: o.id,
      appointmentReminder: { leadTimeHours: 48 },
    });
    const start = new Date(Date.now() + 96 * HOUR);
    const id = crypto.randomUUID();
    expect(
      await scheduleAppointmentReminder(o.id, { id, scheduledStart: start }),
    ).toBe(true);
    const [row] = await db
      .select()
      .from(scheduledActionsTable)
      .where(
        and(
          eq(scheduledActionsTable.organizationId, o.id),
          sql`${scheduledActionsTable.context} ->> 'appointmentId' = ${id}`,
        ),
      );
    expect(Math.abs(row.runAt.getTime() - (start.getTime() - 48 * HOUR))).toBeLessThan(60_000);
  });

  it("sends the org's customized copy with placeholders rendered", async () => {
    const [o] = await db
      .insert(organizationsTable)
      .values({ name: "Copy Org", slug: `test-copy-${Date.now()}` })
      .returning();
    extraOrgIds.push(o.id);
    await db.insert(orgSettingsTable).values({
      organizationId: o.id,
      businessProfile: { businessName: "Copy Roofing" },
      appointmentReminder: {
        emailSubject: "See you soon, {{contact.firstName}}!",
        emailBody: "{{business.name}} inspection at {{appointment.window}}.",
      },
    });
    const [c] = await db
      .insert(contactsTable)
      .values({
        organizationId: o.id,
        firstName: "Cora",
        email: "cora@example.com",
      })
      .returning();
    const [l] = await db
      .insert(leadsTable)
      .values({ organizationId: o.id, contactId: c.id })
      .returning();
    const [appt] = await db
      .insert(appointmentsTable)
      .values({
        organizationId: o.id,
        leadId: l.id,
        contactId: c.id,
        scheduledStart: new Date(Date.now() + 30 * HOUR),
      })
      .returning();
    const emailSpy = vi.spyOn(providers.email, "send");
    try {
      await scheduleAppointmentReminder(o.id, appt);
      const [row] = await db
        .select()
        .from(scheduledActionsTable)
        .where(
          and(
            eq(scheduledActionsTable.organizationId, o.id),
            sql`${scheduledActionsTable.context} ->> 'appointmentId' = ${appt.id}`,
          ),
        );
      await db
        .update(scheduledActionsTable)
        .set({ runAt: new Date(Date.now() - 1000) })
        .where(eq(scheduledActionsTable.id, row.id));
      await processScheduledWork(o.id);
      const call = emailSpy.mock.calls.find(([to]) => to === "cora@example.com");
      expect(call).toBeDefined();
      expect(call![1]).toBe("See you soon, Cora!");
      expect(call![2]).toMatch(/^Copy Roofing inspection at .+\.$/);
    } finally {
      emailSpy.mockRestore();
    }
  });

  it("cancelAppointmentReminders is idempotent and scoped", async () => {
    const start = new Date(Date.now() + 72 * HOUR);
    const appt = await createAppointment(org.id, {
      leadId: lead.id,
      contactId: contact.id,
      scheduledStart: start,
    });
    expect(await cancelAppointmentReminders(org.id, appt!.id)).toBe(1);
    expect(await cancelAppointmentReminders(org.id, appt!.id)).toBe(0);
  });
});
