import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { db, organizationsTable, usersTable } from "@workspace/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

import app from "../../app";
import { createSession } from "../../lib/auth";

/**
 * Admins can dismiss the brute-force security banner by acknowledging alerts
 * up to a timestamp (PUT /v1/settings { securityAlertsAcknowledgedAt }).
 *
 * Contract under test:
 *  - the timestamp persists on org settings and round-trips via GET;
 *  - a future timestamp is clamped to "now" so it can't pre-dismiss attacks
 *    that haven't happened yet;
 *  - garbage timestamps are rejected with 400.
 */

let server: Server;
let baseUrl: string;
let org: { id: string };
let adminSid: string;

async function api(method: string, path: string, body?: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${adminSid}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

beforeAll(async () => {
  const [o] = await db
    .insert(organizationsTable)
    .values({ name: "SecAck Test Org", slug: `secack-test-${Date.now()}` })
    .returning();
  org = o;
  const [u] = await db
    .insert(usersTable)
    .values({
      email: `secack-admin-${Date.now()}@example.com`,
      organizationId: org.id,
      role: "admin",
    })
    .returning();
  adminSid = await createSession({
    user: {
      id: u.id,
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

describe("security alert acknowledgement", () => {
  it("persists the acknowledgement timestamp and round-trips via GET", async () => {
    const ackAt = new Date(Date.now() - 60_000).toISOString();
    const put = await api("PUT", "/v1/settings", {
      securityAlertsAcknowledgedAt: ackAt,
    });
    expect(put.status).toBe(200);

    const get = await api("GET", "/v1/settings");
    const settings = (await get.json()) as { securityAlertsAcknowledgedAt: string | null };
    expect(settings.securityAlertsAcknowledgedAt).toBeTruthy();
    expect(new Date(settings.securityAlertsAcknowledgedAt!).getTime()).toBe(
      new Date(ackAt).getTime(),
    );
  });

  it("clamps a future acknowledgement to now", async () => {
    const before = Date.now();
    const put = await api("PUT", "/v1/settings", {
      securityAlertsAcknowledgedAt: new Date(before + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(put.status).toBe(200);
    const settings = (await put.json()) as { securityAlertsAcknowledgedAt: string | null };
    const stored = new Date(settings.securityAlertsAcknowledgedAt!).getTime();
    expect(stored).toBeGreaterThanOrEqual(before);
    expect(stored).toBeLessThanOrEqual(Date.now());
  });

  it("rejects an unparseable timestamp", async () => {
    const put = await api("PUT", "/v1/settings", {
      securityAlertsAcknowledgedAt: "not-a-date",
    });
    expect(put.status).toBe(400);
  });
});
