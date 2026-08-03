/**
 * Embeddable website widget (closer.js) — task: copy-paste snippet + first
 * lead-capture module.
 *
 * Contract under test:
 * - GET /public/closer.js serves the versioned loader with cache headers.
 * - GET /public/widget-config is installation-key scoped, returns modules +
 *   appearance (defaults when unset, stored settings when configured), and
 *   never leaks secrets.
 * - POST /public/widget-leads creates an org-scoped contact + lead with
 *   source "widget" and UTM/referrer/landing-page attribution on the touch
 *   fields; disabled module → 403; invalid body → 400.
 * - The demo page renders the snippet and rejects malformed keys.
 */

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  orgSettingsTable,
} from "@workspace/db";
import { desc, eq } from "drizzle-orm";

import app from "../../app";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import {
  addAuthorizedDomain,
  getActiveInstallationKey,
} from "../../services/installation";
import { getOrgSettings } from "../../services/settings";

let server: Server;
let baseUrl: string;
let org: { id: string };
let key: string;

const ORIGIN = "https://widget-test.example.com";

beforeAll(async () => {
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/api`;

  const [row] = await db
    .insert(organizationsTable)
    .values({ name: "Test Widget Org", slug: `test-widget-${Date.now()}` })
    .returning();
  org = row;
  key = (await getActiveInstallationKey(org.id)).publicKey;
  await addAuthorizedDomain(org.id, "widget-test.example.com");
});

afterAll(async () => {
  await deleteTestOrgs(org.id);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function withKey(extra: Record<string, string> = {}) {
  return { "x-installation-key": key, origin: ORIGIN, ...extra };
}

describe("GET /v1/public/closer.js", () => {
  it("serves the loader with cache headers and no tenant requirement", async () => {
    const res = await fetch(`${baseUrl}/v1/public/closer.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("cache-control")).toContain("max-age=3600");
    expect(res.headers.get("etag")).toBeTruthy();
    const body = await res.text();
    expect(body).toContain("__mfCloser");
    expect(body).toContain("data-org-id");
    expect(body).toContain("/public/widget-leads");
  });
});

describe("GET /v1/public/widget-config", () => {
  it("rejects an unknown key", async () => {
    const res = await fetch(`${baseUrl}/v1/public/widget-config`, {
      headers: {
        "x-installation-key": "mfi_00000000000000000000000000000000",
        origin: ORIGIN,
      },
    });
    expect(res.status).toBe(401);
  });

  it("rejects keyless requests (no default-org fallback on widget routes)", async () => {
    const configRes = await fetch(`${baseUrl}/v1/public/widget-config`);
    expect(configRes.status).toBe(401);
    const leadRes = await fetch(`${baseUrl}/v1/public/widget-leads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ firstName: "Keyless", phone: "4045551111" }),
    });
    expect(leadRes.status).toBe(401);
  });

  it("sanitizes a malicious accent color instead of serving it", async () => {
    await getOrgSettings(org.id); // ensure row
    await db
      .update(orgSettingsTable)
      .set({
        widget: {
          leadCaptureEnabled: true,
          primaryColor: "red}</style><script>alert(1)</script>",
        },
      })
      .where(eq(orgSettingsTable.organizationId, org.id));
    const res = await fetch(`${baseUrl}/v1/public/widget-config`, {
      headers: withKey(),
    });
    const config = (await res.json()) as any;
    expect(config.appearance.primaryColor).toBe("#0f766e");
    await db
      .update(orgSettingsTable)
      .set({ widget: null })
      .where(eq(orgSettingsTable.organizationId, org.id));
  });

  it("returns defaults when the org has no widget settings", async () => {
    const res = await fetch(`${baseUrl}/v1/public/widget-config`, {
      headers: withKey(),
    });
    expect(res.status).toBe(200);
    const config = (await res.json()) as any;
    expect(config.modules.leadCapture).toBe(true);
    expect(config.appearance.position).toBe("right");
    expect(config.appearance.primaryColor).toBeTruthy();
    expect(config.appearance.greeting).toBeTruthy();
    expect(config.appearance.buttonLabel).toBeTruthy();
  });

  it("returns stored settings and never leaks other settings keys", async () => {
    await getOrgSettings(org.id); // ensure row
    await db
      .update(orgSettingsTable)
      .set({
        widget: {
          leadCaptureEnabled: true,
          primaryColor: "#123456",
          position: "left",
          greeting: "Howdy",
          buttonLabel: "Talk to us",
        },
        googleReviews: { placeId: "p", apiKey: "SECRET-KEY" },
      })
      .where(eq(orgSettingsTable.organizationId, org.id));

    const res = await fetch(`${baseUrl}/v1/public/widget-config`, {
      headers: withKey(),
    });
    const config = (await res.json()) as any;
    expect(config.appearance).toEqual({
      primaryColor: "#123456",
      position: "left",
      greeting: "Howdy",
      buttonLabel: "Talk to us",
    });
    expect(JSON.stringify(config)).not.toContain("SECRET-KEY");
  });
});

describe("POST /v1/public/widget-leads", () => {
  it("rejects an invalid body", async () => {
    const res = await fetch(`${baseUrl}/v1/public/widget-leads`, {
      method: "POST",
      headers: withKey({ "content-type": "application/json" }),
      body: JSON.stringify({ firstName: "", phone: "1" }),
    });
    expect(res.status).toBe(400);
  });

  it("creates an org-scoped lead with attribution", async () => {
    const res = await fetch(`${baseUrl}/v1/public/widget-leads`, {
      method: "POST",
      headers: withKey({ "content-type": "application/json" }),
      body: JSON.stringify({
        firstName: "Wanda",
        lastName: "Widget",
        phone: "4045551234",
        email: "wanda@example.com",
        message: "My roof is leaking near the chimney",
        attribution: {
          landingPage: "https://widget-test.example.com/pricing?utm_source=google",
          referrer: "https://google.com/",
          utmSource: "google",
          utmMedium: "cpc",
          utmCampaign: "roof-spring",
        },
      }),
    });
    expect(res.status).toBe(201);
    const { leadId } = (await res.json()) as { leadId: string };

    const [lead] = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.id, leadId));
    expect(lead.organizationId).toBe(org.id);
    expect(lead.source).toBe("widget");
    expect(lead.score).toBeGreaterThan(0);
    const touch = lead.firstTouch as Record<string, unknown>;
    expect(touch.channel).toBe("widget");
    expect(touch.landingPage).toContain("/pricing");
    expect(touch.referrer).toContain("google.com");
    expect(touch.utm).toMatchObject({
      source: "google",
      medium: "cpc",
      campaign: "roof-spring",
    });
    expect(lead.lastTouch).toEqual(lead.firstTouch);

    const [contact] = await db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.id, lead.contactId!));
    expect(contact.firstName).toBe("Wanda");
    expect(contact.phone).toBe("4045551234");
    expect(contact.organizationId).toBe(org.id);
  });

  it("returns 403 when the lead-capture module is disabled", async () => {
    await db
      .update(orgSettingsTable)
      .set({ widget: { leadCaptureEnabled: false } })
      .where(eq(orgSettingsTable.organizationId, org.id));
    const res = await fetch(`${baseUrl}/v1/public/widget-leads`, {
      method: "POST",
      headers: withKey({ "content-type": "application/json" }),
      body: JSON.stringify({ firstName: "Nope", phone: "4045550000" }),
    });
    expect(res.status).toBe(403);
    // re-enable for any later assertions
    await db
      .update(orgSettingsTable)
      .set({ widget: { leadCaptureEnabled: true } })
      .where(eq(orgSettingsTable.organizationId, org.id));
  });

  it("rejects submissions from an unauthorized origin", async () => {
    const res = await fetch(`${baseUrl}/v1/public/widget-leads`, {
      method: "POST",
      headers: {
        "x-installation-key": key,
        origin: "https://evil.example.net",
        "content-type": "application/json",
      },
      body: JSON.stringify({ firstName: "Eve", phone: "4045559999" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /v1/public/widget-demo", () => {
  it("renders the snippet for a well-formed key", async () => {
    const res = await fetch(`${baseUrl}/v1/public/widget-demo?key=${key}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("closer.js");
    expect(html).toContain(`data-org-id="${key}"`);
  });

  it("rejects a malformed key", async () => {
    const res = await fetch(
      `${baseUrl}/v1/public/widget-demo?key=${encodeURIComponent('"<script>')}`,
    );
    expect(res.status).toBe(400);
  });
});
