import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { db, organizationsTable, usersTable, webhookEndpointsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

import app from "../../app";
import { createSession } from "../../lib/auth";
import {
  activeSigningSecrets,
  buildSignatureHeader,
  expirePreviousSecret,
  verifySignatureHeader,
} from "../../services/webhooks";

/**
 * Secret-handling contract for webhook endpoints:
 *  - plaintext secret is returned exactly once, at creation and at rotation;
 *  - GET /v1/webhooks, PATCH, and DELETE /previous-secret responses never
 *    contain `secret` or `previousSecret` (nor plaintext values);
 *  - rotation exposes `previousSecretExpiresAt` during the grace window;
 *  - DELETE /previous-secret ends the grace window: the old secret no longer
 *    participates in signing (activeSigningSecrets / signature verification).
 */

let server: Server;
let baseUrl: string;
let org: { id: string };
let adminSid: string;

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${adminSid}`,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

beforeAll(async () => {
  const [o] = await db
    .insert(organizationsTable)
    .values({ name: "Webhook Redaction Org", slug: `wh-redact-${Date.now()}` })
    .returning();
  org = o;
  const [admin] = await db
    .insert(usersTable)
    .values({
      email: `wh-redact-admin-${Date.now()}@example.com`,
      organizationId: org.id,
      role: "admin",
    })
    .returning();
  adminSid = await createSession({
    user: {
      id: admin.id,
      email: null,
      firstName: null,
      lastName: null,
      profileImageUrl: null,
    },
    access_token: "test-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteTestOrgs(org.id);
});

function expectRedacted(obj: Record<string, unknown>, ...plaintexts: string[]) {
  expect(obj).not.toHaveProperty("secret");
  expect(obj).not.toHaveProperty("previousSecret");
  const serialized = JSON.stringify(obj);
  for (const plain of plaintexts) {
    expect(serialized).not.toContain(plain);
    expect(serialized).not.toContain("enc:v1:");
  }
}

describe("webhook secret redaction across the endpoint lifecycle", () => {
  let endpointId: string;
  let createdSecret: string;
  let rotatedSecret: string;

  it("creation returns the plaintext secret exactly once", async () => {
    const res = await api("POST", "/v1/webhooks", {
      url: "https://example.com/hooks/redaction",
      events: [],
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; secret: string };
    endpointId = created.id;
    createdSecret = created.secret;
    expect(createdSecret).toMatch(/^whsec_/);
  });

  it("GET /v1/webhooks never exposes secret or previousSecret", async () => {
    const res = await api("GET", "/v1/webhooks");
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Record<string, unknown>[];
    const row = rows.find((r) => r.id === endpointId);
    expect(row).toBeDefined();
    expectRedacted(row!, createdSecret);
  });

  it("PATCH response is redacted", async () => {
    const res = await api("PATCH", `/v1/webhooks/${endpointId}`, {
      url: "https://example.com/hooks/redaction-2",
    });
    expect(res.status).toBe(200);
    expectRedacted((await res.json()) as Record<string, unknown>, createdSecret);
  });

  it("rotation returns the new secret once, never the previous one, and sets previousSecretExpiresAt", async () => {
    const res = await api("POST", `/v1/webhooks/${endpointId}/rotate-secret`, {
      gracePeriodHours: 24,
    });
    expect(res.status).toBe(200);
    const rotated = (await res.json()) as Record<string, unknown> & {
      secret: string;
      previousSecretExpiresAt: string | null;
    };
    rotatedSecret = rotated.secret;
    expect(rotatedSecret).toMatch(/^whsec_/);
    expect(rotatedSecret).not.toBe(createdSecret);
    // Old secret must not ride along in the rotation response.
    expect(rotated).not.toHaveProperty("previousSecret");
    expect(JSON.stringify(rotated)).not.toContain(createdSecret);
    expect(rotated.previousSecretExpiresAt).toBeTruthy();
    expect(new Date(rotated.previousSecretExpiresAt!).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it("list during the grace window shows previousSecretExpiresAt but no secrets", async () => {
    const res = await api("GET", "/v1/webhooks");
    const rows = (await res.json()) as Record<string, unknown>[];
    const row = rows.find((r) => r.id === endpointId)!;
    expectRedacted(row, createdSecret, rotatedSecret);
    expect(row.previousSecretExpiresAt).toBeTruthy();
  });

  it("during the grace window both secrets sign deliveries", async () => {
    const [endpoint] = await db
      .select()
      .from(webhookEndpointsTable)
      .where(eq(webhookEndpointsTable.id, endpointId));
    const secrets = activeSigningSecrets(endpoint);
    expect(secrets).toEqual([rotatedSecret, createdSecret]);

    const body = '{"event":"lead.created"}';
    const header = buildSignatureHeader(secrets, body);
    expect(verifySignatureHeader(rotatedSecret, body, header)).toBe(true);
    expect(verifySignatureHeader(createdSecret, body, header)).toBe(true);
  });

  it("DELETE /previous-secret is redacted and clears previousSecretExpiresAt", async () => {
    const res = await api("DELETE", `/v1/webhooks/${endpointId}/previous-secret`);
    expect(res.status).toBe(200);
    const bodyJson = (await res.json()) as Record<string, unknown>;
    expectRedacted(bodyJson, createdSecret, rotatedSecret);
    expect(bodyJson.previousSecretExpiresAt).toBeNull();
  });

  it("after expiring the grace window, only the new secret verifies", async () => {
    const [endpoint] = await db
      .select()
      .from(webhookEndpointsTable)
      .where(eq(webhookEndpointsTable.id, endpointId));
    const secrets = activeSigningSecrets(endpoint);
    expect(secrets).toEqual([rotatedSecret]);

    const body = '{"event":"lead.created"}';
    const header = buildSignatureHeader(secrets, body);
    expect(verifySignatureHeader(rotatedSecret, body, header)).toBe(true);
    // Old secret can no longer verify freshly signed deliveries.
    expect(verifySignatureHeader(createdSecret, body, header)).toBe(false);
  });
});

describe("expirePreviousSecret service behavior", () => {
  it("honors only the new secret after ending a grace window, even before expiry", async () => {
    const create = await api("POST", "/v1/webhooks", {
      url: "https://example.com/hooks/service-expire",
    });
    const created = (await create.json()) as { id: string; secret: string };

    const rotate = await api("POST", `/v1/webhooks/${created.id}/rotate-secret`, {
      gracePeriodHours: 48,
    });
    const rotated = (await rotate.json()) as { secret: string };

    // Grace window active: two signing secrets.
    let [endpoint] = await db
      .select()
      .from(webhookEndpointsTable)
      .where(eq(webhookEndpointsTable.id, created.id));
    expect(activeSigningSecrets(endpoint)).toHaveLength(2);

    const expired = await expirePreviousSecret(org.id, created.id);
    expect(expired).not.toBeNull();
    expect(expired!.previousSecret).toBeNull();
    expect(expired!.previousSecretExpiresAt).toBeNull();

    [endpoint] = await db
      .select()
      .from(webhookEndpointsTable)
      .where(eq(webhookEndpointsTable.id, created.id));
    expect(activeSigningSecrets(endpoint)).toEqual([rotated.secret]);
    expect(activeSigningSecrets(endpoint)).not.toContain(created.secret);
  });

  it("scopes by organization: another org cannot expire the window", async () => {
    const create = await api("POST", "/v1/webhooks", {
      url: "https://example.com/hooks/cross-org",
    });
    const created = (await create.json()) as { id: string };
    await api("POST", `/v1/webhooks/${created.id}/rotate-secret`, {
      gracePeriodHours: 24,
    });

    const result = await expirePreviousSecret(
      "00000000-0000-0000-0000-000000000000",
      created.id,
    );
    expect(result).toBeNull();

    const [endpoint] = await db
      .select()
      .from(webhookEndpointsTable)
      .where(eq(webhookEndpointsTable.id, created.id));
    expect(endpoint.previousSecret).not.toBeNull();
  });
});
