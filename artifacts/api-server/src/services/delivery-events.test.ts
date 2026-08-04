/**
 * Delivery/suppression path: provider webhooks record delivered / bounced /
 * unsubscribed per touch, hard bounces and opt-outs flip the contact's
 * per-channel do-not-contact flag + suppress the address, the send gate
 * refuses that channel afterwards, and the event lands on the lead timeline.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  activitiesTable,
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  playbookEnrollmentsTable,
  playbookTouchesTable,
  playbooksTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import app from "../app";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  handleBounce,
  isPermanentTwilioError,
  recordContactOptOut,
  recordTouchDelivery,
} from "./delivery-events";
import { checkSendEligibility, getSuppression } from "./send-gate";
import { recordTouch } from "./playbook-learning";

let server: Server;
let baseUrl: string;
let org: { id: string };
let playbookId: string;

async function makeContactLead(input: { email?: string; phone?: string }) {
  const [contact] = await db
    .insert(contactsTable)
    .values({
      organizationId: org.id,
      firstName: "Delivery",
      email: input.email ?? null,
      phone: input.phone ?? null,
    })
    .returning();
  const [lead] = await db
    .insert(leadsTable)
    .values({ organizationId: org.id, contactId: contact.id, source: "test" })
    .returning();
  return { contact, lead };
}

async function makeTouch(input: {
  leadId: string;
  channel: "email" | "sms";
  providerMessageId: string;
}) {
  const [enrollment] = await db
    .insert(playbookEnrollmentsTable)
    .values({
      organizationId: org.id,
      playbookId,
      leadId: input.leadId,
      status: "completed",
      currentStep: 1,
    })
    .returning();
  await recordTouch({
    organizationId: org.id,
    playbookId,
    enrollmentId: enrollment.id,
    leadId: input.leadId,
    stepIndex: 0,
    variantKey: "default",
    channel: input.channel,
    provider: input.channel === "email" ? "resend" : "twilio",
    providerMessageId: input.providerMessageId,
  });
  const [touch] = await db
    .select()
    .from(playbookTouchesTable)
    .where(eq(playbookTouchesTable.providerMessageId, input.providerMessageId));
  return touch;
}

async function getTouch(providerMessageId: string) {
  const [touch] = await db
    .select()
    .from(playbookTouchesTable)
    .where(eq(playbookTouchesTable.providerMessageId, providerMessageId));
  return touch;
}

beforeAll(async () => {
  const [o] = await db
    .insert(organizationsTable)
    .values({ name: "Delivery Test Org", slug: `test-delivery-${Date.now()}` })
    .returning();
  org = o;
  const [pb] = await db
    .insert(playbooksTable)
    .values({
      organizationId: org.id,
      name: "Delivery test playbook",
      isActive: true,
      enrollmentRules: {},
      steps: [{ channel: "email", delayMinutes: 1, prompt: "test" }],
    })
    .returning();
  playbookId = pb.id;
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server?.close();
  await deleteTestOrgs(org.id);
});

describe("recordTouchDelivery", () => {
  it("records delivered, and never lets delivered overwrite a bounce", async () => {
    const { lead } = await makeContactLead({ email: "d1@example.com" });
    await makeTouch({ leadId: lead.id, channel: "email", providerMessageId: "re-d1" });

    await recordTouchDelivery({ providerMessageId: "re-d1", signal: "delivered" });
    expect((await getTouch("re-d1")).delivery).toBe("delivered");

    await recordTouchDelivery({ providerMessageId: "re-d1", signal: "bounced" });
    expect((await getTouch("re-d1")).delivery).toBe("bounced");

    // delivered arriving late does not downgrade the bounce
    await recordTouchDelivery({ providerMessageId: "re-d1", signal: "delivered" });
    expect((await getTouch("re-d1")).delivery).toBe("bounced");
  });

  it("puts bounces on the lead timeline", async () => {
    const { lead } = await makeContactLead({ email: "d2@example.com" });
    await makeTouch({ leadId: lead.id, channel: "email", providerMessageId: "re-d2" });
    await recordTouchDelivery({ providerMessageId: "re-d2", signal: "bounced" });
    const rows = await db
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.leadId, lead.id),
          eq(activitiesTable.type, "message_bounced"),
        ),
      );
    expect(rows.length).toBe(1);
    expect(rows[0].title).toMatch(/bounced/i);
  });

  it("is a no-op for unknown message ids", async () => {
    expect(
      await recordTouchDelivery({ providerMessageId: "re-nope", signal: "delivered" }),
    ).toBeNull();
  });
});

describe("hard bounce → per-channel DNC + suppression → gate blocks", () => {
  it("email bounce stops future email but leaves SMS eligible", async () => {
    const { contact, lead } = await makeContactLead({
      email: "bounce@example.com",
      phone: "+1 (555) 200-0001",
    });
    await makeTouch({ leadId: lead.id, channel: "email", providerMessageId: "re-b1" });

    await handleBounce({
      providerMessageId: "re-b1",
      channel: "email",
      address: "bounce@example.com",
      reason: "hard_bounce",
      source: "resend_webhook",
    });

    expect((await getTouch("re-b1")).delivery).toBe("bounced");
    const [updated] = await db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.id, contact.id));
    expect(updated.doNotContactEmail).toBe(true);
    expect(updated.doNotContactSms).toBe(false);
    const suppression = await getSuppression(org.id, "email", "bounce@example.com");
    expect(suppression?.reason).toBe("hard_bounce");

    const gate = await checkSendEligibility({
      organizationId: org.id,
      contact: updated,
      channel: "email",
      kind: "outreach",
    });
    expect(gate).toMatchObject({ ok: false, reason: "do_not_contact_email" });
  });

  it("falls back to address matching when no touch correlates", async () => {
    const { contact } = await makeContactLead({ email: "orphan@example.com" });
    await handleBounce({
      providerMessageId: "re-unknown-id",
      channel: "email",
      address: "Orphan@Example.com",
      reason: "hard_bounce",
      source: "resend_webhook",
    });
    const [updated] = await db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.id, contact.id));
    expect(updated.doNotContactEmail).toBe(true);
    expect(await getSuppression(org.id, "email", "orphan@example.com")).not.toBeNull();
  });
});

describe("per-channel DNC in the send gate", () => {
  it("sms flag blocks sms only", async () => {
    const { contact } = await makeContactLead({
      email: "chan@example.com",
      phone: "+1 (555) 200-0002",
    });
    await db
      .update(contactsTable)
      .set({ doNotContactSms: true })
      .where(eq(contactsTable.id, contact.id));
    const [updated] = await db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.id, contact.id));
    const sms = await checkSendEligibility({
      organizationId: org.id,
      contact: updated,
      channel: "sms",
      kind: "transactional",
    });
    expect(sms).toMatchObject({ ok: false, reason: "do_not_contact_sms" });
    const email = await checkSendEligibility({
      organizationId: org.id,
      contact: updated,
      channel: "email",
      kind: "transactional",
    });
    expect(email).toEqual({ ok: true });
  });
});

describe("recordContactOptOut", () => {
  it("marks outstanding touches unsubscribed and records the timeline entry", async () => {
    const { contact, lead } = await makeContactLead({ email: "opt@example.com" });
    await makeTouch({ leadId: lead.id, channel: "email", providerMessageId: "re-o1" });

    await recordContactOptOut({
      organizationId: org.id,
      contactId: contact.id,
      channel: "email",
      source: "unsubscribe_link",
    });

    expect((await getTouch("re-o1")).delivery).toBe("unsubscribed");
    const [updated] = await db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.id, contact.id));
    expect(updated.doNotContactEmail).toBe(true);
    expect(await getSuppression(org.id, "email", "opt@example.com")).not.toBeNull();
    const rows = await db
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.leadId, lead.id),
          eq(activitiesTable.type, "message_unsubscribed"),
        ),
      );
    expect(rows.length).toBe(1);
  });
});

describe("webhook routes", () => {
  it("Resend bounce webhook records the bounce end to end", async () => {
    const { contact, lead } = await makeContactLead({ email: "hook@example.com" });
    await makeTouch({ leadId: lead.id, channel: "email", providerMessageId: "re-h1" });

    const res = await fetch(`${baseUrl}/api/v1/public/webhooks/resend`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "email.bounced",
        data: { email_id: "re-h1", to: ["hook@example.com"], bounce: { message: "550 no mailbox" } },
      }),
    });
    expect(res.status).toBe(200);
    expect((await getTouch("re-h1")).delivery).toBe("bounced");
    const [updated] = await db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.id, contact.id));
    expect(updated.doNotContactEmail).toBe(true);
  });

  it("Twilio status callback: permanent failure suppresses, transient does not", async () => {
    const { contact, lead } = await makeContactLead({ phone: "+1 (555) 200-0003" });
    await makeTouch({ leadId: lead.id, channel: "sms", providerMessageId: "SM-perm" });
    await makeTouch({ leadId: lead.id, channel: "sms", providerMessageId: "SM-trans" });

    // Permanent: landline (30006)
    let res = await fetch(`${baseUrl}/api/v1/public/sms/status`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        MessageSid: "SM-perm",
        MessageStatus: "undelivered",
        ErrorCode: "30006",
        To: "+15552000003",
      }).toString(),
    });
    expect(res.status).toBe(204);
    expect((await getTouch("SM-perm")).delivery).toBe("bounced");
    let [updated] = await db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.id, contact.id));
    expect(updated.doNotContactSms).toBe(true);
    expect(await getSuppression(org.id, "sms", "+15552000003")).not.toBeNull();

    // Transient failure on another contactless touch: no suppression added
    res = await fetch(`${baseUrl}/api/v1/public/sms/status`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        MessageSid: "SM-trans",
        MessageStatus: "failed",
        ErrorCode: "30003",
        To: "+15552000003",
      }).toString(),
    });
    expect(res.status).toBe(204);
    expect((await getTouch("SM-trans")).delivery).toBe("bounced");
  });

  it("Twilio delivered status records delivered", async () => {
    const { lead } = await makeContactLead({ phone: "+1 (555) 200-0004" });
    await makeTouch({ leadId: lead.id, channel: "sms", providerMessageId: "SM-ok" });
    const res = await fetch(`${baseUrl}/api/v1/public/sms/status`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        MessageSid: "SM-ok",
        MessageStatus: "delivered",
        To: "+15552000004",
      }).toString(),
    });
    expect(res.status).toBe(204);
    expect((await getTouch("SM-ok")).delivery).toBe("delivered");
  });
});

describe("isPermanentTwilioError", () => {
  it("classifies codes", () => {
    expect(isPermanentTwilioError("30006")).toBe(true);
    expect(isPermanentTwilioError("21211")).toBe(true);
    expect(isPermanentTwilioError("30003")).toBe(false);
    expect(isPermanentTwilioError(undefined)).toBe(false);
  });
});
