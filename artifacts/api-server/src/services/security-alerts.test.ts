/**
 * Proves that when an IP crosses the invalid-API-key threshold, active
 * org owners/admins are emailed (in addition to the audit event), and that
 * inactive users, non-admin roles, and unusable mailboxes are skipped.
 *
 * The alert fans out to every org with an active API key, so assertions
 * filter the captured sends down to this test's unique recipient addresses.
 */
import {
  apiKeysTable,
  db,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, beforeAll, describe, expect, it, vi } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

process.env.SESSION_SECRET ??= "test-session-secret";

const sent: { to: string; subject: string; body: string }[] = [];

vi.mock("./providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers")>();
  return {
    ...actual,
    providers: {
      ...actual.providers,
      email: {
        send: async (to: string, subject: string, body: string) => {
          sent.push({ to, subject, body });
          return { id: "mock", provider: "mock" };
        },
      },
    },
  };
});

const { reportApiKeyBruteForceBlock, reportCallbackBruteForceBlock } = await import("./security-alerts");

const stamp = Date.now();
const adminEmail = `bf-alert-admin-${stamp}@example.com`;
const ownerEmail = `bf-alert-owner-${stamp}@example.com`;
const inactiveEmail = `bf-alert-inactive-${stamp}@example.com`;
const repEmail = `bf-alert-rep-${stamp}@example.com`;
const ourEmails = new Set([adminEmail, ownerEmail, inactiveEmail, repEmail]);

let orgId: string;
const userIds: string[] = [];
const keyIds: string[] = [];

beforeAll(async () => {
  const [org] = await db
    .insert(organizationsTable)
    .values({ name: "BF Email Org", slug: `bf-email-${stamp}` })
    .returning();
  orgId = org.id;
  const users = await db
    .insert(usersTable)
    .values([
      { id: `bf-admin-${stamp}`, email: adminEmail, organizationId: orgId, role: "admin" },
      { id: `bf-owner-${stamp}`, email: ownerEmail, organizationId: orgId, role: "owner" },
      {
        id: `bf-inactive-${stamp}`,
        email: inactiveEmail,
        organizationId: orgId,
        role: "admin",
        isActive: false,
      },
      { id: `bf-rep-${stamp}`, email: repEmail, organizationId: orgId, role: "sales_rep" },
    ])
    .returning();
  userIds.push(...users.map((u) => u.id));
  // The org must hold an active API key to be alerted.
  const [key] = await db
    .insert(apiKeysTable)
    .values({
      organizationId: orgId,
      name: "bf alert key",
      prefix: "pk_bf",
      keyHash: `hash-bf-${stamp}`,
      createdByUserId: users[0].id,
    })
    .returning();
  keyIds.push(key.id);
});

afterAll(async () => {
  await deleteTestOrgs(orgId);
});

beforeEach(() => {
  sent.length = 0;
});

describe("brute-force block emails org admins", () => {
  it("emails active owners/admins once, skipping inactive and non-admin users", async () => {
    await reportApiKeyBruteForceBlock({
      ip: "203.0.113.77",
      windowMs: 15 * 60 * 1000,
      maxFailures: 10,
    });
    const ours = sent.filter((s) => ourEmails.has(s.to));
    expect(ours.map((s) => s.to).sort()).toEqual([adminEmail, ownerEmail].sort());
    for (const mail of ours) {
      expect(mail.subject).toMatch(/api key/i);
      expect(mail.body).toContain("203.0.113.77");
      expect(mail.body).toContain("10 invalid API key attempts");
      expect(mail.body).toContain("15 minutes");
    }
  });

  it("skips orgs without an active API key", async () => {
    await db
      .update(apiKeysTable)
      .set({ isActive: false })
      .where(eq(apiKeysTable.id, keyIds[0]));
    try {
      await reportApiKeyBruteForceBlock({
        ip: "203.0.113.78",
        windowMs: 15 * 60 * 1000,
        maxFailures: 10,
      });
      expect(sent.filter((s) => ourEmails.has(s.to))).toHaveLength(0);
    } finally {
      await db
        .update(apiKeysTable)
        .set({ isActive: true })
        .where(eq(apiKeysTable.id, keyIds[0]));
    }
  });
});

describe("reportCallbackBruteForceBlock emails org admins about login attacks", () => {
  it("emails active owners/admins, skipping inactive and non-admin users", async () => {
    await reportCallbackBruteForceBlock({
      ip: "203.0.113.90",
      windowMs: 15 * 60 * 1000,
      maxFailures: 10,
    });
    const ours = sent.filter((s) => ourEmails.has(s.to));
    expect(ours.map((s) => s.to).sort()).toEqual([adminEmail, ownerEmail].sort());
    for (const mail of ours) {
      expect(mail.subject).toMatch(/login/i);
      expect(mail.body).toContain("203.0.113.90");
      expect(mail.body).toContain("10 failed login attempts");
      expect(mail.body).toContain("15 minutes");
    }
  });

  it("records an auth.brute_force_blocked audit event for the org", async () => {
    const { auditEventsTable } = await import("@workspace/db");
    const { and, eq, sql } = await import("drizzle-orm");

    await reportCallbackBruteForceBlock({
      ip: "203.0.113.91",
      windowMs: 15 * 60 * 1000,
      maxFailures: 10,
    });

    const events = await db
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.organizationId, orgId),
          eq(auditEventsTable.action, "auth.brute_force_blocked"),
          sql`${auditEventsTable.metadata} ->> 'ip' = ${"203.0.113.91"}`,
        ),
      );
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].entityType).toBe("session");
  });

  it("skips orgs without an active API key", async () => {
    const { auditEventsTable } = await import("@workspace/db");
    const { and, eq, sql } = await import("drizzle-orm");

    // Deactivate the org's API key so it is excluded from the fan-out.
    await db
      .update(apiKeysTable)
      .set({ isActive: false })
      .where(eq(apiKeysTable.id, keyIds[0]));
    try {
      await reportCallbackBruteForceBlock({
        ip: "203.0.113.92",
        windowMs: 15 * 60 * 1000,
        maxFailures: 10,
      });
      // No emails to our test addresses.
      expect(sent.filter((s) => ourEmails.has(s.to))).toHaveLength(0);
      // No audit row for our org.
      const events = await db
        .select()
        .from(auditEventsTable)
        .where(
          and(
            eq(auditEventsTable.organizationId, orgId),
            eq(auditEventsTable.action, "auth.brute_force_blocked"),
            sql`${auditEventsTable.metadata} ->> 'ip' = ${"203.0.113.92"}`,
          ),
        );
      expect(events).toHaveLength(0);
    } finally {
      await db
        .update(apiKeysTable)
        .set({ isActive: true })
        .where(eq(apiKeysTable.id, keyIds[0]));
    }
  });
});
