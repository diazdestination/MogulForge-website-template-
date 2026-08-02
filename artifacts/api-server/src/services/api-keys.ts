import { createHash, randomBytes } from "node:crypto";

import { apiKeysTable, db, usersTable, type ApiKey, type UserRole } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export async function listApiKeys(organizationId: string): Promise<ApiKey[]> {
  return db
    .select()
    .from(apiKeysTable)
    .where(eq(apiKeysTable.organizationId, organizationId))
    .orderBy(desc(apiKeysTable.createdAt));
}

export async function createApiKey(params: {
  organizationId: string;
  name: string;
  role: UserRole;
  createdByUserId: string;
  expiresAt?: Date | null;
}): Promise<{ record: ApiKey; key: string }> {
  const key = `pk_${randomBytes(24).toString("hex")}`;
  const [record] = await db
    .insert(apiKeysTable)
    .values({
      organizationId: params.organizationId,
      name: params.name,
      prefix: key.slice(0, 10),
      keyHash: hashApiKey(key),
      role: params.role,
      createdByUserId: params.createdByUserId,
      expiresAt: params.expiresAt ?? null,
    })
    .returning();
  return { record, key };
}

export async function updateApiKey(
  organizationId: string,
  id: string,
  changes: { name?: string; expiresAt?: Date | null },
): Promise<{ before: ApiKey; after: ApiKey } | undefined> {
  const [before] = await db
    .select()
    .from(apiKeysTable)
    .where(
      and(
        eq(apiKeysTable.id, id),
        eq(apiKeysTable.organizationId, organizationId),
        eq(apiKeysTable.isActive, true),
      ),
    );
  if (!before) return undefined;
  const set: { name?: string; expiresAt?: Date | null } = {};
  if (changes.name !== undefined) set.name = changes.name;
  if (changes.expiresAt !== undefined) set.expiresAt = changes.expiresAt;
  const [after] = await db
    .update(apiKeysTable)
    // A changed expiry deserves a fresh pre-expiry reminder: clearing the
    // sent marker lets the scheduler warn once about the new date.
    .set(
      changes.expiresAt !== undefined
        ? { ...set, expiryReminderSentAt: null }
        : set,
    )
    .where(
      and(
        eq(apiKeysTable.id, id),
        eq(apiKeysTable.organizationId, organizationId),
        eq(apiKeysTable.isActive, true),
      ),
    )
    .returning();
  if (!after) return undefined;
  return { before, after };
}

export async function revokeApiKey(
  organizationId: string,
  id: string,
): Promise<ApiKey | undefined> {
  const [row] = await db
    .update(apiKeysTable)
    .set({ isActive: false, revokedAt: new Date() })
    .where(and(eq(apiKeysTable.id, id), eq(apiKeysTable.organizationId, organizationId)))
    .returning();
  return row;
}

/**
 * Resolve an `x-api-key` header value to an org context. The key acts on
 * behalf of the (still active) admin who created it, capped at the key's role.
 */
export async function resolveApiKey(rawKey: string) {
  const [key] = await db
    .select()
    .from(apiKeysTable)
    .where(and(eq(apiKeysTable.keyHash, hashApiKey(rawKey)), eq(apiKeysTable.isActive, true)));
  if (!key) return null;
  // Expired keys are rejected exactly like revoked ones.
  if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) return null;
  const [creator] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, key.createdByUserId));
  if (!creator || !creator.isActive) return null;
  // Fire-and-forget usage timestamp.
  void db
    .update(apiKeysTable)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeysTable.id, key.id))
    .catch(() => undefined);
  return { key, creator };
}

export function toApiKeyDto(k: ApiKey) {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    role: k.role,
    isActive: k.isActive,
    lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
    expiresAt: k.expiresAt ? k.expiresAt.toISOString() : null,
    createdAt: k.createdAt.toISOString(),
  };
}
