/**
 * Proves the scheduler-tick cleanup deletes expired/consumed portal login
 * codes and expired portal sessions, while leaving live rows untouched.
 */
import { createHash } from "node:crypto";

import {
  db,
  organizationsTable,
  portalLoginCodesTable,
  portalSessionsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

process.env.SESSION_SECRET ??= "test-session-secret";

const { cleanupExpiredPortalCredentials } = await import("./portal");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

let org: { id: string };

beforeAll(async () => {
  const [row] = await db
    .insert(organizationsTable)
    .values({
      name: "Portal Cleanup Org",
      slug: `test-portal-cleanup-${Date.now()}`,
    })
    .returning();
  org = row;
});

afterAll(async () => {
  await deleteTestOrgs(org.id);
});

async function insertCode(opts: { expiresAt: Date; consumedAt?: Date }) {
  const [row] = await db
    .insert(portalLoginCodesTable)
    .values({
      organizationId: org.id,
      identifier: `cleanup-${Math.random().toString(36).slice(2)}@example.com`,
      channel: "email",
      codeHash: sha256(Math.random().toString()),
      expiresAt: opts.expiresAt,
      consumedAt: opts.consumedAt ?? null,
    })
    .returning();
  return row;
}

async function insertSession(expiresAt: Date) {
  const [row] = await db
    .insert(portalSessionsTable)
    .values({
      organizationId: org.id,
      tokenHash: sha256(Math.random().toString()),
      identifier: "cleanup@example.com",
      channel: "email",
      expiresAt,
    })
    .returning();
  return row;
}

async function codeExists(id: string): Promise<boolean> {
  const rows = await db
    .select({ id: portalLoginCodesTable.id })
    .from(portalLoginCodesTable)
    .where(eq(portalLoginCodesTable.id, id));
  return rows.length > 0;
}

async function sessionExists(id: string): Promise<boolean> {
  const rows = await db
    .select({ id: portalSessionsTable.id })
    .from(portalSessionsTable)
    .where(eq(portalSessionsTable.id, id));
  return rows.length > 0;
}

describe("cleanupExpiredPortalCredentials", () => {
  it("deletes expired and consumed login codes but keeps live ones", async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 10 * 60_000);

    const expired = await insertCode({ expiresAt: past });
    const consumed = await insertCode({
      expiresAt: future,
      consumedAt: new Date(),
    });
    const live = await insertCode({ expiresAt: future });

    await cleanupExpiredPortalCredentials();

    expect(await codeExists(expired.id)).toBe(false);
    expect(await codeExists(consumed.id)).toBe(false);
    expect(await codeExists(live.id)).toBe(true);
  });

  it("deletes expired sessions but keeps live ones", async () => {
    const expired = await insertSession(new Date(Date.now() - 60_000));
    const live = await insertSession(
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    );

    const result = await cleanupExpiredPortalCredentials();

    expect(result.sessions).toBeGreaterThanOrEqual(1);
    expect(await sessionExists(expired.id)).toBe(false);
    expect(await sessionExists(live.id)).toBe(true);
  });
});
