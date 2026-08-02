/**
 * End-to-end webhook delivery test: dispatchWebhookEvent → DB delivery row →
 * attemptDelivery → real HTTP POST → local receiver verifies the signature.
 *
 * The SSRF guard blocks localhost by design, so two test seams are used:
 *  - node:dns/promises `lookup` is mocked to resolve the (fake) public
 *    hostname to a public IP, satisfying assertPublicDestination.
 *  - global fetch is wrapped to rewrite the public hostname to the local
 *    receiver's 127.0.0.1 address; everything else (method, headers, body,
 *    the actual HTTP round-trip) is real.
 */
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import {
  db,
  webhookDeliveriesTable,
  webhookEndpointsTable,
} from "@workspace/db";
import { organizationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
}));

import {
  attemptDelivery,
  createEndpoint,
  dispatchWebhookEvent,
  processPendingDeliveries,
  verifySignatureHeader,
} from "./webhooks";

const HOOK_URL = "http://webhook-receiver.example.com/hook";

type Received = {
  body: string;
  headers: Record<string, string | string[] | undefined>;
};

let server: Server;
let port: number;
let org: { id: string };
const received: Received[] = [];
// Status codes the receiver returns, shifted per request; defaults to 200.
const responseQueue: number[] = [];

const realFetch = globalThis.fetch;

beforeAll(async () => {
  process.env.SESSION_SECRET ??= "test-session-secret";

  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({
        body: Buffer.concat(chunks).toString("utf8"),
        headers: req.headers,
      });
      res.statusCode = responseQueue.shift() ?? 200;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;

  // Route requests for the fake public hostname to the local receiver.
  vi.stubGlobal("fetch", ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "webhook-receiver.example.com") {
      return realFetch(
        `http://127.0.0.1:${port}${url.pathname}${url.search}`,
        init,
      );
    }
    return realFetch(input, init);
  }) as typeof fetch);

  const slug = `test-webhook-e2e-${Date.now()}`;
  const [row] = await db
    .insert(organizationsTable)
    .values({ name: "Webhook E2E Org", slug })
    .returning();
  org = row;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteTestOrgs(org.id);
});

async function getDelivery(endpointId: string) {
  const rows = await db
    .select()
    .from(webhookDeliveriesTable)
    .where(eq(webhookDeliveriesTable.endpointId, endpointId));
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function waitFor<T>(
  fn: () => Promise<T | null | undefined>,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}

function sigHeader(r: Received): string {
  return String(r.headers["x-painless-signature"]);
}

function parseTimestamp(header: string): number {
  return Number(new Map(header.split(",").map((p) => p.split("=", 2) as [string, string])).get("t"));
}

// Purge all endpoints (and their deliveries via FK) before each test so
// endpoints from a previous test don't match the next dispatch event.
beforeEach(async () => {
  received.length = 0;
  responseQueue.length = 0;
  const endpoints = await db
    .select({ id: webhookEndpointsTable.id })
    .from(webhookEndpointsTable)
    .where(eq(webhookEndpointsTable.organizationId, org.id));
  for (const ep of endpoints) {
    await db
      .delete(webhookDeliveriesTable)
      .where(eq(webhookDeliveriesTable.endpointId, ep.id));
  }
  await db
    .delete(webhookEndpointsTable)
    .where(eq(webhookEndpointsTable.organizationId, org.id));
});

describe("end-to-end signed webhook delivery", () => {
  it("delivers a POST whose body verifies against the endpoint's plaintext secret", async () => {
    const endpoint = await createEndpoint(org.id, {
      url: HOOK_URL,
      events: [], // wildcard: receives every event type
    });
    const secret = endpoint.secret;

    const queued = await dispatchWebhookEvent(org.id, "lead.created", {
      leadId: "lead-123",
      name: "E2E Tester",
    });
    expect(queued).toBe(1);

    // dispatch fires attemptDelivery async; wait for the request to land.
    const delivery = await waitFor(async () => {
      const d = await getDelivery(endpoint.id);
      return d.status === "success" ? d : null;
    });

    expect(received).toHaveLength(1);
    const req = received[0];

    // The receiver verifies the exact bytes it received with the reference
    // verifier and the plaintext secret — the whole point of the test.
    const header = sigHeader(req);
    expect(verifySignatureHeader(secret, req.body, header)).toBe(true);
    // Tampered body must not verify.
    expect(verifySignatureHeader(secret, req.body + " ", header)).toBe(false);

    // Envelope + headers are intact.
    const parsed = JSON.parse(req.body);
    expect(parsed.event).toBe("lead.created");
    expect(parsed.data).toEqual({ leadId: "lead-123", name: "E2E Tester" });
    expect(req.headers["x-painless-event"]).toBe("lead.created");
    expect(req.headers["x-painless-delivery-id"]).toBe(delivery.id);
    expect(req.headers["x-painless-signature-version"]).toBe("v1");
    expect(req.headers["content-type"]).toBe("application/json");

    // Delivery row persisted with signatureVersion "v1" and the sent signature.
    expect(delivery.signatureVersion).toBe("v1");
    expect(delivery.signature).toBe(header);
    expect(delivery.responseStatus).toBe(200);
  });

  it("re-signs retries with a fresh timestamp that still verifies", async () => {
    responseQueue.push(500); // first attempt fails, forcing a retry

    const endpoint = await createEndpoint(org.id, {
      url: HOOK_URL,
      events: ["lead.updated"],
    });
    const secret = endpoint.secret;

    await dispatchWebhookEvent(org.id, "lead.updated", { leadId: "lead-456" });

    // Wait for the failed first attempt to be recorded.
    const afterFirst = await waitFor(async () => {
      const d = await getDelivery(endpoint.id);
      return d.attempts === 1 && d.status === "pending" ? d : null;
    });
    expect(afterFirst.lastError).toBe("HTTP 500");
    const firstHeader = sigHeader(received[0]);

    // Ensure the retry lands in a later second so the timestamp must differ.
    await new Promise((r) => setTimeout(r, 1100));
    await attemptDelivery(afterFirst.id);

    const afterRetry = await getDelivery(endpoint.id);
    expect(afterRetry.status).toBe("success");
    expect(afterRetry.attempts).toBe(2);
    expect(afterRetry.signatureVersion).toBe("v1");

    expect(received).toHaveLength(2);
    const retryReq = received[1];
    const retryHeader = sigHeader(retryReq);

    // Fresh timestamp on the retry, and the re-signed body still verifies —
    // including against any re-serialization drift from the DB round-trip.
    expect(parseTimestamp(retryHeader)).toBeGreaterThan(parseTimestamp(firstHeader));
    expect(retryHeader).not.toBe(firstHeader);
    expect(verifySignatureHeader(secret, retryReq.body, retryHeader)).toBe(true);
    expect(afterRetry.signature).toBe(retryHeader);
  });
});

describe("retry scheduler (processPendingDeliveries)", () => {
  /** Seed a delivery row directly, as if a prior attempt left it behind. */
  async function seedDelivery(
    endpointId: string,
    overrides: Partial<typeof webhookDeliveriesTable.$inferInsert> = {},
  ) {
    const payload = {
      event: "lead.created",
      timestamp: new Date().toISOString(),
      data: { leadId: "lead-sched" },
    };
    const [row] = await db
      .insert(webhookDeliveriesTable)
      .values({
        organizationId: org.id,
        endpointId,
        event: "lead.created",
        payload,
        signature: "t=0,v1=stale",
        signatureVersion: "v1",
        status: "pending",
        attempts: 1,
        lastError: "HTTP 500",
        nextAttemptAt: new Date(Date.now() - 60_000),
        ...overrides,
      })
      .returning();
    return row;
  }

  it("re-attempts a due pending delivery: receiver gets the request and the row succeeds", async () => {
    const endpoint = await createEndpoint(org.id, { url: HOOK_URL, events: [] });
    const seeded = await seedDelivery(endpoint.id);

    const processed = await processPendingDeliveries();
    expect(processed).toBe(1);

    // The receiver actually got the retried request, freshly signed.
    expect(received).toHaveLength(1);
    const req = received[0];
    expect(req.headers["x-painless-delivery-id"]).toBe(seeded.id);
    expect(verifySignatureHeader(endpoint.secret, req.body, sigHeader(req))).toBe(true);

    const after = await getDelivery(endpoint.id);
    expect(after.status).toBe("success");
    expect(after.attempts).toBe(2);
    expect(after.nextAttemptAt).toBeNull();
    expect(after.deliveredAt).not.toBeNull();
  });

  it("leaves a not-yet-due delivery untouched", async () => {
    const endpoint = await createEndpoint(org.id, { url: HOOK_URL, events: [] });
    const seeded = await seedDelivery(endpoint.id, {
      nextAttemptAt: new Date(Date.now() + 60_000),
    });

    const processed = await processPendingDeliveries();
    expect(processed).toBe(0);
    expect(received).toHaveLength(0);

    const after = await getDelivery(endpoint.id);
    expect(after.status).toBe("pending");
    expect(after.attempts).toBe(1);
    expect(after.signature).toBe(seeded.signature); // never re-signed
    expect(after.nextAttemptAt?.getTime()).toBe(seeded.nextAttemptAt?.getTime());
  });

  it("marks a delivery failed at MAX_ATTEMPTS and never picks it up again", async () => {
    responseQueue.push(500); // the final attempt also fails
    const endpoint = await createEndpoint(org.id, { url: HOOK_URL, events: [] });
    // attempts=2: the scheduler's attempt is #3 (MAX_ATTEMPTS), exhausting retries.
    await seedDelivery(endpoint.id, { attempts: 2 });

    const processed = await processPendingDeliveries();
    expect(processed).toBe(1);
    expect(received).toHaveLength(1);

    const after = await getDelivery(endpoint.id);
    expect(after.status).toBe("failed");
    expect(after.attempts).toBe(3);
    expect(after.nextAttemptAt).toBeNull();
    expect(after.lastError).toBe("HTTP 500");

    // A subsequent scheduler tick ignores the failed row entirely.
    const again = await processPendingDeliveries();
    expect(again).toBe(0);
    expect(received).toHaveLength(1);
  });
});
