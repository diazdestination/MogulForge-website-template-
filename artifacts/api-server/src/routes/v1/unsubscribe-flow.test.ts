/**
 * Public opt-out flows: the email unsubscribe landing page + POST records a
 * suppression, revokes consent, and exits live enrollments; the inbound SMS
 * webhook honors STOP (suppress) and START (re-enable STOP suppressions
 * only). Both must never leak whether a contact exists.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  consentRecordsTable,
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  playbookEnrollmentsTable,
  playbooksTable,
  suppressionsTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import app from "../../app";
import {
  buildUnsubscribeToken,
  checkSendEligibility,
  getSuppression,
} from "../../services/send-gate";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

let server: Server;
let baseUrl: string;
let org: { id: string };
let contact: { id: string };
let lead: { id: string };
let enrollmentId: string;

beforeAll(async () => {
  const [o] = await db
    .insert(organizationsTable)
    .values({ name: "Unsub Flow Test", slug: `test-unsub-${Date.now()}` })
    .returning();
  org = o;
  const [c] = await db
    .insert(contactsTable)
    .values({
      organizationId: org.id,
      firstName: "Optout",
      email: "optout-flow@example.com",
      phone: "+1 (555) 867-5309",
    })
    .returning();
  contact = c;
  const [l] = await db
    .insert(leadsTable)
    .values({ organizationId: org.id, contactId: contact.id, source: "test" })
    .returning();
  lead = l;
  const [pb] = await db
    .insert(playbooksTable)
    .values({
      organizationId: org.id,
      name: "Unsub test playbook",
      steps: [{ channel: "email", delayMinutes: 5, prompt: "hi" }],
      isActive: true,
    })
    .returning();
  const [enr] = await db
    .insert(playbookEnrollmentsTable)
    .values({
      organizationId: org.id,
      playbookId: pb.id,
      leadId: lead.id,
      status: "active",
      currentStep: 0,
    })
    .returning();
  enrollmentId = enr.id;

  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server?.close();
  await deleteTestOrgs(org.id);
});

describe("email unsubscribe", () => {
  it("GET renders a confirmation page (no side effects) and rejects bad tokens", async () => {
    const token = buildUnsubscribeToken(org.id, contact.id);
    const res = await fetch(`${baseUrl}/api/v1/public/unsubscribe/${token}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Unsubscribe");
    // Prefetching the link must NOT unsubscribe.
    expect(await getSuppression(org.id, "email", "optout-flow@example.com")).toBeNull();

    const bad = await fetch(`${baseUrl}/api/v1/public/unsubscribe/not-a-token`);
    expect(bad.status).toBe(404);
  });

  it("POST suppresses the address, revokes consent, and stops enrollments", async () => {
    const token = buildUnsubscribeToken(org.id, contact.id);
    const res = await fetch(`${baseUrl}/api/v1/public/unsubscribe/${token}`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("unsubscribed");

    const suppression = await getSuppression(org.id, "email", "optout-flow@example.com");
    expect(suppression?.reason).toBe("unsubscribed");

    const [consent] = await db
      .select()
      .from(consentRecordsTable)
      .where(
        and(
          eq(consentRecordsTable.organizationId, org.id),
          eq(consentRecordsTable.contactId, contact.id),
          eq(consentRecordsTable.channel, "email"),
        ),
      )
      .orderBy(desc(consentRecordsTable.recordedAt))
      .limit(1);
    expect(consent?.granted).toBe(false);

    const [enr] = await db
      .select()
      .from(playbookEnrollmentsTable)
      .where(eq(playbookEnrollmentsTable.id, enrollmentId));
    expect(enr.status).toBe("stopped");

    // Tampered token → 404, nothing leaked.
    const tampered = await fetch(
      `${baseUrl}/api/v1/public/unsubscribe/${token.slice(0, -3)}abc`,
      { method: "POST" },
    );
    expect(tampered.status).toBe(404);
  });
});

describe("inbound SMS STOP/START", () => {
  async function inbound(from: string, body: string) {
    return fetch(`${baseUrl}/api/v1/public/sms/inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ From: from, Body: body }).toString(),
    });
  }

  it("STOP suppresses the number and records revoked consent", async () => {
    const res = await inbound("+15558675309", "STOP");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("xml");

    const suppression = await getSuppression(org.id, "sms", "5558675309");
    expect(suppression?.reason).toBe("stop_keyword");

    const [consent] = await db
      .select()
      .from(consentRecordsTable)
      .where(
        and(
          eq(consentRecordsTable.organizationId, org.id),
          eq(consentRecordsTable.contactId, contact.id),
          eq(consentRecordsTable.channel, "sms"),
        ),
      )
      .orderBy(desc(consentRecordsTable.recordedAt))
      .limit(1);
    expect(consent?.granted).toBe(false);
  });

  it("STOP flips the contact's per-channel do-not-text flag", async () => {
    const [row] = await db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.id, contact.id));
    expect(row.doNotContactSms).toBe(true);
  });

  it("START lifts only a STOP suppression, clears the flag, and re-grants consent", async () => {
    const res = await inbound("555-867-5309", "START");
    expect(res.status).toBe(200);
    expect(await getSuppression(org.id, "sms", "5558675309")).toBeNull();

    // Per-channel DNC flag must be cleared or the send gate keeps blocking.
    const [row] = await db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.id, contact.id));
    expect(row.doNotContactSms).toBe(false);
    const gate = await checkSendEligibility({
      organizationId: org.id,
      contact: row,
      channel: "sms",
      kind: "transactional",
    });
    expect(gate).toEqual({ ok: true });

    const [consent] = await db
      .select()
      .from(consentRecordsTable)
      .where(
        and(
          eq(consentRecordsTable.organizationId, org.id),
          eq(consentRecordsTable.contactId, contact.id),
          eq(consentRecordsTable.channel, "sms"),
        ),
      )
      .orderBy(desc(consentRecordsTable.recordedAt))
      .limit(1);
    expect(consent?.granted).toBe(true);
  });

  it("STOP then START handles multiple contacts sharing a number in one org", async () => {
    const [c1] = await db
      .insert(contactsTable)
      .values({ organizationId: org.id, firstName: "TwinA", phone: "+15559990001" })
      .returning();
    const [c2] = await db
      .insert(contactsTable)
      .values({ organizationId: org.id, firstName: "TwinB", phone: "555-999-0001" })
      .returning();

    await inbound("+15559990001", "STOP");
    let rows = await db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.organizationId, org.id));
    for (const id of [c1.id, c2.id]) {
      expect(rows.find((r) => r.id === id)?.doNotContactSms).toBe(true);
    }

    await inbound("+15559990001", "START");
    rows = await db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.organizationId, org.id));
    for (const id of [c1.id, c2.id]) {
      expect(rows.find((r) => r.id === id)?.doNotContactSms).toBe(false);
    }
    expect(await getSuppression(org.id, "sms", "5559990001")).toBeNull();
  });

  it("START does NOT lift a non-STOP suppression (e.g. hard bounce)", async () => {
    await db.insert(suppressionsTable).values({
      organizationId: org.id,
      channel: "sms",
      value: "5558675309",
      reason: "invalid",
    });
    await inbound("+15558675309", "START");
    const still = await getSuppression(org.id, "sms", "5558675309");
    expect(still?.reason).toBe("invalid");
  });

  it("ignores unrelated messages and unknown numbers", async () => {
    const res = await inbound("+15550000000", "hello there");
    expect(res.status).toBe(200);
  });
});
