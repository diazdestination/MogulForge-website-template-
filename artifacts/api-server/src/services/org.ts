import { db, organizationsTable, usersTable } from "@workspace/db";
import { count, eq, sql } from "drizzle-orm";
import { ensureDefaultAutomations } from "./automation";
import { CLIENT } from "../lib/client.config";

export const DEFAULT_ORG_SLUG = CLIENT.defaultOrgSlug;

/** Get (or lazily create) the default organization for this deployment. */
export async function getDefaultOrganization() {
  const [existing] = await db
    .select()
    .from(organizationsTable)
    .where(eq(organizationsTable.slug, DEFAULT_ORG_SLUG));
  if (existing) {
    // Existing orgs get default automations seeded once (idempotent).
    await ensureDefaultAutomations(existing.id).catch((err) =>
      console.error("[org] seeding default automations failed:", err),
    );
    return existing;
  }
  const [created] = await db
    .insert(organizationsTable)
    .values({
      name: CLIENT.defaultOrgName,
      slug: DEFAULT_ORG_SLUG,
    })
    .onConflictDoNothing()
    .returning();
  const org =
    created ??
    (
      await db
        .select()
        .from(organizationsTable)
        .where(eq(organizationsTable.slug, DEFAULT_ORG_SLUG))
    )[0];
  if (org) {
    await ensureDefaultAutomations(org.id).catch((err) =>
      console.error("[org] seeding default automations failed:", err),
    );
  }
  return org;
}

/**
 * Attach a user to the default organization if they have none.
 * The first member of an organization becomes its owner; everyone else
 * starts as a viewer until an admin promotes them.
 */
export async function ensureMembership(userId: string) {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  if (!user || user.organizationId) return user;

  const org = await getDefaultOrganization();
  // Transaction + row lock on the org serializes concurrent first logins so
  // only one user can ever be promoted to owner.
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select id from ${organizationsTable} where ${organizationsTable.id} = ${org.id} for update`,
    );
    const [{ value: memberCount }] = await tx
      .select({ value: count() })
      .from(usersTable)
      .where(eq(usersTable.organizationId, org.id));

    const [updated] = await tx
      .update(usersTable)
      .set({
        organizationId: org.id,
        role: memberCount === 0 ? "owner" : "viewer",
      })
      .where(eq(usersTable.id, userId))
      .returning();
    return updated;
  });
}
