/**
 * Unified pre-send eligibility gate: DNC flag, address validity, suppression
 * list (address-keyed so it survives re-import), SMS consent, quiet-hours
 * deferral, and frequency caps.
 */
import {
  activitiesTable,
  consentRecordsTable,
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  type SendingHoursSettings,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

import {
  addSuppression,
  buildUnsubscribeToken,
  checkSendEligibility,
  classifyProviderError,
  getSuppression,
  handleProviderFailure,
  hasChannelConsent,
  nextAllowedSendTime,
  normalizePhone,
  parseUnsubscribeToken,
  removeSuppression,
} from "./send-gate";

let org: { id: string };

async function makeContact(input: {
  email?: string | null;
  phone?: string | null;
  doNotContact?: boolean;
}) {
  const [row] = await db
    .insert(contactsTable)
    .values({
      organizationId: org.id,
      firstName: "Gate",
      email: input.email ?? null,
      phone: input.phone ?? null,
      doNotContact: input.doNotContact ?? false,
    })
    .returning();
  return row;
}

beforeAll(async () => {
  const [row] = await db
    .insert(organizationsTable)
    .values({ name: "SendGate Test Org", slug: `test-sendgate-${Date.now()}` })
    .returning();
  org = row;
});

afterAll(async () => {
  await deleteTestOrgs(org.id);
});

describe("normalization + suppression records", () => {
  it("normalizes phone formats to compare equal", () => {
    expect(normalizePhone("+1 (555) 123-4567")).toBe("5551234567");
    expect(normalizePhone("555-123-4567")).toBe("5551234567");
  });

  it("suppression is keyed by normalized address and is idempotent", async () => {
    await addSuppression({
      organizationId: org.id,
      channel: "email",
      value: "  Bounce@Example.COM ",
      reason: "hard_bounce",
      source: "test",
    });
    // Second insert with a different reason is a no-op (first reason wins).
    await addSuppression({
      organizationId: org.id,
      channel: "email",
      value: "bounce@example.com",
      reason: "manual",
    });
    const found = await getSuppression(org.id, "email", "BOUNCE@example.com");
    expect(found?.reason).toBe("hard_bounce");
    expect(await removeSuppression(org.id, "email", "bounce@example.com")).toBe(true);
    expect(await getSuppression(org.id, "email", "bounce@example.com")).toBeNull();
  });
});

describe("checkSendEligibility", () => {
  it("blocks do-not-contact on every channel", async () => {
    const contact = await makeContact({
      email: "dnc@example.com",
      phone: "5550001111",
      doNotContact: true,
    });
    for (const channel of ["email", "sms"] as const) {
      const res = await checkSendEligibility({
        organizationId: org.id,
        contact,
        channel,
        kind: "outreach",
      });
      expect(res).toMatchObject({ ok: false, outcome: "blocked", reason: "do_not_contact" });
    }
  });

  it("blocks missing or invalid addresses", async () => {
    const contact = await makeContact({ email: null, phone: "123" });
    const email = await checkSendEligibility({
      organizationId: org.id,
      contact,
      channel: "email",
      kind: "outreach",
    });
    expect(email).toMatchObject({ ok: false, reason: "no_email" });
    const sms = await checkSendEligibility({
      organizationId: org.id,
      contact,
      channel: "sms",
      kind: "outreach",
    });
    expect(sms).toMatchObject({ ok: false, reason: "invalid_phone" });
  });

  it("blocks a suppressed address even on a NEW contact (survives re-import)", async () => {
    await addSuppression({
      organizationId: org.id,
      channel: "email",
      value: "optout@example.com",
      reason: "unsubscribed",
    });
    const reimported = await makeContact({ email: "OptOut@Example.com" });
    const res = await checkSendEligibility({
      organizationId: org.id,
      contact: reimported,
      channel: "email",
      kind: "outreach",
    });
    expect(res).toMatchObject({
      ok: false,
      outcome: "blocked",
      reason: "suppressed:unsubscribed",
    });
    // ...but only in this org; other tenants are untouched by design
    // (suppressions are org-scoped rows).
  });

  it("requires granted SMS consent, allows email opt-out model", async () => {
    const contact = await makeContact({
      email: "ok@example.com",
      phone: "5552223333",
    });
    const sms = await checkSendEligibility({
      organizationId: org.id,
      contact,
      channel: "sms",
      kind: "outreach",
    });
    expect(sms).toMatchObject({ ok: false, reason: "no_sms_consent" });

    await db.insert(consentRecordsTable).values({
      organizationId: org.id,
      contactId: contact.id,
      channel: "sms",
      granted: true,
      disclosureVersion: "test-v1",
    });
    expect(await hasChannelConsent(org.id, contact.id, "sms")).toBe(true);
    const sms2 = await checkSendEligibility({
      organizationId: org.id,
      contact,
      channel: "sms",
      kind: "outreach",
    });
    expect(sms2.ok).toBe(true);

    const email = await checkSendEligibility({
      organizationId: org.id,
      contact,
      channel: "email",
      kind: "outreach",
    });
    expect(email.ok).toBe(true);
  });

  it("defers (never drops) outside quiet hours; transactional is exempt", async () => {
    const contact = await makeContact({ email: "night@example.com" });
    // A window that is guaranteed closed right now: zero allowed days is
    // sanitized away, so instead pick a 1-hour window on a day-of-week
    // three days from now.
    const now = new Date();
    const dayName = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      timeZone: "UTC",
    }).format(new Date(now.getTime() + 3 * 24 * 3600 * 1000));
    const cfg: SendingHoursSettings = {
      quietHoursEnabled: true,
      timezone: "UTC",
      startHour: 9,
      endHour: 10,
      days: [dayName],
      maxTouchesPerDay: 0,
    };
    const res = await checkSendEligibility({
      organizationId: org.id,
      contact,
      channel: "email",
      kind: "outreach",
      sendingHours: cfg,
    });
    expect(res.ok).toBe(false);
    if (!res.ok && res.outcome === "deferred") {
      expect(res.reason).toBe("quiet_hours");
      expect(res.resumeAt.getTime()).toBeGreaterThan(Date.now());
      // resumeAt lands inside the allowed window
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        weekday: "short",
        hour: "numeric",
        hour12: false,
      }).formatToParts(res.resumeAt);
      expect(parts.find((p) => p.type === "weekday")?.value).toBe(dayName);
      expect(Number(parts.find((p) => p.type === "hour")?.value) % 24).toBe(9);
    } else {
      throw new Error("expected deferred result");
    }

    const transactional = await checkSendEligibility({
      organizationId: org.id,
      contact,
      channel: "email",
      kind: "transactional",
      sendingHours: cfg,
    });
    expect(transactional.ok).toBe(true);
  });

  it("nextAllowedSendTime returns null when inside the window or disabled", () => {
    const open: SendingHoursSettings = {
      quietHoursEnabled: true,
      timezone: "UTC",
      startHour: 0,
      endHour: 24,
      days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      maxTouchesPerDay: 0,
    };
    expect(nextAllowedSendTime(open)).toBeNull();
    expect(nextAllowedSendTime({ ...open, quietHoursEnabled: false, endHour: 1 })).toBeNull();
  });

  it("defers past the frequency cap once the contact hit the daily limit", async () => {
    const contact = await makeContact({ email: "capped@example.com" });
    const [lead] = await db
      .insert(leadsTable)
      .values({ organizationId: org.id, contactId: contact.id, source: "test" })
      .returning();
    await db.insert(activitiesTable).values([
      {
        organizationId: org.id,
        leadId: lead.id,
        contactId: contact.id,
        type: "playbook_touch_sent",
        title: "touch 1",
      },
      {
        organizationId: org.id,
        leadId: lead.id,
        contactId: contact.id,
        type: "automation_message_sent",
        title: "touch 2",
      },
    ]);
    const cfg: SendingHoursSettings = {
      quietHoursEnabled: false,
      timezone: "UTC",
      startHour: 0,
      endHour: 24,
      days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      maxTouchesPerDay: 2,
    };
    const res = await checkSendEligibility({
      organizationId: org.id,
      contact,
      channel: "email",
      kind: "outreach",
      sendingHours: cfg,
    });
    expect(res).toMatchObject({ ok: false, outcome: "deferred", reason: "frequency_cap" });
    if (!res.ok && res.outcome === "deferred") {
      expect(res.resumeAt.getTime()).toBeGreaterThan(Date.now());
    }

    // Under the cap it sends fine.
    const relaxed = await checkSendEligibility({
      organizationId: org.id,
      contact,
      channel: "email",
      kind: "outreach",
      sendingHours: { ...cfg, maxTouchesPerDay: 3 },
    });
    expect(relaxed.ok).toBe(true);
  });
});

describe("provider failure classification", () => {
  it("classifies permanent recipient errors and leaves transient ones alone", () => {
    expect(classifyProviderError(new Error("Twilio error 21211: invalid 'To' phone number")))
      .toBe("invalid");
    expect(classifyProviderError(new Error("Error 21610: message blocked, blacklist rule")))
      .toBe("stop_keyword");
    expect(classifyProviderError(new Error("550 5.1.1 address not found"))).toBe("hard_bounce");
    expect(classifyProviderError(new Error("rate limit exceeded"))).toBeNull();
    expect(classifyProviderError(new Error("ECONNRESET"))).toBeNull();
  });

  it("handleProviderFailure suppresses the address on permanent errors", async () => {
    const suppressed = await handleProviderFailure({
      organizationId: org.id,
      channel: "email",
      address: "dead@example.com",
      err: new Error("550 mailbox unavailable"),
      source: "test",
    });
    expect(suppressed).toBe("hard_bounce");
    expect((await getSuppression(org.id, "email", "dead@example.com"))?.reason).toBe(
      "hard_bounce",
    );
    const transient = await handleProviderFailure({
      organizationId: org.id,
      channel: "email",
      address: "alive@example.com",
      err: new Error("timeout"),
      source: "test",
    });
    expect(transient).toBeNull();
    expect(await getSuppression(org.id, "email", "alive@example.com")).toBeNull();
  });
});

describe("unsubscribe tokens", () => {
  it("round-trips and rejects tampering", () => {
    const token = buildUnsubscribeToken(org.id, "11111111-1111-1111-1111-111111111111");
    expect(parseUnsubscribeToken(token)).toEqual({
      organizationId: org.id,
      contactId: "11111111-1111-1111-1111-111111111111",
    });
    expect(parseUnsubscribeToken(token.slice(0, -2) + "xx")).toBeNull();
    expect(parseUnsubscribeToken("garbage")).toBeNull();
    const [payload] = token.split(".");
    const other = buildUnsubscribeToken(org.id, "22222222-2222-2222-2222-222222222222");
    const [, otherSig] = other.split(".");
    expect(parseUnsubscribeToken(`${payload}.${otherSig}`)).toBeNull();
  });
});
