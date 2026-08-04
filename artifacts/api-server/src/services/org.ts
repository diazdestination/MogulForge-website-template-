import {
  GENERIC_APPOINTMENT_REMINDER,
  GENERIC_CONCIERGE_SETTINGS,
  GENERIC_LEAD_SCORING,
  db,
  orgSettingsTable,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { count, eq, sql } from "drizzle-orm";
import { ensureDefaultAutomations } from "./automation";
import { ensureDefaultPlaybook } from "./playbooks";
import { ensureInstallation } from "./installation";
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

export { isLegacyDefaultOrg, clearLegacyOrgCache } from "../lib/orgFlavor";

/**
 * Attach a user to the default organization ONLY when it has no members yet
 * (initial platform bootstrap: the very first sign-in becomes the owner).
 *
 * Everyone else signs in without an org and either accepts an invite
 * (invited users are pre-provisioned with an organizationId, so they never
 * reach this path) or creates their own organization through the self-serve
 * flow. New users are deliberately NOT auto-attached to the default org —
 * strangers must never land inside another company's CRM.
 */
export async function ensureMembership(
  userId: string,
  /** Test-only seam: supply a fresh empty org id to exercise the bootstrap branch
   *  without touching the real default org (which always has members in dev/CI). */
  _testOrgOverride?: { id: string },
) {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  if (!user || user.organizationId) return user;

  const org = _testOrgOverride
    ? (
        await db
          .select()
          .from(organizationsTable)
          .where(eq(organizationsTable.id, _testOrgOverride.id))
      )[0]
    : await getDefaultOrganization();
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
    if (memberCount > 0) return user; // stay org-less; self-serve flow takes over

    const [updated] = await tx
      .update(usersTable)
      .set({ organizationId: org.id, role: "owner", isPlatformAdmin: true })
      .where(eq(usersTable.id, userId))
      .returning();
    return updated ?? user;
  });
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
const RESERVED_SLUGS = new Set(["api", "www", "admin", "platform", "app", "public"]);

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

/**
 * Self-serve org creation. Creates the organization, makes the creator its
 * owner, and seeds industry-neutral defaults (settings, automations,
 * playbook, installation key) so the onboarding wizard starts from a safe,
 * generic baseline — no roofing copy, no borrowed branding.
 *
 * The creator must not already belong to an org (platform admins may create
 * orgs without joining them, for provisioning clients).
 */
export async function createOrganization(params: {
  name: string;
  slug?: string;
  timezone?: string;
  creatorUserId: string;
  attachCreator: boolean;
}): Promise<
  | { org: { id: string; name: string; slug: string; timezone: string } }
  | { error: string }
> {
  const name = params.name.trim().slice(0, 120);
  if (name.length < 2) return { error: "Company name is too short" };
  const slug = (params.slug?.trim() || slugify(name)).toLowerCase();
  if (!SLUG_RE.test(slug) || RESERVED_SLUGS.has(slug)) {
    return { error: "Invalid identifier — use 3-50 lowercase letters, numbers, and hyphens" };
  }
  const timezone = params.timezone && isValidTimezone(params.timezone)
    ? params.timezone
    : "America/New_York";

  const created = await db.transaction(async (tx) => {
    const [creator] = await tx
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, params.creatorUserId));
    if (!creator) return { error: "User not found" as const };
    if (params.attachCreator && creator.organizationId) {
      return { error: "You already belong to an organization" as const };
    }
    const [org] = await tx
      .insert(organizationsTable)
      .values({ name, slug, timezone })
      .onConflictDoNothing()
      .returning();
    if (!org) return { error: "That identifier is already taken" as const };
    if (params.attachCreator) {
      await tx
        .update(usersTable)
        .set({ organizationId: org.id, role: "owner" })
        .where(eq(usersTable.id, params.creatorUserId));
    }
    // Seed neutral settings inline so the org never falls back to legacy copy.
    await tx
      .insert(orgSettingsTable)
      .values({
        organizationId: org.id,
        businessProfile: { businessName: name },
        services: [],
        serviceAreas: [],
        leadScoring: GENERIC_LEAD_SCORING,
        appointmentReminder: GENERIC_APPOINTMENT_REMINDER,
        concierge: GENERIC_CONCIERGE_SETTINGS,
        onboarding: { completedSteps: [], currentStep: "company" },
      })
      .onConflictDoNothing();
    return { org };
  });
  if ("error" in created) return created;

  // Idempotent seeds (own advisory locks; safe outside the transaction).
  await ensureDefaultAutomations(created.org.id).catch((err) =>
    console.error("[org] seeding automations for new org failed:", err),
  );
  await ensureDefaultPlaybook(created.org.id).catch((err) =>
    console.error("[org] seeding playbook for new org failed:", err),
  );
  await ensureInstallation(created.org.id, ["localhost"]).catch((err) =>
    console.error("[org] seeding installation for new org failed:", err),
  );
  return {
    org: {
      id: created.org.id,
      name: created.org.name,
      slug: created.org.slug,
      timezone: created.org.timezone,
    },
  };
}

/**
 * Idempotent startup migration: grant platform-admin to the default org's
 * owners (the MogulForge operators who ran the platform before multi-org).
 */
export async function ensurePlatformAdmins(): Promise<void> {
  const [org] = await db
    .select({ id: organizationsTable.id })
    .from(organizationsTable)
    .where(eq(organizationsTable.slug, DEFAULT_ORG_SLUG));
  if (!org) return;
  await db
    .update(usersTable)
    .set({ isPlatformAdmin: true })
    .where(
      sql`${usersTable.organizationId} = ${org.id} and ${usersTable.role} = 'owner' and ${usersTable.isPlatformAdmin} = false`,
    );
}

/** Platform-admin view: every organization with its member count. */
export async function listAllOrganizations() {
  return db
    .select({
      id: organizationsTable.id,
      name: organizationsTable.name,
      slug: organizationsTable.slug,
      timezone: organizationsTable.timezone,
      createdAt: organizationsTable.createdAt,
      memberCount: count(usersTable.id),
    })
    .from(organizationsTable)
    .leftJoin(usersTable, eq(usersTable.organizationId, organizationsTable.id))
    .groupBy(organizationsTable.id)
    .orderBy(organizationsTable.createdAt);
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
