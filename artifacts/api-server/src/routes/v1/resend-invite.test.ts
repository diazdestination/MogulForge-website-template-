import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import {
  auditEventsTable,
  db,
  organizationsTable,
  rateLimitCountersTable,
  usersTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

import app from "../../app";
import { createSession } from "../../lib/auth";
import { providers } from "../../services/providers";

/**
 * POST /v1/users/:id/resend-invite must only work for pending invites
 * (users with an `invite:` id) within the caller's own org, and must stay
 * behind the users.manage permission:
 *  - 400 for already-active (non-invite) members
 *  - 404 for members of other organizations (no cross-org existence leak)
 *  - 403 for callers without users.manage (e.g. sales_rep)
 *  - success records a `user.invite_resent` audit event
 */

let server: Server;
let baseUrl: string;

let org: { id: string };
let orgBId: string;
let admin: { id: string };
let adminSid: string;
let repSid: string;

let pendingInvite: { id: string; email: string | null };
let activeMember: { id: string };
let foreignInvite: { id: string };

async function sessionFor(user: { id: string }) {
  return createSession({
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
}

async function resend(userId: string, sid: string) {
  return fetch(`${baseUrl}/v1/users/${encodeURIComponent(userId)}/resend-invite`, {
    method: "POST",
    headers: { authorization: `Bearer ${sid}` },
  });
}

beforeAll(async () => {
  const stamp = Date.now();
  const [orgRow] = await db
    .insert(organizationsTable)
    .values({ name: "Resend Invite Org", slug: `resend-invite-${stamp}` })
    .returning();
  org = orgRow;

  const [adminRow] = await db
    .insert(usersTable)
    .values({
      email: `resend-admin-${stamp}@example.com`,
      firstName: "Ava",
      lastName: "Admin",
      organizationId: org.id,
      role: "admin",
    })
    .returning();
  admin = adminRow;

  const [rep] = await db
    .insert(usersTable)
    .values({
      email: `resend-rep-${stamp}@example.com`,
      organizationId: org.id,
      role: "sales_rep",
    })
    .returning();

  const [invite] = await db
    .insert(usersTable)
    .values({
      id: `invite:${crypto.randomUUID()}`,
      email: `resend-invitee-${stamp}@example.com`,
      firstName: "Nia",
      organizationId: org.id,
      role: "sales_rep",
    })
    .returning();
  pendingInvite = invite;

  const [active] = await db
    .insert(usersTable)
    .values({
      email: `resend-active-${stamp}@example.com`,
      organizationId: org.id,
      role: "office",
    })
    .returning();
  activeMember = active;

  // A pending invite in a different org: must 404, not 400, for org A's admin.
  const [orgB] = await db
    .insert(organizationsTable)
    .values({ name: "Resend Invite Org B", slug: `resend-invite-b-${stamp}` })
    .returning();
  orgBId = orgB.id;
  const [foreign] = await db
    .insert(usersTable)
    .values({
      id: `invite:${crypto.randomUUID()}`,
      email: `resend-foreign-${stamp}@example.com`,
      organizationId: orgB.id,
      role: "sales_rep",
    })
    .returning();
  foreignInvite = foreign;

  adminSid = await sessionFor(admin);
  repSid = await sessionFor(rep);

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteTestOrgs(org.id, orgBId);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /v1/users/:id/resend-invite", () => {
  it("returns 400 for an already-active (non-invite) member", async () => {
    const send = vi.spyOn(providers.email, "send");
    const res = await resend(activeMember.id, adminSid);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not a pending invite/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("returns 404 for a pending invite from another organization", async () => {
    const send = vi.spyOn(providers.email, "send");
    const res = await resend(foreignInvite.id, adminSid);
    expect(res.status).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });

  it("returns 403 for a caller without users.manage", async () => {
    const send = vi.spyOn(providers.email, "send");
    const res = await resend(pendingInvite.id, repSid);
    expect(res.status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it("resends to a pending invite and records a user.invite_resent audit event", async () => {
    const send = vi
      .spyOn(providers.email, "send")
      .mockResolvedValue({ id: "x", provider: "mock-email" });

    const res = await resend(pendingInvite.id, adminSid);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sent: boolean; error: string | null };
    expect(body).toEqual({ sent: true, error: null });

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toBe(pendingInvite.email);

    const events = await db
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.organizationId, org.id),
          eq(auditEventsTable.action, "user.invite_resent"),
          sql`${auditEventsTable.metadata} ->> 'invitedUserId' = ${pendingInvite.id}`,
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0].actorUserId).toBe(admin.id);
    expect(events[0].entityType).toBe("user");
    expect((events[0].metadata as Record<string, unknown>).inviteEmailSent).toBe(true);
    expect((events[0].metadata as Record<string, unknown>).email).toBe(pendingInvite.email);
  });

  it("rejects a rapid repeat resend with 429 and allows again after the cooldown", async () => {
    // Fresh invite so this test owns its cooldown window.
    const [invite] = await db
      .insert(usersTable)
      .values({
        id: `invite:${crypto.randomUUID()}`,
        email: `resend-cooldown-${Date.now()}@example.com`,
        organizationId: org.id,
        role: "sales_rep",
      })
      .returning();

    const send = vi
      .spyOn(providers.email, "send")
      .mockResolvedValue({ id: "x", provider: "mock-email" });

    const first = await resend(invite.id, adminSid);
    expect(first.status).toBe(200);

    const second = await resend(invite.id, adminSid);
    expect(second.status).toBe(429);
    expect(Number(second.headers.get("retry-after"))).toBeGreaterThan(0);
    const body = (await second.json()) as { error: string };
    expect(body.error).toMatch(/wait/i);
    // Only the first request actually emailed the invitee.
    expect(send).toHaveBeenCalledOnce();

    // No audit event for the throttled attempt.
    const events = await db
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.organizationId, org.id),
          eq(auditEventsTable.action, "user.invite_resent"),
          sql`${auditEventsTable.metadata} ->> 'invitedUserId' = ${invite.id}`,
        ),
      );
    expect(events).toHaveLength(1);

    // Expire the shared cooldown window, then the resend goes through again.
    await db
      .update(rateLimitCountersTable)
      .set({ resetAt: new Date(Date.now() - 1000) })
      .where(sql`${rateLimitCountersTable.key} like ${`invite-resend:${org.id}:${invite.id}%`}`);

    const third = await resend(invite.id, adminSid);
    expect(third.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
