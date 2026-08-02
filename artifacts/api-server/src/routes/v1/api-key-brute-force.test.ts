import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { db, organizationsTable, usersTable } from "@workspace/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

import express from "express";

import app from "../../app";
import { createFailureLimiter, rateLimit } from "../../lib/rateLimit";
import { invalidApiKeyLimiter } from "../../middlewares/requireMember";
import { createApiKey } from "../../services/api-keys";

/**
 * Brute-force protection for `x-api-key` auth (see requireMember):
 *  - repeated invalid-key attempts from one IP get 429 before any DB lookup;
 *  - successful key auth is never counted, so legitimate keys keep working.
 */

const MAX_FAILURES = 10;

let server: Server;
let baseUrl: string;
let validKey: string;
let orgId: string;

async function get(path: string, key: string) {
  return fetch(`${baseUrl}${path}`, { headers: { "x-api-key": key } });
}

beforeAll(async () => {
  const [org] = await db
    .insert(organizationsTable)
    .values({ name: "BruteForce Test Org", slug: `brute-force-${Date.now()}` })
    .returning();
  orgId = org.id;
  const [admin] = await db
    .insert(usersTable)
    .values({
      email: `brute-force-admin-${Date.now()}@example.com`,
      organizationId: org.id,
      role: "admin",
    })
    .returning();
  validKey = (
    await createApiKey({
      organizationId: org.id,
      name: "legit key",
      role: "office",
      createdByUserId: admin.id,
    })
  ).key;

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

describe("invalid API key brute-force throttling", () => {
  it("returns 429 after repeated invalid-key attempts from the same IP", async () => {
    for (let i = 0; i < MAX_FAILURES; i++) {
      const res = await get("/v1/contacts", `pk_bogus_${i}`);
      expect(res.status).toBe(401);
    }
    const blocked = await get("/v1/contacts", "pk_bogus_final");
    expect(blocked.status).toBe(429);
    // Once blocked, even a valid key from that IP is rejected without a lookup.
    expect((await get("/v1/contacts", validKey)).status).toBe(429);
  });

  it("blocks without a database lookup once the budget is exhausted", async () => {
    const ip = "203.0.113.7";
    for (let i = 0; i < MAX_FAILURES; i++) invalidApiKeyLimiter.recordFailure(ip);
    expect(invalidApiKeyLimiter.isBlocked(ip)).toBe(true);
    expect(invalidApiKeyLimiter.isBlocked("203.0.113.8")).toBe(false);
  });

  it("successful key auth is never counted against the budget", async () => {
    for (let i = 0; i < MAX_FAILURES + 5; i++) {
      const res = await get("/v1/contacts", validKey);
      expect(res.status).toBe(200);
    }
    // A few failures below the cap don't affect the valid key either.
    for (let i = 0; i < MAX_FAILURES - 1; i++) {
      expect((await get("/v1/contacts", `pk_wrong_${i}`)).status).toBe(401);
    }
    expect((await get("/v1/contacts", validKey)).status).toBe(200);
  });
});

describe("cross-instance shared budgets", () => {
  it("a fresh limiter instance (simulated restart) blocks a known-bad id via isBlockedShared before any recordFailure", async () => {
    // Use an isolated scope so this test is unaffected by beforeEach resets on
    // the shared invalidApiKeyLimiter. Both limiters start at generation 0.
    const scope = `api-key-restart-test-${Date.now()}`;
    const opts = { windowMs: 15 * 60 * 1000, max: MAX_FAILURES, scope };
    const ip = "198.51.100.7";

    // Limiter A: the "previous server instance" — burns the budget into the shared DB.
    const limiterA = createFailureLimiter(opts);
    for (let i = 0; i < MAX_FAILURES; i++) await limiterA.recordFailure(ip);
    expect(limiterA.isBlocked(ip)).toBe(true);

    // Limiter B: simulates a restarted instance — fresh local cache, same scope.
    const limiterB = createFailureLimiter(opts);
    // Synchronous isBlocked sees nothing: local cache is empty.
    expect(limiterB.isBlocked(ip)).toBe(false);
    // isBlockedShared falls back to the shared DB and must detect the block
    // without any preceding recordFailure call on this instance.
    expect(await limiterB.isBlockedShared(ip)).toBe(true);
    // isBlockedShared hydrates the local cache — synchronous path is also true now.
    expect(limiterB.isBlocked(ip)).toBe(true);

    limiterA.reset(); // cleanup shared DB rows
  });

  it("failures recorded on one failure limiter block another with the same scope", async () => {
    const scope = `xinstance-fail-${Date.now()}`;
    const opts = { windowMs: 60_000, max: 3, scope };
    const limiterA = createFailureLimiter(opts);
    const limiterB = createFailureLimiter(opts);
    const id = "198.51.100.42";

    // Instance A burns the whole budget.
    for (let i = 0; i < opts.max; i++) await limiterA.recordFailure(id);
    expect(limiterA.isBlocked(id)).toBe(true);

    // Instance B has no local history yet, but its next recorded failure
    // reconciles against the shared counter and must block immediately.
    expect(limiterB.isBlocked(id)).toBe(false);
    await limiterB.recordFailure(id);
    expect(limiterB.isBlocked(id)).toBe(true);

    limiterA.reset();
    limiterB.reset();
  });

  it("public rateLimit middleware counts requests across two app instances", async () => {
    const max = 5;
    const key = `xinstance-rate-${Date.now()}`;
    const makeApp = () => {
      const instance = express();
      instance.get(
        "/ping",
        rateLimit({ windowMs: 60_000, max, key }),
        (_req, res) => {
          res.json({ ok: true });
        },
      );
      return instance;
    };

    const servers: Server[] = [makeApp().listen(0), makeApp().listen(0)];
    try {
      await Promise.all(
        servers.map(
          (s) => new Promise<void>((resolve) => s.once("listening", resolve)),
        ),
      );
      const urls = servers.map(
        (s) => `http://127.0.0.1:${(s.address() as AddressInfo).port}/ping`,
      );

      // Alternate requests between the two instances; the combined total must
      // respect one shared budget.
      const statuses: number[] = [];
      for (let i = 0; i < max + 2; i++) {
        const res = await fetch(urls[i % 2]);
        statuses.push(res.status);
      }
      expect(statuses.slice(0, max)).toEqual(Array(max).fill(200));
      expect(statuses.slice(max)).toEqual([429, 429]);
    } finally {
      await Promise.all(
        servers.map(
          (s) => new Promise<void>((resolve) => s.close(() => resolve())),
        ),
      );
    }
  });
});
