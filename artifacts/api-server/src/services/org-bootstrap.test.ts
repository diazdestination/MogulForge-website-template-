import { db, organizationsTable, usersTable } from "@workspace/db";
import { count, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";
import { ensureMembership } from "./org";

/**
 * Bootstrap branch of ensureMembership: the very first sign-in on an empty
 * platform becomes owner + platform admin; subsequent users stay org-less.
 *
 * The shared dev/CI database always has members in the default org, so the
 * bootstrap branch can never fire there. These tests use the _testOrgOverride
 * seam to inject a fresh, empty org so the logic is fully exercised in isolation.
 */

const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];

async function makeEmptyOrg() {
  const slug = `bootstrap-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const [org] = await db
    .insert(organizationsTable)
    .values({ name: "Bootstrap Test Org", slug })
    .returning();
  createdOrgIds.push(org.id);
  return org;
}

async function makeUser(overrides: Partial<typeof usersTable.$inferInsert> = {}) {
  const [u] = await db
    .insert(usersTable)
    .values({
      email: `bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
      ...overrides,
    })
    .returning();
  createdUserIds.push(u.id);
  return u;
}

afterAll(async () => {
  await deleteTestOrgs(...createdOrgIds);
  for (const id of createdUserIds) {
    await db.delete(usersTable).where(eq(usersTable.id, id)).catch(() => {});
  }
});

describe("bootstrap branch: first sign-in on an empty platform", () => {
  it("promotes the first user to owner + isPlatformAdmin", async () => {
    const emptyOrg = await makeEmptyOrg();
    const firstUser = await makeUser();

    const result = await ensureMembership(firstUser.id, { id: emptyOrg.id });

    expect(result?.organizationId).toBe(emptyOrg.id);
    expect(result?.role).toBe("owner");
    expect(result?.isPlatformAdmin).toBe(true);
  });

  it("leaves the second user org-less once the org already has a member", async () => {
    const emptyOrg = await makeEmptyOrg();
    const firstUser = await makeUser();
    const secondUser = await makeUser();

    // First sign-in fills the org.
    await ensureMembership(firstUser.id, { id: emptyOrg.id });

    // Second sign-in must not get attached — the org is no longer empty.
    const result = await ensureMembership(secondUser.id, { id: emptyOrg.id });

    // Not attached to the org, not promoted.
    expect(result?.organizationId).toBeNull();
    expect(result?.role).not.toBe("owner");
    expect(result?.isPlatformAdmin).toBe(false);
  });

  it("is idempotent: calling again for the owner returns them unchanged", async () => {
    const emptyOrg = await makeEmptyOrg();
    const firstUser = await makeUser();

    const first = await ensureMembership(firstUser.id, { id: emptyOrg.id });
    const second = await ensureMembership(firstUser.id, { id: emptyOrg.id });

    // User already has an organizationId, so the function returns early.
    expect(second?.organizationId).toBe(emptyOrg.id);
    expect(second?.role).toBe(first?.role);
    expect(second?.isPlatformAdmin).toBe(first?.isPlatformAdmin);
  });
});

describe("concurrent first sign-in race", () => {
  it("exactly one of two simultaneous sign-ins becomes owner; the other stays org-less", async () => {
    const emptyOrg = await makeEmptyOrg();
    const userA = await makeUser();
    const userB = await makeUser();

    // Fire both ensureMembership calls at the same time so they race
    // through the zero-member check before either commits.
    const [resultA, resultB] = await Promise.all([
      ensureMembership(userA.id, { id: emptyOrg.id }),
      ensureMembership(userB.id, { id: emptyOrg.id }),
    ]);

    const owners = [resultA, resultB].filter(
      (u) => u?.organizationId === emptyOrg.id && u?.role === "owner" && u?.isPlatformAdmin,
    );
    const orgLess = [resultA, resultB].filter((u) => !u?.organizationId);

    // The FOR UPDATE advisory lock must guarantee exactly one winner.
    expect(owners).toHaveLength(1);
    expect(orgLess).toHaveLength(1);

    // Verify the DB reflects the same single winner.
    const [{ ownerCount }] = await db
      .select({ ownerCount: count() })
      .from(usersTable)
      .where(eq(usersTable.organizationId, emptyOrg.id));
    expect(Number(ownerCount)).toBe(1);
  });
});

describe("invited-user path bypasses bootstrap logic", () => {
  it("a user pre-provisioned with an org (invite: adoption) skips the bootstrap check", async () => {
    const emptyOrg = await makeEmptyOrg();

    // Simulate an invited user: already has organizationId set before ensureMembership runs.
    const invitedUser = await makeUser({
      id: `invite:${crypto.randomUUID()}`,
      organizationId: emptyOrg.id,
      role: "viewer",
      isPlatformAdmin: false,
    });

    // ensureMembership returns early because organizationId is already set —
    // it never touches the empty-org bootstrap branch.
    const result = await ensureMembership(invitedUser.id);

    // Org membership and role are unchanged (no bootstrap promotion).
    expect(result?.organizationId).toBe(emptyOrg.id);
    expect(result?.role).toBe("viewer");
    expect(result?.isPlatformAdmin).toBe(false);

    // The org still has exactly one member (the invited user), so the
    // bootstrap slot was never consumed by the wrong path.
    const [{ memberCount }] = await db
      .select({ memberCount: count() })
      .from(usersTable)
      .where(eq(usersTable.organizationId, emptyOrg.id));
    expect(Number(memberCount)).toBe(1);
  });

  it("a brand-new user (no org) still gets org-less result when org has members via invite", async () => {
    const emptyOrg = await makeEmptyOrg();

    // Pre-seed the org with an invited member so it's no longer empty.
    const invitedMember = await makeUser({
      organizationId: emptyOrg.id,
      role: "viewer",
    });
    void invitedMember; // tracked in createdUserIds via makeUser

    // A new sign-up (no pre-set org) should not get promoted because the org
    // already has a member — invited path must not leave the bootstrap slot open.
    const newUser = await makeUser();
    const result = await ensureMembership(newUser.id, { id: emptyOrg.id });

    expect(result?.organizationId).toBeNull();
    expect(result?.isPlatformAdmin).toBe(false);
  });
});
