/**
 * Proves the API-key expiry reminder emails org admins exactly once for keys
 * expiring within the window, and skips revoked/far-future/already-reminded
 * keys.
 */
import {
  apiKeysTable,
  db,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

process.env.SESSION_SECRET ??= "test-session-secret";

const sent: { to: string; subject: string }[] = [];
/** When true, every email send throws (simulates a provider outage). */
let failAllSends = false;

vi.mock("./providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers")>();
  return {
    ...actual,
    providers: {
      ...actual.providers,
      email: {
        send: async (to: string, subject: string) => {
          if (failAllSends) throw new Error("provider outage");
          sent.push({ to, subject });
          return { id: "mock", provider: "mock" };
        },
      },
    },
  };
});

const { processApiKeyExpiryReminders } = await import(
  "./api-key-expiry-reminder"
);

let org: { id: string };
// Unique per-run emails so assertions can be scoped to this org even when the
// DB holds leftover expiring keys from other test files (the reminder job
// scans every organization).
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const adminEmail = `kr-admin-${suffix}@example.com`;
const ownerEmail = `kr-owner-${suffix}@example.com`;
const repEmail = `kr-rep-${suffix}@example.com`;
const myEmails = new Set([adminEmail, ownerEmail, repEmail]);
/** Only emails sent to this test's own org users. */
const mine = () => sent.filter((s) => myEmails.has(s.to));
const userIds: string[] = [];
const keyIds: string[] = [];
const now = new Date();
const days = (n: number) => new Date(now.getTime() + n * 24 * 60 * 60 * 1000);

async function makeKey(overrides: Partial<typeof apiKeysTable.$inferInsert>) {
  const [row] = await db
    .insert(apiKeysTable)
    .values({
      organizationId: org.id,
      name: "Key",
      prefix: "pk_test",
      keyHash: `hash-${Math.random().toString(36).slice(2)}`,
      createdByUserId: userIds[0],
      ...overrides,
    })
    .returning();
  keyIds.push(row.id);
  return row;
}

beforeAll(async () => {
  const [row] = await db
    .insert(organizationsTable)
    .values({
      name: "Key Reminder Org",
      slug: `test-key-reminder-${Date.now()}`,
    })
    .returning();
  org = row;
  const users = await db
    .insert(usersTable)
    .values([
      {
        id: `test-kr-admin-${Date.now()}`,
        email: adminEmail,
        organizationId: org.id,
        role: "admin",
      },
      {
        id: `test-kr-owner-${Date.now()}`,
        email: ownerEmail,
        organizationId: org.id,
        role: "owner",
      },
      {
        id: `test-kr-rep-${Date.now()}`,
        email: repEmail,
        organizationId: org.id,
        role: "sales_rep",
      },
    ])
    .returning();
  userIds.push(...users.map((u) => u.id));
});

afterAll(async () => {
  await deleteTestOrgs(org.id);
});

beforeEach(() => {
  sent.length = 0;
  failAllSends = false;
});

describe("processApiKeyExpiryReminders", () => {
  it("emails all org admins once for a key expiring within the window", async () => {
    const key = await makeKey({ name: "Expiring", expiresAt: days(3) });

    const claimed = await processApiKeyExpiryReminders(7, now);
    expect(claimed.map((k) => k.id)).toContain(key.id);
    const own = mine();
    expect(own.map((s) => s.to).sort()).toEqual([adminEmail, ownerEmail]);
    expect(own[0].subject).toContain("Expiring");

    // Second run: reminder is not re-sent.
    sent.length = 0;
    const again = await processApiKeyExpiryReminders(7, now);
    expect(again.map((k) => k.id)).not.toContain(key.id);
    expect(mine()).toHaveLength(0);

    const [after] = await db
      .select()
      .from(apiKeysTable)
      .where(eq(apiKeysTable.id, key.id));
    expect(after.expiryReminderSentAt).not.toBeNull();
  });

  it("skips keys outside the window, already expired, revoked, or already reminded", async () => {
    const farFuture = await makeKey({ name: "Far", expiresAt: days(30) });
    const expired = await makeKey({ name: "Gone", expiresAt: days(-1) });
    const revoked = await makeKey({
      name: "Revoked",
      expiresAt: days(2),
      isActive: false,
      revokedAt: now,
    });
    const reminded = await makeKey({
      name: "Reminded",
      expiresAt: days(2),
      expiryReminderSentAt: now,
    });
    const noExpiry = await makeKey({ name: "NoExpiry", expiresAt: null });

    const claimed = await processApiKeyExpiryReminders(7, now);
    const claimedIds = claimed.map((k) => k.id);
    for (const k of [farFuture, expired, revoked, reminded, noExpiry]) {
      expect(claimedIds).not.toContain(k.id);
    }
    expect(mine()).toHaveLength(0);
  });

  it("releases the claim when no email is delivered, then retries and sends once", async () => {
    const key = await makeKey({ name: "Outage", expiresAt: days(3) });

    // Every send fails: the key is claimed but the claim must be released.
    failAllSends = true;
    const claimed = await processApiKeyExpiryReminders(7, now);
    expect(claimed.map((k) => k.id)).toContain(key.id);
    expect(mine()).toHaveLength(0);

    const [afterFail] = await db
      .select()
      .from(apiKeysTable)
      .where(eq(apiKeysTable.id, key.id));
    expect(afterFail.expiryReminderSentAt).toBeNull();

    // Provider recovers: a later tick retries and the warning goes out.
    failAllSends = false;
    const retryNow = new Date(now.getTime() + 60 * 1000);
    const retried = await processApiKeyExpiryReminders(7, retryNow);
    expect(retried.map((k) => k.id)).toContain(key.id);
    expect(mine().map((s) => s.to).sort()).toEqual([adminEmail, ownerEmail]);

    // Still at most one successful reminder for this expiry.
    sent.length = 0;
    const again = await processApiKeyExpiryReminders(7, retryNow);
    expect(again.map((k) => k.id)).not.toContain(key.id);
    expect(mine()).toHaveLength(0);
  });

  it("sends a fresh reminder after an admin changes the key's expiry", async () => {
    const { updateApiKey } = await import("./api-keys");
    const key = await makeKey({ name: "Extended", expiresAt: days(3) });

    // First reminder for the original expiry.
    await processApiKeyExpiryReminders(7, now);
    sent.length = 0;

    // Admin extends the key; the sent marker is cleared.
    const updated = await updateApiKey(org.id, key.id, { expiresAt: days(60) });
    expect(updated?.after.expiryReminderSentAt).toBeNull();

    // Outside the window: no reminder yet.
    const early = await processApiKeyExpiryReminders(7, now);
    expect(early.map((k) => k.id)).not.toContain(key.id);
    expect(sent).toHaveLength(0);

    // As the new expiry approaches, exactly one fresh reminder goes out.
    const later = days(55);
    const claimed = await processApiKeyExpiryReminders(7, later);
    expect(claimed.map((k) => k.id)).toContain(key.id);
    expect(sent.length).toBeGreaterThan(0);

    sent.length = 0;
    const again = await processApiKeyExpiryReminders(7, later);
    expect(again.map((k) => k.id)).not.toContain(key.id);
    expect(sent).toHaveLength(0);
  });
});
