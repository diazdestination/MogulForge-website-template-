/**
 * Installation verification, heartbeat & widget test mode (task: let admins
 * verify their website installation and preview the widget safely).
 *
 * Contract under test:
 * - classifyInstallation covers every detection state: installed, wrong key,
 *   misconfigured (missing data-org-id), domain-not-authorized, not detected.
 * - verifyInstallation persists results (upsert — latest per domain) and maps
 *   fetch failures to "unreachable"; wildcards/garbage are rejected.
 * - POST /v1/installation/checks requires settings.manage and validates input.
 * - GET /v1/installation reports heartbeat + latest checks.
 * - POST /v1/public/widget-heartbeat records last-seen info on the active key.
 * - Test mode hides modules from normal visitors but not from preview
 *   requests, and never blocks lead submission.
 */

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  db,
  installationKeysTable,
  organizationsTable,
  orgSettingsTable,
  usersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";

import app from "../../app";
import { createSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import {
  addAuthorizedDomain,
  getActiveInstallationKey,
} from "../../services/installation";
import { vi } from "vitest";

import {
  classifyInstallation,
  fetchPublicUrl,
  verifyInstallation,
} from "../../services/installationCheck";
import { getOrgSettings } from "../../services/settings";

let server: Server;
let baseUrl: string;
let org: { id: string };
let key: string;
let adminSid: string;

const ORIGIN = "https://check-test.example.com";

const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;
const snippet = (k: string) =>
  `<script async src="https://crm.example.com/api/v1/public/closer.js" data-org-id="${k}"></script>`;

beforeAll(async () => {
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/api`;

  const [row] = await db
    .insert(organizationsTable)
    .values({ name: "Test Check Org", slug: `test-check-${Date.now()}` })
    .returning();
  org = row;
  key = (await getActiveInstallationKey(org.id)).publicKey;
  await addAuthorizedDomain(org.id, "check-test.example.com");

  const [user] = await db
    .insert(usersTable)
    .values({
      email: `check-admin-${Date.now()}@test.example.com`,
      organizationId: org.id,
      role: "admin",
    })
    .returning();
  adminSid = await createSession({
    user: {
      id: user.id,
      email: null,
      firstName: null,
      lastName: null,
      profileImageUrl: null,
    },
    access_token: "test-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
});

afterAll(async () => {
  await deleteTestOrgs(org.id);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("classifyInstallation", () => {
  const expectedKey = "mfi_expected";

  it("detects a correct installation", () => {
    const r = classifyInstallation({
      html: page(snippet(expectedKey)),
      expectedKey,
      domainAuthorized: true,
    });
    expect(r.status).toBe("installed");
  });

  it("detects a wrong key", () => {
    const r = classifyInstallation({
      html: page(snippet("mfi_other")),
      expectedKey,
      domainAuthorized: true,
    });
    expect(r.status).toBe("wrong_key");
  });

  it("detects a missing data-org-id as misconfigured", () => {
    const r = classifyInstallation({
      html: page('<script async src="/api/v1/public/closer.js"></script>'),
      expectedKey,
      domainAuthorized: true,
    });
    expect(r.status).toBe("misconfigured");
  });

  it("flags an unauthorized domain even when the snippet is right", () => {
    const r = classifyInstallation({
      html: page(snippet(expectedKey)),
      expectedKey,
      domainAuthorized: false,
    });
    expect(r.status).toBe("domain_not_authorized");
  });

  it("reports not_detected when no snippet exists", () => {
    const r = classifyInstallation({
      html: page("<h1>hello</h1>"),
      expectedKey,
      domainAuthorized: true,
    });
    expect(r.status).toBe("not_detected");
  });
});

describe("verifyInstallation", () => {
  it("persists the latest result per domain (upsert)", async () => {
    const first = await verifyInstallation(org.id, "check-test.example.com", async () =>
      page("<h1>no snippet yet</h1>"),
    );
    expect(first?.status).toBe("not_detected");
    const second = await verifyInstallation(org.id, "check-test.example.com", async () =>
      page(snippet(key)),
    );
    expect(second?.status).toBe("installed");
    expect(second?.id).toBe(first?.id); // same row, updated
  });

  it("maps fetch failures to unreachable", async () => {
    const r = await verifyInstallation(org.id, "down.example.com", async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(r?.status).toBe("unreachable");
    expect(r?.detail).toContain("ECONNREFUSED");
  });

  it("rejects wildcards and garbage", async () => {
    expect(await verifyInstallation(org.id, "*.example.com")).toBeNull();
    expect(await verifyInstallation(org.id, "not a domain")).toBeNull();
  });
});

describe("fetchPublicUrl SSRF guard", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("blocks internal targets outright", async () => {
    await expect(fetchPublicUrl("http://127.0.0.1/")).rejects.toThrow();
    await expect(fetchPublicUrl("http://169.254.169.254/")).rejects.toThrow();
    await expect(
      fetchPublicUrl("http://metadata.google.internal/"),
    ).rejects.toThrow();
  });

  it("re-validates every redirect hop — a public URL cannot bounce to an internal one", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    // 93.184.216.34 is a public literal — passes the initial check without
    // DNS; the stubbed 302 then points at the metadata service.
    await expect(fetchPublicUrl("http://93.184.216.34/")).rejects.toThrow(
      /blocked/i,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1); // never fetched the redirect target
  });

  it("follows benign public-to-public redirects and caps the depth", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        calls++;
        if (String(url).includes("93.184.216.34")) {
          return new Response(null, {
            status: 301,
            headers: { location: "http://93.184.216.35/home" },
          });
        }
        return new Response("<html>ok</html>", { status: 200 });
      }),
    );
    await expect(fetchPublicUrl("http://93.184.216.34/")).resolves.toContain("ok");
    expect(calls).toBe(2);

    // Endless loop → capped.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://93.184.216.34/loop" },
        }),
      ),
    );
    await expect(fetchPublicUrl("http://93.184.216.34/")).rejects.toThrow(
      /redirects/,
    );
  });
});

describe("POST /v1/installation/checks & GET /v1/installation", () => {
  it("requires auth", async () => {
    const res = await fetch(`${baseUrl}/v1/installation/checks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain: "example.com" }),
    });
    expect(res.status).toBe(401);
  });

  it("validates the domain and surfaces stored checks + heartbeat", async () => {
    const bad = await fetch(`${baseUrl}/v1/installation/checks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `sid=${adminSid}`,
      },
      body: JSON.stringify({ domain: "*.example.com" }),
    });
    expect(bad.status).toBe(400);

    // Heartbeat from the "website".
    const hb = await fetch(`${baseUrl}/v1/public/widget-heartbeat`, {
      method: "POST",
      headers: {
        "x-installation-key": key,
        origin: ORIGIN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ version: "2", host: "check-test.example.com" }),
    });
    expect(hb.status).toBe(204);

    const res = await fetch(`${baseUrl}/v1/installation`, {
      headers: { cookie: `sid=${adminSid}` },
    });
    const body = (await res.json()) as any;
    expect(body.heartbeat?.lastSeenAt).toBeTruthy();
    expect(body.heartbeat?.version).toBe("2");
    expect(body.heartbeat?.host).toBe("check-test.example.com");
    const check = body.checks.find(
      (c: any) => c.domain === "check-test.example.com",
    );
    expect(check?.status).toBe("installed");
  });

  it("rejects keyless heartbeats", async () => {
    const res = await fetch(`${baseUrl}/v1/public/widget-heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: "2" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("widget test mode", () => {
  const configUrl = (preview: boolean) =>
    `${baseUrl}/v1/public/widget-config${preview ? "?preview=1" : ""}`;
  const headers = () => ({ "x-installation-key": key, origin: ORIGIN });

  it("hides modules from normal visitors but not preview requests", async () => {
    await getOrgSettings(org.id); // ensure row
    await db
      .update(orgSettingsTable)
      .set({ widget: { leadCaptureEnabled: true, testMode: true } })
      .where(eq(orgSettingsTable.organizationId, org.id));

    const normal = (await (await fetch(configUrl(false), { headers: headers() })).json()) as any;
    expect(normal.testMode).toBe(true);
    expect(normal.modules.leadCapture).toBe(false);

    const preview = (await (await fetch(configUrl(true), { headers: headers() })).json()) as any;
    expect(preview.modules.leadCapture).toBe(true);
  });

  it("still accepts lead submissions while in test mode (admin preview)", async () => {
    const res = await fetch(`${baseUrl}/v1/public/widget-leads`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({ firstName: "Preview", phone: "4045557777" }),
    });
    expect(res.status).toBe(201);
  });
});
