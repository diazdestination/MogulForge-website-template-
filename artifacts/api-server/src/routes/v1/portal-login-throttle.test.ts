import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  contactsTable,
  db,
  organizationsTable,
  portalLoginCodesTable,
  rateLimitCountersTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import app from "../../app";
import { providers } from "../../services/providers";

/**
 * Route-level regression test for POST /v1/portal/login/request throttling.
 *
 * The service silently absorbs repeated code requests (returns the same
 * neutral { ok: true, channel } once the per-identifier budget is spent) so
 * that attackers cannot detect throttling. This test ensures the HTTP route
 * keeps surfacing that as 202 { sent: true, channel } — not a 429 or any
 * other shape — no matter how many times the same identifier is submitted.
 */

vi.mock("../../services/org", () => ({
  getDefaultOrganization: vi.fn(),
}));

// eslint-disable-next-line import/first
import { getDefaultOrganization } from "../../services/org";

let server: Server;
let baseUrl: string;
let org: { id: string };

const IDENTIFIER = `portal-throttle-route-${Date.now()}@example.com`;

beforeAll(async () => {
  const [o] = await db
    .insert(organizationsTable)
    .values({
      name: "Portal Throttle Route Org",
      slug: `portal-throttle-rt-${Date.now()}`,
    })
    .returning();
  org = o;

  // A matching contact so the first requests actually create codes and
  // hit the email provider — confirming the throttle is reached from a
  // real flow, not because the identifier is unrecognised.
  await db.insert(contactsTable).values({
    organizationId: org.id,
    firstName: "Throttled",
    email: IDENTIFIER,
  });

  vi.mocked(getDefaultOrganization).mockResolvedValue(org as any);

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Clean up login-code rows created during the test.
  await db
    .delete(portalLoginCodesTable)
    .where(eq(portalLoginCodesTable.identifier, IDENTIFIER));
  // Clean up the per-identifier service-level throttle counter.
  await db
    .delete(rateLimitCountersTable)
    .where(
      sql`${rateLimitCountersTable.key} like ${`portal-login-code:${org.id}:%`}`,
    );
});

describe("POST /v1/portal/login/request — throttle transparency", () => {
  it("returns 202 { sent: true } on every request, even after the per-identifier budget is exhausted", async () => {
    // Suppress actual email delivery — we care about the HTTP response shape,
    // not whether the provider call succeeds.
    const sendSpy = vi
      .spyOn(providers.email, "send")
      .mockResolvedValue({ id: "mock-email", provider: "mock-email" });

    try {
      // The service allows 3 code requests per identifier per 10-minute
      // window. Hit the endpoint 5 times: the first 3 go through (emails
      // sent), and requests 4 and 5 are silently throttled by the service —
      // but the route must keep returning the same 202 body regardless.
      const TOTAL = 5;
      for (let i = 1; i <= TOTAL; i++) {
        const res = await fetch(`${baseUrl}/v1/portal/login/request`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ identifier: IDENTIFIER }),
        });

        expect(res.status, `request ${i}: expected 202`).toBe(202);

        const body = await res.json();
        expect(body, `request ${i}: expected { sent: true, channel }`).toEqual(
          expect.objectContaining({ sent: true, channel: "email" }),
        );
      }

      // Confirm the throttle actually fired: only 3 emails were dispatched
      // despite 5 identical requests.
      expect(sendSpy).toHaveBeenCalledTimes(3);
    } finally {
      sendSpy.mockRestore();
    }
  });
});
