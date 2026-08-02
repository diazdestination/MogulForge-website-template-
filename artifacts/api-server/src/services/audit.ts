import { auditEventsTable, db } from "@workspace/db";

/** Record an audit event for a sensitive write. Never throws. */
export async function recordAudit(params: {
  organizationId: string;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(auditEventsTable).values({
    organizationId: params.organizationId,
    actorUserId: params.actorUserId ?? null,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId ?? null,
    metadata: params.metadata ?? {},
  });
}
