import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import {
  auditEventsTable,
  db,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

import app from "../../app";
import { createSession } from "../../lib/auth";
import { createApiKey } from "../../services/api-keys";

/**
 * End-to-end authorization tests for API-key auth (`x-api-key`).
 *
 * Contract under test (see requireMember):
 *  - a valid key can read/write exactly what its stored role allows;
 *  - a viewer-role key is rejected from writes;
 *  - NO key — regardless of role — can reach settings.manage / users.manage
 *    routes (PUT /v1/settings, PATCH /v1/users/:id, all /v1/api-keys routes);
 *  - revoked and bogus keys get 401;
 *  - key create/revoke through the admin routes write audit events.
 */

let server: Server;
let baseUrl: string;
let org: { id: string };
let admin: { id: string };
let adminSid: string;

async function api(
  method: string,
  path: string,
  opts: { key?: string; session?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.key) headers["x-api-key"] = opts.key;
  if (opts.session) headers["authorization"] = `Bearer ${opts.session}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

beforeAll(async () => {
  const [o] = await db
    .insert(organizationsTable)
    .values({ name: "ApiKey Test Org", slug: `apikey-test-${Date.now()}` })
    .returning();
  org = o;
  const [u] = await db
    .insert(usersTable)
    .values({
      email: `apikey-admin-${Date.now()}@example.com`,
      organizationId: org.id,
      role: "admin",
    })
    .returning();
  admin = u;
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
  // Remove everything this file created (audit events, keys, users, org, …)
  // in FK-safe order; leftover expiring keys otherwise break the
  // expiry-reminder test's recipient assertions.
  await deleteTestOrgs(org.id);
});

async function auditEvents(action: string, entityId: string) {
  return db
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.organizationId, org.id),
        eq(auditEventsTable.action, action),
        eq(auditEventsTable.entityId, entityId),
      ),
    );
}

describe("API key lifecycle via admin session writes audit events", () => {
  it("create returns the secret once and records api_key.created", async () => {
    const res = await api("POST", "/v1/api-keys", {
      session: adminSid,
      body: { name: "Audit create", role: "office" },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; key: string };
    expect(created.key).toMatch(/^pk_/);

    const events = await auditEvents("api_key.created", created.id);
    expect(events).toHaveLength(1);
    expect(events[0].actorUserId).toBe(admin.id);
    expect(events[0].metadata).toMatchObject({ name: "Audit create", role: "office" });
  });

  it("revoke records api_key.revoked and the key stops working", async () => {
    const res = await api("POST", "/v1/api-keys", {
      session: adminSid,
      body: { name: "Audit revoke", role: "office" },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; key: string };

    // Key works before revocation.
    expect((await api("GET", "/v1/contacts", { key: created.key })).status).toBe(200);

    const del = await api("DELETE", `/v1/api-keys/${created.id}`, {
      session: adminSid,
    });
    expect(del.status).toBe(204);

    const events = await auditEvents("api_key.revoked", created.id);
    expect(events).toHaveLength(1);
    expect(events[0].actorUserId).toBe(admin.id);

    // Revoked key is rejected outright.
    expect((await api("GET", "/v1/contacts", { key: created.key })).status).toBe(401);
  });

  it("PATCH updates expiresAt with an audit event; past dates and revoked keys are rejected", async () => {
    const res = await api("POST", "/v1/api-keys", {
      session: adminSid,
      body: { name: "Audit expiry", role: "office" },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; key: string };

    // Extend: future date is accepted and reflected in the DTO.
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const patch = await api("PATCH", `/v1/api-keys/${created.id}`, {
      session: adminSid,
      body: { expiresAt: future },
    });
    expect(patch.status).toBe(200);
    const updated = (await patch.json()) as { expiresAt: string | null };
    expect(updated.expiresAt).toBe(future);

    const events = await auditEvents("api_key.expiry_updated", created.id);
    expect(events).toHaveLength(1);
    expect(events[0].actorUserId).toBe(admin.id);
    expect(events[0].metadata).toMatchObject({ expiresAt: future });

    // Clearing the expiry with null is allowed.
    const clear = await api("PATCH", `/v1/api-keys/${created.id}`, {
      session: adminSid,
      body: { expiresAt: null },
    });
    expect(clear.status).toBe(200);
    expect(((await clear.json()) as { expiresAt: string | null }).expiresAt).toBeNull();

    // Past dates are rejected.
    const past = await api("PATCH", `/v1/api-keys/${created.id}`, {
      session: adminSid,
      body: { expiresAt: new Date(Date.now() - 1000).toISOString() },
    });
    expect(past.status).toBe(400);

    // API keys themselves can never edit keys.
    const viaKey = await api("PATCH", `/v1/api-keys/${created.id}`, {
      key: created.key,
      body: { expiresAt: future },
    });
    expect(viaKey.status).toBe(403);

    // Revoked keys cannot be edited.
    await api("DELETE", `/v1/api-keys/${created.id}`, { session: adminSid });
    const revokedPatch = await api("PATCH", `/v1/api-keys/${created.id}`, {
      session: adminSid,
      body: { expiresAt: future },
    });
    expect(revokedPatch.status).toBe(404);
  });

  it("PATCH renames a key in place with an api_key.renamed audit event", async () => {
    const res = await api("POST", "/v1/api-keys", {
      session: adminSid,
      body: { name: "Old integration name", role: "office" },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; key: string };

    // Name-only update: rename works without touching expiry.
    const patch = await api("PATCH", `/v1/api-keys/${created.id}`, {
      session: adminSid,
      body: { name: "New integration name" },
    });
    expect(patch.status).toBe(200);
    const updated = (await patch.json()) as { name: string; expiresAt: string | null };
    expect(updated.name).toBe("New integration name");
    expect(updated.expiresAt).toBeNull();

    const events = await auditEvents("api_key.renamed", created.id);
    expect(events).toHaveLength(1);
    expect(events[0].actorUserId).toBe(admin.id);
    expect(events[0].metadata).toMatchObject({
      oldName: "Old integration name",
      newName: "New integration name",
    });

    // The key itself keeps working after the rename.
    expect((await api("GET", "/v1/contacts", { key: created.key })).status).toBe(200);

    // Blank names and empty updates are rejected.
    expect(
      (await api("PATCH", `/v1/api-keys/${created.id}`, { session: adminSid, body: { name: "  " } }))
        .status,
    ).toBe(400);
    expect(
      (await api("PATCH", `/v1/api-keys/${created.id}`, { session: adminSid, body: {} })).status,
    ).toBe(400);
  });

  it("refuses to mint owner or admin keys", async () => {
    for (const role of ["owner", "admin"]) {
      const res = await api("POST", "/v1/api-keys", {
        session: adminSid,
        body: { name: `Bad ${role}`, role },
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("API key access is capped at the key's role", () => {
  let officeKey: string;
  let viewerKey: string;

  beforeAll(async () => {
    officeKey = (
      await createApiKey({
        organizationId: org.id,
        name: "office key",
        role: "office",
        createdByUserId: admin.id,
      })
    ).key;
    viewerKey = (
      await createApiKey({
        organizationId: org.id,
        name: "viewer key",
        role: "viewer",
        createdByUserId: admin.id,
      })
    ).key;
  });

  it("office-role key can read and write CRM data in its org", async () => {
    const create = await api("POST", "/v1/contacts", {
      key: officeKey,
      body: { firstName: "Keyed", lastName: "Contact" },
    });
    expect(create.status).toBe(201);
    const contact = (await create.json()) as { id: string };

    const read = await api("GET", `/v1/contacts/${contact.id}`, { key: officeKey });
    expect(read.status).toBe(200);
  });

  it("viewer-role key can read but not write", async () => {
    expect((await api("GET", "/v1/contacts", { key: viewerKey })).status).toBe(200);
    const write = await api("POST", "/v1/contacts", {
      key: viewerKey,
      body: { firstName: "Nope" },
    });
    expect(write.status).toBe(403);
  });

  it("office-role key cannot delete (crm.delete outranks office)", async () => {
    const create = await api("POST", "/v1/contacts", {
      key: officeKey,
      body: { firstName: "Undeletable" },
    });
    const contact = (await create.json()) as { id: string };
    const del = await api("DELETE", `/v1/contacts/${contact.id}`, { key: officeKey });
    expect(del.status).toBe(403);
  });

  it("no key can touch settings, team management, or key management", async () => {
    for (const key of [officeKey, viewerKey]) {
      expect(
        (await api("PUT", "/v1/settings", { key, body: {} })).status,
      ).toBe(403);
      expect(
        (
          await api("PATCH", `/v1/users/${admin.id}`, {
            key,
            body: { role: "viewer" },
          })
        ).status,
      ).toBe(403);
      expect((await api("GET", "/v1/api-keys", { key })).status).toBe(403);
      expect(
        (
          await api("POST", "/v1/api-keys", {
            key,
            body: { name: "escalate", role: "office" },
          })
        ).status,
      ).toBe(403);
      expect(
        (await api("DELETE", "/v1/api-keys/00000000-0000-0000-0000-000000000000", { key }))
          .status,
      ).toBe(403);
    }
  });

  it("expired key gets 401 exactly like a revoked one", async () => {
    const { key } = await createApiKey({
      organizationId: org.id,
      name: "expired key",
      role: "office",
      createdByUserId: admin.id,
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect((await api("GET", "/v1/contacts", { key })).status).toBe(401);
  });

  it("a key with a future expiry still works until that date", async () => {
    const { key } = await createApiKey({
      organizationId: org.id,
      name: "future-expiry key",
      role: "office",
      createdByUserId: admin.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    expect((await api("GET", "/v1/contacts", { key })).status).toBe(200);
  });

  it("creating a key with a past expiry via the admin route is rejected", async () => {
    const res = await api("POST", "/v1/api-keys", {
      session: adminSid,
      body: {
        name: "already dead",
        role: "office",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    });
    expect(res.status).toBe(400);
  });

  it("creating a key with a future expiry returns expiresAt in the DTO", async () => {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const res = await api("POST", "/v1/api-keys", {
      session: adminSid,
      body: { name: "expiring", role: "office", expiresAt: expiresAt.toISOString() },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { expiresAt: string | null };
    expect(created.expiresAt).toBe(expiresAt.toISOString());
  });

  it("bogus key gets 401", async () => {
    expect(
      (await api("GET", "/v1/contacts", { key: "pk_definitely_not_real" })).status,
    ).toBe(401);
  });

  it("a key created by a deactivated admin stops working", async () => {
    const [tempAdmin] = await db
      .insert(usersTable)
      .values({
        email: `apikey-temp-${Date.now()}@example.com`,
        organizationId: org.id,
        role: "admin",
      })
      .returning();
    const { key } = await createApiKey({
      organizationId: org.id,
      name: "orphaned key",
      role: "office",
      createdByUserId: tempAdmin.id,
    });
    expect((await api("GET", "/v1/contacts", { key })).status).toBe(200);

    await db
      .update(usersTable)
      .set({ isActive: false })
      .where(eq(usersTable.id, tempAdmin.id));
    expect((await api("GET", "/v1/contacts", { key })).status).toBe(401);
  });
});
