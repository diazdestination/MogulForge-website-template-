/**
 * Installation keys + authorized domains (task: multi-tenant public routes).
 *
 * Contract under test:
 * - Public endpoints without a key keep the legacy default-org behavior.
 * - With an installation key, the org is resolved from the key and the
 *   request's Origin hostname must be on that org's authorized-domain list:
 *   unknown key → 401, missing/unauthorized origin → 403.
 * - Domain matching: exact, www-equivalence, "*.example.com" wildcards,
 *   localhost regardless of port.
 * - Rotation invalidates the old key immediately.
 * - Admin routes require settings.manage and normalize/validate domains.
 */

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  db,
  installationKeysTable,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";

import app from "../app";
import { createSession } from "../lib/auth";
import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import {
  addAuthorizedDomain,
  getActiveInstallationKey,
  isHostnameAuthorized,
  normalizeDomain,
  rotateInstallationKey,
} from "./installation";

let server: Server;
let baseUrl: string;
let orgA: { id: string };
let orgB: { id: string };
let keyA: string;
let keyB: string;
let adminSid: string;

beforeAll(async () => {
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/api`;

  const [a] = await db
    .insert(organizationsTable)
    .values({ name: "Test Install Org A", slug: `test-install-a-${Date.now()}` })
    .returning();
  const [b] = await db
    .insert(organizationsTable)
    .values({ name: "Test Install Org B", slug: `test-install-b-${Date.now()}` })
    .returning();
  orgA = a;
  orgB = b;
  keyA = (await getActiveInstallationKey(orgA.id)).publicKey;
  keyB = (await getActiveInstallationKey(orgB.id)).publicKey;
  await addAuthorizedDomain(orgA.id, "example.com");
  await addAuthorizedDomain(orgA.id, "*.staging.example.com");
  await addAuthorizedDomain(orgA.id, "localhost");

  // Admin member of org A for the settings routes.
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `install-admin-${Date.now()}@test.example.com`,
      organizationId: orgA.id,
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
  await deleteTestOrgs(orgA.id, orgB.id);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function siteConfig(headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/v1/public/site-config`, { headers });
}

describe("normalizeDomain", () => {
  it("normalizes URLs, case, ports and paths down to a hostname", () => {
    expect(normalizeDomain("https://WWW.Example.com/path?q=1")).toBe("www.example.com");
    expect(normalizeDomain("Example.COM:3000/x")).toBe("example.com");
    expect(normalizeDomain("  sub.example.com. ")).toBe("sub.example.com");
    expect(normalizeDomain("*.Example.com")).toBe("*.example.com");
    expect(normalizeDomain("localhost")).toBe("localhost");
  });

  it("rejects garbage", () => {
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain("   ")).toBeNull();
    expect(normalizeDomain("not a domain")).toBeNull();
    expect(normalizeDomain("exa mple.com")).toBeNull();
    expect(normalizeDomain("*.com")).toBeNull();
    expect(normalizeDomain("-bad.com")).toBeNull();
  });
});

describe("isHostnameAuthorized", () => {
  const entries = ["example.com", "*.staging.example.com", "localhost", "www.other.com"];

  it("matches exact, www-equivalent, wildcard and localhost hosts", () => {
    expect(isHostnameAuthorized("example.com", entries)).toBe(true);
    expect(isHostnameAuthorized("www.example.com", entries)).toBe(true); // www of bare entry
    expect(isHostnameAuthorized("other.com", entries)).toBe(true); // bare of www entry
    expect(isHostnameAuthorized("a.staging.example.com", entries)).toBe(true);
    expect(isHostnameAuthorized("deep.a.staging.example.com", entries)).toBe(true);
    expect(isHostnameAuthorized("staging.example.com", entries)).toBe(true); // wildcard apex
    expect(isHostnameAuthorized("localhost", entries)).toBe(true);
  });

  it("rejects unrelated and suffix-spoofing hosts", () => {
    expect(isHostnameAuthorized("evil.com", entries)).toBe(false);
    expect(isHostnameAuthorized("example.com.evil.com", entries)).toBe(false);
    expect(isHostnameAuthorized("notexample.com", entries)).toBe(false);
    expect(isHostnameAuthorized("badstaging.example.com", entries)).toBe(false);
    expect(isHostnameAuthorized("app.example.com", entries)).toBe(false); // no wildcard on apex entry
    expect(isHostnameAuthorized("", entries)).toBe(false);
  });
});

describe("public routes with installation keys", () => {
  it("keeps legacy default-org behavior when no key is sent", async () => {
    const res = await siteConfig();
    expect(res.status).toBe(200);
  });

  it("rejects unknown keys with 401", async () => {
    const res = await siteConfig({
      "x-installation-key": "mfi_00000000000000000000000000000000",
      origin: "https://example.com",
    });
    expect(res.status).toBe(401);
  });

  it("rejects a valid key without an Origin/Referer with 403", async () => {
    const res = await siteConfig({ "x-installation-key": keyA });
    expect(res.status).toBe(403);
  });

  it("accepts a valid key from an authorized origin (incl. www + wildcard + localhost port)", async () => {
    for (const origin of [
      "https://example.com",
      "https://www.example.com",
      "https://app.staging.example.com",
      "http://localhost:5173",
    ]) {
      const res = await siteConfig({ "x-installation-key": keyA, origin });
      expect(res.status, origin).toBe(200);
    }
  });

  it("falls back to Referer when Origin is absent", async () => {
    const res = await siteConfig({
      "x-installation-key": keyA,
      referer: "https://example.com/some/page",
    });
    expect(res.status).toBe(200);
  });

  it("rejects unauthorized origins with 403 — including another org's domain", async () => {
    const evil = await siteConfig({
      "x-installation-key": keyA,
      origin: "https://evil.com",
    });
    expect(evil.status).toBe(403);
    // org B's key does not inherit org A's domains
    const cross = await siteConfig({
      "x-installation-key": keyB,
      origin: "https://example.com",
    });
    expect(cross.status).toBe(403);
  });

  it("concurrent issuance and rotation never leave two active keys", async () => {
    const [org] = await db
      .insert(organizationsTable)
      .values({ name: "Test Install Race Org", slug: `test-install-race-${Date.now()}` })
      .returning();
    try {
      const issued = await Promise.all(
        Array.from({ length: 5 }, () => getActiveInstallationKey(org.id)),
      );
      expect(new Set(issued.map((k) => k.publicKey)).size).toBe(1);

      await Promise.all(
        Array.from({ length: 5 }, () => rotateInstallationKey(org.id)),
      );
      const active = await db
        .select()
        .from(installationKeysTable)
        .where(
          and(
            eq(installationKeysTable.organizationId, org.id),
            eq(installationKeysTable.isActive, true),
          ),
        );
      expect(active.length).toBe(1);
    } finally {
      await deleteTestOrgs(org.id);
    }
  });

  it("google-reviews public route is covered by the resolver (401 on bad key)", async () => {
    const res = await fetch(`${baseUrl}/v1/public/google-reviews`, {
      headers: {
        "x-installation-key": "mfi_00000000000000000000000000000000",
        origin: "https://example.com",
      },
    });
    expect(res.status).toBe(401);
  });

  it("rotation invalidates the old key immediately", async () => {
    const oldKey = (await getActiveInstallationKey(orgB.id)).publicKey;
    await addAuthorizedDomain(orgB.id, "orgb.com");
    const rotated = await rotateInstallationKey(orgB.id);
    expect(rotated.publicKey).not.toBe(oldKey);

    const stale = await siteConfig({
      "x-installation-key": oldKey,
      origin: "https://orgb.com",
    });
    expect(stale.status).toBe(401);
    const fresh = await siteConfig({
      "x-installation-key": rotated.publicKey,
      origin: "https://orgb.com",
    });
    expect(fresh.status).toBe(200);
  });
});

describe("admin installation routes", () => {
  function api(method: string, path: string, body?: unknown) {
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${adminSid}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  it("requires auth", async () => {
    const res = await fetch(`${baseUrl}/v1/installation`);
    expect([401, 403]).toContain(res.status);
  });

  it("returns the key and domains, adds normalized domains, rejects garbage, removes domains", async () => {
    const initial = await api("GET", "/v1/installation");
    expect(initial.status).toBe(200);
    const data = (await initial.json()) as { publicKey: string; domains: { id: string; domain: string }[] };
    expect(data.publicKey.startsWith("mfi_")).toBe(true);

    const added = await api("POST", "/v1/installation/domains", {
      domain: "https://New.Client-Site.com/landing",
    });
    expect(added.status).toBe(201);
    const dom = (await added.json()) as { id: string; domain: string };
    expect(dom.domain).toBe("new.client-site.com");

    const bad = await api("POST", "/v1/installation/domains", { domain: "not a domain" });
    expect(bad.status).toBe(400);

    const removed = await api("DELETE", `/v1/installation/domains/${dom.id}`);
    expect(removed.status).toBe(204);
    const missing = await api("DELETE", `/v1/installation/domains/${dom.id}`);
    expect(missing.status).toBe(404);
  });

  it("rotates the key via the API", async () => {
    const before = (await (await api("GET", "/v1/installation")).json()) as { publicKey: string };
    const rotated = await api("POST", "/v1/installation/rotate", undefined);
    expect(rotated.status).toBe(201);
    const after = (await rotated.json()) as { publicKey: string };
    expect(after.publicKey).not.toBe(before.publicKey);
    expect(after.publicKey.startsWith("mfi_")).toBe(true);
  });
});
