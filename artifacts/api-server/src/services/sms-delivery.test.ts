/**
 * SMS delivery round-trip tests.
 *
 * Verifies the full path: automation trigger → send_sms action →
 * SmsProvider.send() → Twilio HTTP API, using a stubbed fetch so the suite
 * runs without real Twilio credentials. Also covers provider selection
 * (twilio vs mock) which is decided at module load from env.
 */
import {
  automationRunsTable,
  consentRecordsTable,
  db,
  organizationsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

import { createAutomation, runEvent } from "./automation";
import * as crm from "./crm";
import { mockSmsProvider, providers, twilioSmsProvider } from "./providers";

const TWILIO_ENV = {
  TWILIO_ACCOUNT_SID: "ACtest123",
  TWILIO_AUTH_TOKEN: "authtokentest",
  TWILIO_PHONE_NUMBER: "+15559990000",
};

function stubTwilioEnv() {
  for (const [k, v] of Object.entries(TWILIO_ENV)) vi.stubEnv(k, v);
}

/** Stub global fetch to act as the Twilio Messages endpoint. */
function stubTwilioFetch(
  response: { ok: boolean; status?: number; json?: unknown; text?: string } = {
    ok: true,
    json: { sid: "SMstubbed123" },
  },
) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return {
        ok: response.ok,
        status: response.status ?? (response.ok ? 201 : 400),
        json: async () => response.json ?? {},
        text: async () => response.text ?? "",
      } as Response;
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("twilioSmsProvider", () => {
  it("POSTs the correct to/from/body to the Twilio API and returns the SID", async () => {
    stubTwilioEnv();
    const calls = stubTwilioFetch({ ok: true, json: { sid: "SMabc123" } });

    const res = await twilioSmsProvider.send("+15551234567", "Hello homeowner");

    expect(res).toEqual({ id: "SMabc123", provider: "twilio" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/ACtest123/Messages.json",
    );
    const init = calls[0].init;
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from("ACtest123:authtokentest").toString("base64")}`,
    );
    const params = new URLSearchParams(String(init.body));
    expect(params.get("To")).toBe("+15551234567");
    expect(params.get("From")).toBe("+15559990000");
    expect(params.get("Body")).toBe("Hello homeowner");
  });

  it("throws when Twilio env is missing (never silently pretends to send)", async () => {
    const calls = stubTwilioFetch();
    await expect(twilioSmsProvider.send("+15551234567", "x")).rejects.toThrow(
      /not configured/i,
    );
    expect(calls).toHaveLength(0);
  });

  it("throws on a non-OK Twilio response", async () => {
    stubTwilioEnv();
    stubTwilioFetch({ ok: false, status: 401, text: "auth error" });
    await expect(twilioSmsProvider.send("+15551234567", "x")).rejects.toThrow(
      /Twilio send failed: 401/,
    );
  });

  it("throws when Twilio returns no message SID", async () => {
    stubTwilioEnv();
    stubTwilioFetch({ ok: true, json: {} });
    await expect(twilioSmsProvider.send("+15551234567", "x")).rejects.toThrow(
      /no message SID/i,
    );
  });
});

describe("SMS provider selection (module load)", () => {
  it("selects twilioSmsProvider when all three Twilio secrets are set", async () => {
    stubTwilioEnv();
    vi.resetModules();
    const fresh = await import("./providers");
    expect(fresh.providers.sms).toBe(fresh.twilioSmsProvider);
  });

  it("falls back to mockSmsProvider when any Twilio secret is missing", async () => {
    stubTwilioEnv();
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    vi.resetModules();
    const fresh = await import("./providers");
    expect(fresh.providers.sms).toBe(fresh.mockSmsProvider);
  });
});

describe("automation → send_sms → Twilio round-trip", () => {
  let org: { id: string };

  beforeAll(async () => {
    const [row] = await db
      .insert(organizationsTable)
      .values({ name: "SMS Delivery Test Org", slug: `test-sms-${Date.now()}` })
      .returning();
    org = row;
  });

  afterAll(async () => {
    await deleteTestOrgs(org.id);
  });

  async function makeLead(phone: string, firstName: string) {
    const contact = await crm.createContact(org.id, {
      firstName,
      lastName: "Delivery",
      phone,
      email: `${firstName.toLowerCase()}@sms.example`,
    });
    await db.insert(consentRecordsTable).values({
      organizationId: org.id,
      contactId: contact.id,
      channel: "sms",
      granted: true,
      disclosureVersion: "v1",
    });
    const lead = await crm.createLead(org.id, { contactId: contact.id });
    return { contact, lead: lead! };
  }

  it("delivers a triggered automation SMS through the Twilio HTTP layer with rendered to/from/body", async () => {
    stubTwilioEnv();
    const calls = stubTwilioFetch({ ok: true, json: { sid: "SMe2e456" } });

    // The active provider was fixed at module load (mock in tests); swap in
    // the real Twilio adapter for this test to exercise the same object the
    // automation engine calls.
    const original = providers.sms;
    providers.sms = twilioSmsProvider;
    try {
      const rule = await createAutomation(org.id, {
        name: "e2e sms",
        event: "lead.created",
        actions: [
          { type: "send_sms", params: { body: "Hi {{contact.firstName}}, thanks!" } },
        ],
      });
      const { lead } = await makeLead("+15557654321", "Rhonda");
      await runEvent(org.id, "lead.created", { leadId: lead.id });

      // The HTTP layer saw exactly one Twilio send with the rendered message.
      expect(calls).toHaveLength(1);
      const params = new URLSearchParams(String(calls[0].init.body));
      expect(params.get("To")).toBe("+15557654321");
      expect(params.get("From")).toBe("+15559990000");
      expect(params.get("Body")).toBe("Hi Rhonda, thanks!");

      // The run is recorded as a real twilio delivery, not a mock.
      const runs = await db
        .select()
        .from(automationRunsTable)
        .where(eq(automationRunsTable.automationId, rule.id));
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe("success");
      expect(runs[0].actionResults[0].status).toBe("success");
      expect(runs[0].actionResults[0].detail).toBe("twilio:SMe2e456");
    } finally {
      providers.sms = original;
    }
  });

  it("records a failed run when Twilio rejects the send (no silent success)", async () => {
    stubTwilioEnv();
    stubTwilioFetch({ ok: false, status: 500, text: "twilio down" });

    const original = providers.sms;
    providers.sms = twilioSmsProvider;
    try {
      const rule = await createAutomation(org.id, {
        name: "e2e sms failure",
        event: "lead.created",
        actions: [{ type: "send_sms", params: { body: "Hello" } }],
      });
      const { lead } = await makeLead("+15550009999", "Fiona");
      await runEvent(org.id, "lead.created", { leadId: lead.id });

      const runs = await db
        .select()
        .from(automationRunsTable)
        .where(eq(automationRunsTable.automationId, rule.id));
      expect(runs).toHaveLength(1);
      expect(runs[0].status).not.toBe("success");
      expect(runs[0].actionResults[0].status).toBe("failed");
    } finally {
      providers.sms = original;
    }
  });

  it("uses the labeled mock provider (no HTTP) when Twilio is not configured", async () => {
    const calls = stubTwilioFetch();
    // Default in this test env: providers.sms is the mock.
    expect(providers.sms).toBe(mockSmsProvider);
    const res = await providers.sms.send("+15551112222", "mock check");
    expect(res.provider).toBe("mock-sms");
    expect(calls).toHaveLength(0);
  });
});
