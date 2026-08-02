import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import {
  auditEventsTable,
  db,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

import app from "../../app";
import { createFailureLimiter } from "../../lib/rateLimit";
import { invalidApiKeyLimiter } from "../../middlewares/requireMember";
import { createApiKey } from "../../services/api-keys";
import { reportApiKeyBruteForceBlock } from "../../services/security-alerts";

/**
 * When an IP crosses the invalid-API-key threshold (see requireMember),
 * admins are alerted via an `api_key.brute_force_blocked` audit event —
 * recorded once per block window for each org with an active API key.
 *
 * Count assertions use unique fake IPs (filtered via metadata) so parallel
 * test files that also trip the limiter can't interfere.
 */

const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;
const ACTION = "api_key.brute_force_blocked";

let server: Server;
let baseUrl: string;
let orgId: string;

async function get(path: string, key: string) {
  return fetch(`${baseUrl}${path}`, { headers: { "x-api-key": key } });
}

async function blockEventsForIp(ip: string) {
  return db
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.organizationId, orgId),
        eq(auditEventsTable.action, ACTION),
        sql`${auditEventsTable.metadata} ->> 'ip' = ${ip}`,
      ),
    );
}

/** The audit write is fire-and-forget on the HTTP path, so poll briefly. */
async function waitForBlockEvents(ip: string, minCount: number) {
  for (let i = 0; i < 50; i++) {
    const rows = await blockEventsForIp(ip);
    if (rows.length >= minCount) return rows;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return blockEventsForIp(ip);
}

beforeAll(async () => {
  const [org] = await db
    .insert(organizationsTable)
    .values({ name: "BruteForce Alert Org", slug: `brute-alert-${Date.now()}` })
    .returning();
  orgId = org.id;
  const [admin] = await db
    .insert(usersTable)
    .values({
      email: `brute-alert-admin-${Date.now()}@example.com`,
      organizationId: org.id,
      role: "admin",
    })
    .returning();
  // The org must hold an active API key to be alerted about key guessing.
  await createApiKey({
    organizationId: org.id,
    name: "alert target key",
    role: "office",
    createdByUserId: admin.id,
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  invalidApiKeyLimiter.reset();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteTestOrgs(orgId);
});

beforeEach(() => {
  invalidApiKeyLimiter.reset();
});

describe("admin alerting when an IP is blocked for API-key guessing", () => {
  it("recordFailure reports the block exactly once per window", async () => {
    const limiter = createFailureLimiter({
      windowMs: WINDOW_MS,
      max: MAX_FAILURES,
      scope: `alert-test-${Date.now()}`,
    });
    const ip = "198.51.100.10";
    for (let i = 1; i < MAX_FAILURES; i++) {
      expect(await limiter.recordFailure(ip)).toBe(false);
    }
    // The attempt that crosses the threshold is the only one reported.
    expect(await limiter.recordFailure(ip)).toBe(true);
    expect(await limiter.recordFailure(ip)).toBe(false);
    expect(await limiter.recordFailure(ip)).toBe(false);
    // A fresh window reports again.
    limiter.reset();
    for (let i = 1; i < MAX_FAILURES; i++) await limiter.recordFailure(ip);
    expect(await limiter.recordFailure(ip)).toBe(true);
  });

  it("records an audit event for orgs with active API keys", async () => {
    const ip = `198.51.100.${20 + Math.floor(Math.random() * 200)}-${Date.now()}`;
    await reportApiKeyBruteForceBlock({
      ip,
      windowMs: WINDOW_MS,
      maxFailures: MAX_FAILURES,
    });
    const events = await blockEventsForIp(ip);
    expect(events).toHaveLength(1);
    expect(events[0].entityType).toBe("api_key");
    expect(events[0].metadata).toMatchObject({
      ip,
      maxFailures: MAX_FAILURES,
      windowMs: WINDOW_MS,
    });
  });

  it("crossing the threshold over HTTP records the audit event", async () => {
    for (let i = 0; i < MAX_FAILURES; i++) {
      expect((await get("/v1/contacts", `pk_guess_${i}`)).status).toBe(401);
    }
    expect((await get("/v1/contacts", "pk_guess_blocked")).status).toBe(429);
    // The server saw the loopback address; assert the event landed for it.
    const events = await waitForBlockEvents("127.0.0.1", 1);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].entityType).toBe("api_key");
  });
});
