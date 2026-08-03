import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import {
  captureDeliveriesTable,
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

import app from "../../app";
import { createSession } from "../../lib/auth";
import { applyMapping } from "../../services/capture";

/**
 * External lead capture: tokenized inbound endpoints must map fields
 * correctly, dedupe duplicate deliveries via idempotency keys, accept both
 * JSON and form-encoded posts, and stay org-scoped end-to-end.
 */

let server: Server;
let baseUrl: string;
let org: { id: string };
let otherOrg: { id: string };
let sid: string;

beforeAll(async () => {
  const [o] = await db
    .insert(organizationsTable)
    .values({ name: "Capture Test Org", slug: `capture-test-${Date.now()}` })
    .returning();
  org = o;
  const [o2] = await db
    .insert(organizationsTable)
    .values({ name: "Capture Other Org", slug: `capture-other-${Date.now()}` })
    .returning();
  otherOrg = o2;
  const [u] = await db
    .insert(usersTable)
    .values({
      email: `capture-test-${Date.now()}@example.com`,
      organizationId: org.id,
      role: "admin",
    })
    .returning();
  sid = await createSession({
    user: { id: u.id, email: null, firstName: null, lastName: null, profileImageUrl: null },
    access_token: "test-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server?.close();
  await deleteTestOrgs(org?.id, otherOrg?.id);
});

function authed(path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${sid}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

describe("applyMapping", () => {
  it("maps external names to lead fields, splits fullName, lists unmapped", () => {
    const out = applyMapping(
      { "your-name": "fullName", "your-email": "email", comments: "message" },
      {
        "your-name": "Jane Q Homeowner",
        "your-email": "jane@example.com",
        comments: "leaky roof",
        extra_field: "ignored",
        _private: "skipped",
      },
    );
    expect(out.firstName).toBe("Jane");
    expect(out.lastName).toBe("Q Homeowner");
    expect(out.email).toBe("jane@example.com");
    expect(out.message).toBe("leaky roof");
    expect(out.unmapped).toEqual(["extra_field"]);
  });
});

describe("capture endpoints", () => {
  let token: string;
  let endpointId: string;

  it("admin creates an endpoint with a mapping and gets share assets", async () => {
    const res = await authed("/api/v1/capture-endpoints", {
      method: "POST",
      body: JSON.stringify({
        name: "Old site contact form",
        mapping: { "your-email": "email", "your-name": "fullName", tel: "phone", msg: "message" },
        defaultSource: "oldsite-form",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.token).toMatch(/^cap_/);
    expect(body.url).toContain(`/api/v1/public/capture/${body.token}`);
    expect(body.embedSnippet).toContain("public/capture.js");
    token = body.token;
    endpointId = body.id;
  });

  it("rejects an invalid mapping target", async () => {
    const res = await authed("/api/v1/capture-endpoints", {
      method: "POST",
      body: JSON.stringify({ name: "bad", mapping: { x: "notAField" } }),
    });
    expect(res.status).toBe(400);
  });

  it("preview applies the mapping without writing anything", async () => {
    const res = await authed("/api/v1/capture-endpoints/preview", {
      method: "POST",
      body: JSON.stringify({
        mapping: { "your-email": "email" },
        payload: { "your-email": "p@example.com", stray: "1" },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.email).toBe("p@example.com");
    expect(body.unmapped).toEqual(["stray"]);
  });

  it("captures a JSON payload into a new lead in the right org", async () => {
    const res = await fetch(`${baseUrl}/api/v1/public/capture/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-idempotency-key": "evt-1" },
      body: JSON.stringify({
        "your-email": "capture-lead@example.com",
        "your-name": "Cap Ture",
        msg: "need a roof",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.outcome).toBe("created");

    const [lead] = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.id, body.leadId));
    expect(lead.organizationId).toBe(org.id);
    expect(lead.source).toBe("oldsite-form");
    expect(lead.creationMethod).toBe("capture");
    const [contact] = await db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.id, lead.contactId));
    expect(contact.email).toBe("capture-lead@example.com");
    expect(contact.firstName).toBe("Cap");
  });

  it("replays duplicate deliveries with the same idempotency key", async () => {
    const first = await fetch(`${baseUrl}/api/v1/public/capture/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-idempotency-key": "evt-dup" },
      body: JSON.stringify({ "your-email": "dup@example.com" }),
    });
    expect(first.status).toBe(201);
    const a = await first.json() as any;

    const second = await fetch(`${baseUrl}/api/v1/public/capture/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-idempotency-key": "evt-dup" },
      body: JSON.stringify({ "your-email": "dup@example.com" }),
    });
    expect(second.status).toBe(200);
    const b = await second.json() as any;
    expect(b.duplicate).toBe(true);
    expect(b.leadId).toBe(a.leadId);

    const leads = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.organizationId, org.id));
    const dupLeads = [] as string[];
    for (const l of leads) {
      const [c] = await db.select().from(contactsTable).where(eq(contactsTable.id, l.contactId));
      if (c?.email === "dup@example.com") dupLeads.push(l.id);
    }
    expect(dupLeads).toHaveLength(1);
  });

  it("accepts form-encoded posts (a form's action pointed at us)", async () => {
    const params = new URLSearchParams({
      "your-email": "form-encoded@example.com",
      "your-name": "Formy McPost",
      _idempotencyKey: "form-evt-1",
    });
    const res = await fetch(`${baseUrl}/api/v1/public/capture/${token}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
  });

  it("rejects payloads with no mapped email or phone, and records the delivery", async () => {
    const res = await fetch(`${baseUrl}/api/v1/public/capture/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unrelated: "nothing useful" }),
    });
    expect(res.status).toBe(422);
    const deliveries = await db
      .select()
      .from(captureDeliveriesTable)
      .where(eq(captureDeliveriesTable.organizationId, org.id));
    expect(deliveries.some((d) => d.outcome === "rejected")).toBe(true);
  });

  it("404s on unknown tokens and on deactivated endpoints", async () => {
    const unknown = await fetch(`${baseUrl}/api/v1/public/capture/cap_nope`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "your-email": "x@example.com" }),
    });
    expect(unknown.status).toBe(404);

    const off = await authed(`/api/v1/capture-endpoints/${endpointId}`, {
      method: "PATCH",
      body: JSON.stringify({ isActive: false }),
    });
    expect(off.status).toBe(200);
    const res = await fetch(`${baseUrl}/api/v1/public/capture/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "your-email": "x@example.com" }),
    });
    expect(res.status).toBe(404);
    // reactivate for any later assertions
    await authed(`/api/v1/capture-endpoints/${endpointId}`, {
      method: "PATCH",
      body: JSON.stringify({ isActive: true }),
    });
  });

  it("keeps endpoints org-scoped: another org sees nothing", async () => {
    const [u2] = await db
      .insert(usersTable)
      .values({
        email: `capture-other-${Date.now()}@example.com`,
        organizationId: otherOrg.id,
        role: "admin",
      })
      .returning();
    const sid2 = await createSession({
      user: { id: u2.id, email: null, firstName: null, lastName: null, profileImageUrl: null },
      access_token: "test-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    const res = await fetch(`${baseUrl}/api/v1/capture-endpoints`, {
      headers: { authorization: `Bearer ${sid2}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);

    // Nor can it modify our endpoint.
    const patch = await fetch(`${baseUrl}/api/v1/capture-endpoints/${endpointId}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${sid2}`, "content-type": "application/json" },
      body: JSON.stringify({ isActive: false }),
    });
    expect(patch.status).toBe(404);
  });
});

describe("lead API idempotency", () => {
  it("replays POST /leads with the same x-idempotency-key instead of duplicating", async () => {
    const [contact] = await db
      .insert(contactsTable)
      .values({ organizationId: org.id, firstName: "Idem", email: "idem@example.com" })
      .returning();
    const body = JSON.stringify({ contactId: contact.id, source: "api-test" });
    const first = await authed("/api/v1/leads", {
      method: "POST",
      headers: { "x-idempotency-key": "lead-key-1" },
      body,
    });
    expect(first.status).toBe(201);
    const a = await first.json() as any;

    const second = await authed("/api/v1/leads", {
      method: "POST",
      headers: { "x-idempotency-key": "lead-key-1" },
      body,
    });
    expect(second.status).toBe(201);
    expect(second.headers.get("x-idempotent-replay")).toBe("true");
    const b = await second.json() as any;
    expect(b.id).toBe(a.id);

    const leads = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.contactId, contact.id));
    expect(leads).toHaveLength(1);
  });
});

describe("lead-lifecycle outbound webhooks", () => {
  it("queues webhook deliveries for lead.created and lead.won", async () => {
    const { webhookEndpointsTable, webhookDeliveriesTable } = await import("@workspace/db");
    const { runEvent } = await import("../../services/automation");
    const [endpoint] = await db
      .insert(webhookEndpointsTable)
      .values({
        organizationId: org.id,
        url: "https://example.com/hook",
        secret: "whsec_test",
        events: [], // empty = all events
        isActive: true,
      })
      .returning();

    const [contact] = await db
      .insert(contactsTable)
      .values({ organizationId: org.id, firstName: "Hook", email: "hook@example.com" })
      .returning();
    const [lead] = await db
      .insert(leadsTable)
      .values({ organizationId: org.id, contactId: contact.id })
      .returning();

    await runEvent(org.id, "lead.created", { leadId: lead.id, contactId: contact.id });
    await runEvent(org.id, "lead.updated", {
      leadId: lead.id,
      fields: { "lead.status": "won" },
    });
    // mirrorToWebhooks is fire-and-forget — give it a beat to enqueue.
    await new Promise((r) => setTimeout(r, 500));

    const deliveries = await db
      .select()
      .from(webhookDeliveriesTable)
      .where(eq(webhookDeliveriesTable.endpointId, endpoint.id));
    const events = deliveries.map((d) => d.event);
    expect(events).toContain("lead.created");
    expect(events).toContain("lead.won");
  });
});

describe("capture.js listener script", () => {
  it("serves the script with cache headers and non-interference guarantees", async () => {
    const res = await fetch(`${baseUrl}/api/v1/public/capture.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const js = await res.text();
    // The listener must never block or break the host form.
    expect(js).not.toContain("preventDefault");
    expect(js).not.toContain("stopPropagation");
    expect(js).toContain("sendBeacon");
    expect(js).toContain("keepalive");
    expect(js).toContain("data-capture-token");
  });
});
