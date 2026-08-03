import { dispatchWebhookEvent } from "./webhooks";
import {
  activitiesTable,
  analyticsEventsTable,
  appointmentsTable,
  auditEventsTable,
  contactsTable,
  conversationsTable,
  crmTasksTable,
  db,
  estimatesTable,
  leadsTable,
  leadTagsTable,
  projectsTable,
  propertiesTable,
  savedFiltersTable,
  tagsTable,
  usersTable,
} from "@workspace/db";
import { and, count, desc, eq, gte, ilike, inArray, ne, or, sql } from "drizzle-orm";

import {
  cancelAppointmentReminders,
  scheduleAppointmentReminder,
} from "./automation";
import {
  insertInspectionIfAvailable,
  updateInspectionIfAvailable,
} from "./inspection-booking";

/**
 * Org-scoped CRM data access. Every query in this module REQUIRES an
 * organizationId — tenant isolation is enforced here, not in routes.
 */

// ---------- tenant referential integrity ----------

interface RelationalRefs {
  contactId?: string | null;
  propertyId?: string | null;
  leadId?: string | null;
  assignedUserId?: string | null;
}

/**
 * Verify that every provided relational ID belongs to the given org.
 * Prevents cross-tenant links (e.g. attaching another org's property to a
 * lead). Returns false on any mismatch.
 */
export async function validateOrgRefs(
  organizationId: string,
  refs: RelationalRefs,
): Promise<boolean> {
  const checks: Promise<boolean>[] = [];
  if (refs.contactId) {
    checks.push(
      db
        .select({ id: contactsTable.id })
        .from(contactsTable)
        .where(
          and(
            eq(contactsTable.id, refs.contactId),
            eq(contactsTable.organizationId, organizationId),
          ),
        )
        .then((r) => r.length > 0),
    );
  }
  if (refs.propertyId) {
    checks.push(
      db
        .select({ id: propertiesTable.id })
        .from(propertiesTable)
        .where(
          and(
            eq(propertiesTable.id, refs.propertyId),
            eq(propertiesTable.organizationId, organizationId),
          ),
        )
        .then((r) => r.length > 0),
    );
  }
  if (refs.leadId) {
    checks.push(
      db
        .select({ id: leadsTable.id })
        .from(leadsTable)
        .where(
          and(
            eq(leadsTable.id, refs.leadId),
            eq(leadsTable.organizationId, organizationId),
          ),
        )
        .then((r) => r.length > 0),
    );
  }
  if (refs.assignedUserId) {
    checks.push(
      db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(
          and(
            eq(usersTable.id, refs.assignedUserId),
            eq(usersTable.organizationId, organizationId),
          ),
        )
        .then((r) => r.length > 0),
    );
  }
  const results = await Promise.all(checks);
  return results.every(Boolean);
}

// ---------- contacts ----------

const MAX_PAGE_SIZE = 200;

interface PageOpts {
  limit?: number;
  offset?: number;
}

function clampPage(page: PageOpts = {}) {
  const limit =
    page.limit && Number.isFinite(page.limit)
      ? Math.min(Math.max(Math.floor(page.limit), 1), MAX_PAGE_SIZE)
      : MAX_PAGE_SIZE;
  const offset =
    page.offset && Number.isFinite(page.offset)
      ? Math.max(Math.floor(page.offset), 0)
      : 0;
  return { limit, offset };
}

export async function listContacts(
  organizationId: string,
  search?: string,
  page: PageOpts = {},
) {
  const scope = eq(contactsTable.organizationId, organizationId);
  const where = search
    ? and(
        scope,
        or(
          ilike(contactsTable.firstName, `%${search}%`),
          ilike(contactsTable.lastName, `%${search}%`),
          ilike(contactsTable.email, `%${search}%`),
          ilike(contactsTable.phone, `%${search}%`),
        ),
      )
    : scope;
  const { limit, offset } = clampPage(page);
  return db
    .select()
    .from(contactsTable)
    .where(where)
    .orderBy(desc(contactsTable.createdAt), desc(contactsTable.id))
    .limit(limit)
    .offset(offset);
}

export async function getContact(organizationId: string, id: string) {
  const [row] = await db
    .select()
    .from(contactsTable)
    .where(
      and(eq(contactsTable.id, id), eq(contactsTable.organizationId, organizationId)),
    );
  return row ?? null;
}

export async function createContact(
  organizationId: string,
  input: Partial<typeof contactsTable.$inferInsert> & { firstName: string },
) {
  const [row] = await db
    .insert(contactsTable)
    .values({ ...input, organizationId })
    .returning();
  return row;
}

export async function updateContact(
  organizationId: string,
  id: string,
  input: Partial<typeof contactsTable.$inferInsert>,
) {
  const { organizationId: _ignored, id: _id, ...safe } = input as Record<string, unknown>;
  const [row] = await db
    .update(contactsTable)
    .set(safe)
    .where(
      and(eq(contactsTable.id, id), eq(contactsTable.organizationId, organizationId)),
    )
    .returning();
  return row ?? null;
}

export async function deleteContact(organizationId: string, id: string) {
  const rows = await db
    .delete(contactsTable)
    .where(
      and(eq(contactsTable.id, id), eq(contactsTable.organizationId, organizationId)),
    )
    .returning({ id: contactsTable.id });
  return rows.length > 0;
}

// ---------- properties ----------

export async function listProperties(
  organizationId: string,
  contactId?: string,
  page: PageOpts = {},
) {
  const scope = eq(propertiesTable.organizationId, organizationId);
  const { limit, offset } = clampPage(page);
  return db
    .select()
    .from(propertiesTable)
    .where(contactId ? and(scope, eq(propertiesTable.contactId, contactId)) : scope)
    .orderBy(desc(propertiesTable.createdAt), desc(propertiesTable.id))
    .limit(limit)
    .offset(offset);
}

export async function getProperty(organizationId: string, id: string) {
  const [row] = await db
    .select()
    .from(propertiesTable)
    .where(
      and(eq(propertiesTable.id, id), eq(propertiesTable.organizationId, organizationId)),
    );
  return row ?? null;
}

export async function createProperty(
  organizationId: string,
  input: Omit<typeof propertiesTable.$inferInsert, "organizationId">,
) {
  if (!(await validateOrgRefs(organizationId, { contactId: input.contactId }))) {
    return null;
  }
  const [row] = await db
    .insert(propertiesTable)
    .values({ ...input, organizationId })
    .returning();
  return row;
}

export async function updateProperty(
  organizationId: string,
  id: string,
  input: Partial<typeof propertiesTable.$inferInsert>,
) {
  const { organizationId: _ignored, id: _id, ...safe } = input as Record<string, unknown>;
  if (!(await validateOrgRefs(organizationId, { contactId: input.contactId }))) {
    return null;
  }
  const [row] = await db
    .update(propertiesTable)
    .set(safe)
    .where(
      and(eq(propertiesTable.id, id), eq(propertiesTable.organizationId, organizationId)),
    )
    .returning();
  return row ?? null;
}

const MAX_LEAD_PAGE_SIZE = 200;
export async function listLeads(
  organizationId: string,
  filters: {
    status?: string;
    assignedUserId?: string;
    source?: string;
    search?: string;
    limit?: number;
    offset?: number;
    hasUnreadPortalMessage?: boolean;
  } = {},
) {
  const conditions = [eq(leadsTable.organizationId, organizationId)];
  if (filters.status) {
    conditions.push(
      eq(leadsTable.status, filters.status as typeof leadsTable.$inferSelect.status),
    );
  }
  if (filters.assignedUserId) {
    conditions.push(eq(leadsTable.assignedUserId, filters.assignedUserId));
  }
  if (filters.source) {
    conditions.push(eq(leadsTable.source, filters.source));
  }
  if (filters.hasUnreadPortalMessage === true) {
    conditions.push(
      sql`(
        SELECT COALESCE(
          max(occurred_at) FILTER (WHERE type = 'portal_message') >
          COALESCE(max(occurred_at) FILTER (WHERE type = 'team_message'), '-infinity'::timestamptz),
          false
        )
        FROM activities
        WHERE lead_id = ${leadsTable.id}
          AND organization_id = ${leadsTable.organizationId}
      )`,
    );
  }
  const search = filters.search?.trim();
  if (search) {
    const term = `%${search}%`;
    conditions.push(
      or(
        sql`coalesce(${contactsTable.firstName}, '') || ' ' || coalesce(${contactsTable.lastName}, '') ILIKE ${term}`,
        ilike(leadsTable.serviceType, term),
      )!,
    );
  }
  const limit =
    filters.limit && Number.isFinite(filters.limit)
      ? Math.min(Math.max(Math.floor(filters.limit), 1), MAX_LEAD_PAGE_SIZE)
      : MAX_LEAD_PAGE_SIZE;
  const offset =
    filters.offset && Number.isFinite(filters.offset)
      ? Math.max(Math.floor(filters.offset), 0)
      : 0;
  const rows = await db
    .select({
      lead: leadsTable,
      contactFirstName: contactsTable.firstName,
      contactLastName: contactsTable.lastName,
      contactEmail: contactsTable.email,
      contactPhone: contactsTable.phone,
      hasUnreadPortalMessage: sql<boolean>`(
        SELECT COALESCE(
          max(occurred_at) FILTER (WHERE type = 'portal_message') >
          COALESCE(max(occurred_at) FILTER (WHERE type = 'team_message'), '-infinity'::timestamptz),
          false
        )
        FROM activities
        WHERE lead_id = ${leadsTable.id}
          AND organization_id = ${leadsTable.organizationId}
      )`.as('has_unread_portal_message'),
      photoCount: sql<number>`(
        SELECT COALESCE(SUM(jsonb_array_length(metadata->'photoPaths')), 0)
        FROM activities
        WHERE lead_id = ${leadsTable.id}
          AND organization_id = ${leadsTable.organizationId}
          AND type = 'photos_attached'
          AND metadata ? 'photoPaths'
      )`.as('photo_count'),
    })
    .from(leadsTable)
    .leftJoin(contactsTable, eq(leadsTable.contactId, contactsTable.id))
    .where(and(...conditions))
    .orderBy(desc(leadsTable.createdAt), desc(leadsTable.id))
    .limit(limit)
    .offset(offset);
  return rows.map((row) => ({
    ...row.lead,
    contactName:
      [row.contactFirstName, row.contactLastName].filter(Boolean).join(" ") || null,
    contactEmail: row.contactEmail ?? null,
    contactPhone: row.contactPhone ?? null,
    hasUnreadPortalMessage: row.hasUnreadPortalMessage ?? false,
    photoCount: Number(row.photoCount ?? 0),
  }));
}

export async function getLead(organizationId: string, id: string) {
  const [row] = await db
    .select()
    .from(leadsTable)
    .where(and(eq(leadsTable.id, id), eq(leadsTable.organizationId, organizationId)));
  return row ?? null;
}

export async function createLead(
  organizationId: string,
  input: Omit<typeof leadsTable.$inferInsert, "organizationId">,
) {
  // Referential tenant check: every related record must belong to the org.
  const ok = await validateOrgRefs(organizationId, {
    contactId: input.contactId,
    propertyId: input.propertyId,
    assignedUserId: input.assignedUserId,
  });
  if (!ok) return null;

  const [row] = await db
    .insert(leadsTable)
    .values({
      // API-created leads still record how they entered the system and keep
      // latestSource in sync with the original source by default.
      creationMethod: "api",
      latestSource: input.latestSource ?? input.source ?? null,
      ...input,
      organizationId,
    })
    .returning();
  return row;
}

export async function updateLead(
  organizationId: string,
  id: string,
  input: Partial<typeof leadsTable.$inferInsert>,
) {
  const { organizationId: _ignored, id: _id, contactId: _c, ...safe } =
    input as Record<string, unknown>;
  const ok = await validateOrgRefs(organizationId, {
    propertyId: input.propertyId,
    assignedUserId: input.assignedUserId,
  });
  if (!ok) return null;
  const [row] = await db
    .update(leadsTable)
    .set(safe)
    .where(and(eq(leadsTable.id, id), eq(leadsTable.organizationId, organizationId)))
    .returning();
  return row ?? null;
}

export async function listEstimates(
  organizationId: string,
  filters: { leadId?: string; status?: string; limit?: number; offset?: number } = {},
) {
  const conditions = [eq(estimatesTable.organizationId, organizationId)];
  if (filters.leadId) {
    conditions.push(eq(estimatesTable.leadId, filters.leadId));
  }
  if (filters.status) {
    conditions.push(
      eq(
        estimatesTable.status,
        filters.status as typeof estimatesTable.$inferSelect.status,
      ),
    );
  }
  const { limit, offset } = clampPage(filters);
  const rows = await db
    .select({
      estimate: estimatesTable,
      leadSummary: leadsTable.summary,
      contactFirstName: contactsTable.firstName,
      contactLastName: contactsTable.lastName,
    })
    .from(estimatesTable)
    .leftJoin(leadsTable, eq(estimatesTable.leadId, leadsTable.id))
    .leftJoin(contactsTable, eq(leadsTable.contactId, contactsTable.id))
    .where(and(...conditions))
    .orderBy(desc(estimatesTable.createdAt), desc(estimatesTable.id))
    .limit(limit)
    .offset(offset);
  return rows.map((row) => ({
    ...row.estimate,
    leadLabel: buildLeadLabel(row),
  }));
}

/**
 * Display label for a record's linked lead: the contact's name, falling back
 * to the lead summary. Resolved server-side so clients never need to download
 * the (capped) lead list just to label estimates/projects.
 */
function buildLeadLabel(row: {
  contactFirstName: string | null;
  contactLastName: string | null;
  leadSummary: string | null;
}): string | null {
  return (
    [row.contactFirstName, row.contactLastName].filter(Boolean).join(" ") ||
    row.leadSummary ||
    null
  );
}

// ---------- bulk lead actions ----------

export async function bulkUpdateLeads(
  organizationId: string,
  leadIds: string[],
  patch: { status?: string; assignedUserId?: string | null },
) {
  if (patch.assignedUserId) {
    const ok = await validateOrgRefs(organizationId, {
      assignedUserId: patch.assignedUserId,
    });
    if (!ok) return null;
  }
  const set: Record<string, unknown> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.assignedUserId !== undefined) set.assignedUserId = patch.assignedUserId;
  const rows = await db
    .update(leadsTable)
    .set(set)
    .where(
      and(
        eq(leadsTable.organizationId, organizationId),
        inArray(leadsTable.id, leadIds),
      ),
    )
    .returning({ id: leadsTable.id });
  return rows.map((r) => r.id);
}

export async function bulkTagLeads(
  organizationId: string,
  leadIds: string[],
  tagId: string,
) {
  const [tag] = await db
    .select({ id: tagsTable.id })
    .from(tagsTable)
    .where(
      and(eq(tagsTable.id, tagId), eq(tagsTable.organizationId, organizationId)),
    );
  if (!tag) return null;
  const owned = await db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.organizationId, organizationId),
        inArray(leadsTable.id, leadIds),
      ),
    );
  if (owned.length === 0) return [];
  await db
    .insert(leadTagsTable)
    .values(
      owned.map((l) => ({ organizationId, leadId: l.id, tagId })),
    )
    .onConflictDoNothing();
  return owned.map((l) => l.id);
}

// ---------- duplicate detection ----------

export interface DuplicateLeadGroup {
  field: "phone" | "email" | "address";
  value: string;
  leadIds: string[];
}

/**
 * Find groups of leads whose contacts share a normalized phone or email,
 * or whose properties share an address. Only groups with 2+ leads count.
 * Lost leads are excluded: merged-away duplicates are marked lost, so
 * including them would keep suggesting pairs that were already merged.
 */
export async function findDuplicateLeadGroups(
  organizationId: string,
  opts: { batchSize?: number } = {},
): Promise<DuplicateLeadGroup[]> {
  // Paginate through ALL of the org's leads with a keyset cursor on lead id,
  // so duplicates are still detected in orgs larger than one batch.
  // `batchSize` exists so tests can exercise multi-batch scans cheaply.
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? 1000));
  const rows: {
    leadId: string;
    phone: string | null;
    email: string | null;
    addressLine1: string | null;
    postalCode: string | null;
  }[] = [];
  let cursor: string | null = null;
  for (;;) {
    const conditions = [
      eq(leadsTable.organizationId, organizationId),
      ne(leadsTable.status, "lost"),
    ];
    if (cursor !== null) {
      conditions.push(sql`${leadsTable.id} > ${cursor}`);
    }
    const batch = await db
      .select({
        leadId: leadsTable.id,
        phone: contactsTable.phone,
        email: contactsTable.email,
        addressLine1: propertiesTable.addressLine1,
        postalCode: propertiesTable.postalCode,
      })
      .from(leadsTable)
      .innerJoin(contactsTable, eq(leadsTable.contactId, contactsTable.id))
      .leftJoin(propertiesTable, eq(leadsTable.propertyId, propertiesTable.id))
      .where(and(...conditions))
      .orderBy(leadsTable.id)
      .limit(batchSize);
    rows.push(...batch);
    if (batch.length < batchSize) break;
    cursor = batch[batch.length - 1]!.leadId;
  }

  const buckets = new Map<string, { field: DuplicateLeadGroup["field"]; value: string; leadIds: Set<string> }>();
  const add = (field: DuplicateLeadGroup["field"], raw: string | null, leadId: string) => {
    if (!raw) return;
    const norm =
      field === "phone"
        ? raw.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "")
        : raw.trim().toLowerCase();
    if (norm.length < 4) return;
    const key = `${field}:${norm}`;
    const bucket = buckets.get(key) ?? { field, value: raw, leadIds: new Set() };
    bucket.leadIds.add(leadId);
    buckets.set(key, bucket);
  };
  for (const row of rows) {
    add("phone", row.phone, row.leadId);
    add("email", row.email, row.leadId);
    if (row.addressLine1) {
      add("address", `${row.addressLine1}, ${row.postalCode ?? ""}`, row.leadId);
    }
  }
  return [...buckets.values()]
    .filter((b) => b.leadIds.size > 1)
    .map((b) => ({ field: b.field, value: b.value, leadIds: [...b.leadIds] }));
}

// ---------- lead merge ----------

/**
 * Merge one duplicate lead into a surviving lead. Moves the source lead's
 * activities and tags onto the survivor, records a merge note on the
 * survivor's timeline, and marks the source lead lost. All org-scoped and
 * transactional.
 */
export async function mergeLeads(
  organizationId: string,
  survivorId: string,
  sourceId: string,
  actorUserId: string,
): Promise<
  | {
      ok: true;
      lead: typeof leadsTable.$inferSelect;
      movedActivities: number;
      movedTags: number;
      movedAppointments: number;
      movedTasks: number;
      movedEstimates: number;
      movedProjects: number;
      movedConversations: number;
    }
  | { ok: false; error: "not_found" | "same_lead" }
> {
  if (survivorId === sourceId) return { ok: false, error: "same_lead" };
  const leads = await db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.organizationId, organizationId),
        inArray(leadsTable.id, [survivorId, sourceId]),
      ),
    );
  const survivor = leads.find((l) => l.id === survivorId);
  const source = leads.find((l) => l.id === sourceId);
  if (!survivor || !source) return { ok: false, error: "not_found" };

  return db.transaction(async (tx) => {
    // Move activities onto the survivor.
    const movedActivities = await tx
      .update(activitiesTable)
      .set({ leadId: survivorId })
      .where(
        and(
          eq(activitiesTable.organizationId, organizationId),
          eq(activitiesTable.leadId, sourceId),
        ),
      )
      .returning({ id: activitiesTable.id });

    // Move tags: copy the source's tags to the survivor (skipping ones it
    // already has), then remove them from the source.
    const sourceTags = await tx
      .select({ tagId: leadTagsTable.tagId })
      .from(leadTagsTable)
      .where(
        and(
          eq(leadTagsTable.organizationId, organizationId),
          eq(leadTagsTable.leadId, sourceId),
        ),
      );
    if (sourceTags.length > 0) {
      await tx
        .insert(leadTagsTable)
        .values(
          sourceTags.map((t) => ({
            organizationId,
            leadId: survivorId,
            tagId: t.tagId,
          })),
        )
        .onConflictDoNothing();
      await tx
        .delete(leadTagsTable)
        .where(
          and(
            eq(leadTagsTable.organizationId, organizationId),
            eq(leadTagsTable.leadId, sourceId),
          ),
        );
    }

    // Re-point scheduled/attached work from the source onto the survivor so
    // nothing is lost when the duplicate is archived.
    const movedAppointments = await tx
      .update(appointmentsTable)
      .set({ leadId: survivorId })
      .where(
        and(
          eq(appointmentsTable.organizationId, organizationId),
          eq(appointmentsTable.leadId, sourceId),
        ),
      )
      .returning({ id: appointmentsTable.id });

    const movedTasks = await tx
      .update(crmTasksTable)
      .set({ leadId: survivorId })
      .where(
        and(
          eq(crmTasksTable.organizationId, organizationId),
          eq(crmTasksTable.leadId, sourceId),
        ),
      )
      .returning({ id: crmTasksTable.id });

    const movedEstimates = await tx
      .update(estimatesTable)
      .set({ leadId: survivorId })
      .where(
        and(
          eq(estimatesTable.organizationId, organizationId),
          eq(estimatesTable.leadId, sourceId),
        ),
      )
      .returning({ id: estimatesTable.id });

    const movedProjects = await tx
      .update(projectsTable)
      .set({ leadId: survivorId })
      .where(
        and(
          eq(projectsTable.organizationId, organizationId),
          eq(projectsTable.leadId, sourceId),
        ),
      )
      .returning({ id: projectsTable.id });

    const movedConversations = await tx
      .update(conversationsTable)
      .set({ leadId: survivorId })
      .where(
        and(
          eq(conversationsTable.organizationId, organizationId),
          eq(conversationsTable.leadId, sourceId),
        ),
      )
      .returning({ id: conversationsTable.id });

    // Mark the source lead lost so it drops out of the working pipeline.
    await tx
      .update(leadsTable)
      .set({ status: "lost" })
      .where(
        and(
          eq(leadsTable.id, sourceId),
          eq(leadsTable.organizationId, organizationId),
        ),
      );

    // Timeline note on the survivor documenting the merge.
    await tx.insert(activitiesTable).values({
      organizationId,
      leadId: survivorId,
      contactId: survivor.contactId,
      actorUserId,
      type: "note",
      title: "Merged duplicate lead",
      body:
        `Merged duplicate lead ${sourceId.substring(0, 8)} into this lead. ` +
        `${movedActivities.length} activities, ${sourceTags.length} tags, ` +
        `${movedAppointments.length} appointments, ${movedTasks.length} tasks, ` +
        `${movedEstimates.length} estimates, ${movedProjects.length} projects, ` +
        `and ${movedConversations.length} conversations were moved; the duplicate was marked lost.`,
      metadata: {
        mergedLeadId: sourceId,
        movedActivities: movedActivities.length,
        movedTags: sourceTags.length,
        movedAppointments: movedAppointments.length,
        movedTasks: movedTasks.length,
        movedEstimates: movedEstimates.length,
        movedProjects: movedProjects.length,
        movedConversations: movedConversations.length,
      },
    });

    return {
      ok: true as const,
      lead: survivor,
      movedActivities: movedActivities.length,
      movedTags: sourceTags.length,
      movedAppointments: movedAppointments.length,
      movedTasks: movedTasks.length,
      movedEstimates: movedEstimates.length,
      movedProjects: movedProjects.length,
      movedConversations: movedConversations.length,
    };
  });
}

// ---------- saved filters ----------

export async function listSavedFilters(organizationId: string, userId: string) {
  return db
    .select()
    .from(savedFiltersTable)
    .where(
      and(
        eq(savedFiltersTable.organizationId, organizationId),
        eq(savedFiltersTable.userId, userId),
      ),
    )
    .orderBy(desc(savedFiltersTable.createdAt))
    .limit(100);
}

export async function createSavedFilter(
  organizationId: string,
  userId: string,
  input: { name: string; filters: Record<string, unknown> },
) {
  const [row] = await db
    .insert(savedFiltersTable)
    .values({ organizationId, userId, name: input.name, filters: input.filters })
    .returning();
  return row;
}

export async function deleteSavedFilter(
  organizationId: string,
  userId: string,
  id: string,
) {
  const rows = await db
    .delete(savedFiltersTable)
    .where(
      and(
        eq(savedFiltersTable.id, id),
        eq(savedFiltersTable.organizationId, organizationId),
        eq(savedFiltersTable.userId, userId),
      ),
    )
    .returning({ id: savedFiltersTable.id });
  return rows.length > 0;
}

// ---------- activities ----------

export async function listLeadActivities(organizationId: string, leadId: string) {
  return db
    .select()
    .from(activitiesTable)
    .where(
      and(
        eq(activitiesTable.organizationId, organizationId),
        eq(activitiesTable.leadId, leadId),
      ),
    )
    .orderBy(desc(activitiesTable.occurredAt))
    .limit(200);
}

export async function createActivity(
  organizationId: string,
  input: Omit<typeof activitiesTable.$inferInsert, "organizationId">,
) {
  const [row] = await db
    .insert(activitiesTable)
    .values({ ...input, organizationId })
    .returning();
  return row;
}

/**
 * Remove a single objectPath from a photos_attached activity on the given lead.
 * If the activity's photoPaths array becomes empty after removal, the activity
 * row is deleted entirely.
 *
 * Returns `true` when the path was found and removed, `false` when no matching
 * activity was found (the path was never part of this lead's photos).
 */
export async function removeLeadPhoto(
  organizationId: string,
  leadId: string,
  objectPath: string,
): Promise<boolean> {
  // Find the photos_attached activity that contains this objectPath on this lead.
  const rows = await db
    .select()
    .from(activitiesTable)
    .where(
      and(
        eq(activitiesTable.organizationId, organizationId),
        eq(activitiesTable.leadId, leadId),
        eq(activitiesTable.type, "photos_attached"),
        sql`${activitiesTable.metadata}->'photoPaths' @> ${JSON.stringify([objectPath])}::jsonb`,
      ),
    )
    .limit(1);

  const activity = rows[0];
  if (!activity) return false;

  const currentPaths = (activity.metadata as { photoPaths?: string[] }).photoPaths ?? [];
  const updatedPaths = currentPaths.filter((p) => p !== objectPath);

  if (updatedPaths.length === 0) {
    // Last photo — delete the whole activity.
    await db
      .delete(activitiesTable)
      .where(eq(activitiesTable.id, activity.id));
  } else {
    // Update the metadata with the remaining paths and fix the title.
    const n = updatedPaths.length;
    await db
      .update(activitiesTable)
      .set({
        metadata: { ...activity.metadata, photoPaths: updatedPaths },
        title: `Rep attached ${n} photo${n === 1 ? "" : "s"}`,
      })
      .where(eq(activitiesTable.id, activity.id));
  }

  return true;
}

// ---------- tasks ----------

export async function listTasks(
  organizationId: string,
  filters: { status?: string; assignedUserId?: string } = {},
) {
  const conditions = [eq(crmTasksTable.organizationId, organizationId)];
  if (filters.status) {
    conditions.push(
      eq(
        crmTasksTable.status,
        filters.status as typeof crmTasksTable.$inferSelect.status,
      ),
    );
  }
  if (filters.assignedUserId) {
    conditions.push(eq(crmTasksTable.assignedUserId, filters.assignedUserId));
  }
  const rows = await db
    .select({
      task: crmTasksTable,
      leadSummary: leadsTable.summary,
      contactFirstName: contactsTable.firstName,
      contactLastName: contactsTable.lastName,
    })
    .from(crmTasksTable)
    .leftJoin(leadsTable, eq(crmTasksTable.leadId, leadsTable.id))
    .leftJoin(contactsTable, eq(leadsTable.contactId, contactsTable.id))
    .where(and(...conditions))
    .orderBy(desc(crmTasksTable.createdAt))
    .limit(200);
  return rows.map((row) => ({
    ...row.task,
    leadLabel: row.task.leadId ? buildLeadLabel(row) : null,
  }));
}

export async function createTask(
  organizationId: string,
  input: Omit<typeof crmTasksTable.$inferInsert, "organizationId">,
) {
  const ok = await validateOrgRefs(organizationId, {
    leadId: input.leadId,
    contactId: input.contactId,
    assignedUserId: input.assignedUserId,
  });
  if (!ok) return null;
  const [row] = await db
    .insert(crmTasksTable)
    .values({ ...input, organizationId })
    .returning();
  return row;
}

export async function updateTask(
  organizationId: string,
  id: string,
  input: Partial<typeof crmTasksTable.$inferInsert>,
) {
  const { organizationId: _ignored, id: _id, ...safe } = input as Record<string, unknown>;
  const ok = await validateOrgRefs(organizationId, {
    leadId: input.leadId,
    contactId: input.contactId,
    assignedUserId: input.assignedUserId,
  });
  if (!ok) return null;
  const patch: Record<string, unknown> = { ...safe };
  if (patch.status === "done" && !patch.completedAt) {
    patch.completedAt = new Date();
  }
  const [row] = await db
    .update(crmTasksTable)
    .set(patch)
    .where(and(eq(crmTasksTable.id, id), eq(crmTasksTable.organizationId, organizationId)))
    .returning();
  return row ?? null;
}

export async function deleteTask(organizationId: string, id: string) {
  const rows = await db
    .delete(crmTasksTable)
    .where(and(eq(crmTasksTable.id, id), eq(crmTasksTable.organizationId, organizationId)))
    .returning({ id: crmTasksTable.id });
  return rows.length > 0;
}

// ---------- appointments ----------

export async function listAppointments(organizationId: string, leadId?: string) {
  const scope = eq(appointmentsTable.organizationId, organizationId);
  const rows = await db
    .select({
      appointment: appointmentsTable,
      leadSummary: leadsTable.summary,
      contactFirstName: contactsTable.firstName,
      contactLastName: contactsTable.lastName,
    })
    .from(appointmentsTable)
    .leftJoin(leadsTable, eq(appointmentsTable.leadId, leadsTable.id))
    .leftJoin(contactsTable, eq(leadsTable.contactId, contactsTable.id))
    .where(leadId ? and(scope, eq(appointmentsTable.leadId, leadId)) : scope)
    .orderBy(desc(appointmentsTable.scheduledStart))
    .limit(200);
  return rows.map((row) => ({
    ...row.appointment,
    leadLabel: row.appointment.leadId ? buildLeadLabel(row) : null,
  }));
}

// Grace window for "starts right now" bookings: matches the mobile client's
// 60-second allowance so a form submitted moments after picking "now" is not
// rejected by clock skew or a slow network.
export const PAST_START_GRACE_MS = 60_000;

/**
 * True when scheduling an *active* (scheduled/confirmed) appointment at a
 * start time materially in the past. Back-dating completed/cancelled/no-show
 * records for history stays allowed — only bookings that would occupy the
 * live schedule are guarded.
 */
function isPastActiveStart(status: string, scheduledStart: Date | null | undefined): boolean {
  if (status !== "scheduled" && status !== "confirmed") return false;
  if (!scheduledStart) return false;
  return scheduledStart.getTime() < Date.now() - PAST_START_GRACE_MS;
}

export async function createAppointment(
  organizationId: string,
  input: Omit<typeof appointmentsTable.$inferInsert, "organizationId">,
): Promise<typeof appointmentsTable.$inferSelect | null | "conflict" | "past_start"> {
  // Server-side guard: clients (web CRM, direct API calls) must not be able
  // to book an appointment that already happened.
  if (isPastActiveStart(input.status ?? "scheduled", input.scheduledStart)) {
    return "past_start";
  }
  const ok = await validateOrgRefs(organizationId, {
    leadId: input.leadId,
    contactId: input.contactId,
    propertyId: input.propertyId,
    assignedUserId: input.assignedUserId,
  });
  if (!ok) return null;
  // Staff bookings of inspection windows share the concierge's race-safe
  // capacity guard so a rep can't double-book a window the chat (or another
  // rep) just filled. Only active bookings with a defined window are guarded.
  const status = input.status ?? "scheduled";
  if (
    input.type === "inspection" &&
    (status === "scheduled" || status === "confirmed") &&
    input.scheduledStart
  ) {
    const row = await insertInspectionIfAvailable({
      ...input,
      organizationId,
      scheduledStart: input.scheduledStart,
    });
    if (!row) return "conflict";
    if (row.status === "scheduled" || row.status === "confirmed") {
      await scheduleAppointmentReminder(organizationId, row);
    }
    return row;
  }
  const [row] = await db
    .insert(appointmentsTable)
    .values({ ...input, organizationId })
    .returning();
  if (row && (row.status === "scheduled" || row.status === "confirmed")) {
    await scheduleAppointmentReminder(organizationId, row);
  }
  return row;
}

export async function updateAppointment(
  organizationId: string,
  id: string,
  input: Partial<typeof appointmentsTable.$inferInsert>,
): Promise<typeof appointmentsTable.$inferSelect | null | "conflict" | "past_start"> {
  const { organizationId: _ignored, id: _id, ...safe } = input as Record<string, unknown>;
  const ok = await validateOrgRefs(organizationId, {
    leadId: input.leadId,
    contactId: input.contactId,
    propertyId: input.propertyId,
    assignedUserId: input.assignedUserId,
  });
  if (!ok) return null;

  const [existing] = await db
    .select()
    .from(appointmentsTable)
    .where(
      and(
        eq(appointmentsTable.id, id),
        eq(appointmentsTable.organizationId, organizationId),
      ),
    );
  if (!existing) return null;

  // The edit path must not sneak an inspection into a full window: if the
  // result of this update is an active inspection and its window changed —
  // or it wasn't consuming capacity before (cancelled/completed, or a
  // different type) — re-check capacity with the shared guard, excluding
  // this appointment from the conflict count.
  // Guard the *effective next state*: an update may not leave an active
  // (scheduled/confirmed) appointment with a start materially in the past —
  // whether by rescheduling the start backwards or by reactivating a past
  // appointment via a status-only change. Updates that keep or make the
  // appointment inactive (completed/cancelled/no-show history) stay allowed,
  // as do updates that don't touch status or start on an already-inactive
  // past record.
  const effectiveStatus = input.status ?? existing.status;
  const effectiveStart =
    input.scheduledStart !== undefined ? input.scheduledStart : existing.scheduledStart;
  const touchesSchedulingState =
    input.scheduledStart !== undefined || input.status !== undefined;
  if (touchesSchedulingState && isPastActiveStart(effectiveStatus, effectiveStart)) {
    // Exception: pure status churn between the two active states on an
    // appointment that is already active (e.g. confirming a scheduled
    // appointment that just started) is not "slipping in" a past booking.
    const wasActive = existing.status === "scheduled" || existing.status === "confirmed";
    const startUnchanged = input.scheduledStart === undefined;
    if (!(wasActive && startUnchanged)) {
      return "past_start";
    }
  }

  const isActive = (s: string) => s === "scheduled" || s === "confirmed";
  const next = {
    type: input.type ?? existing.type,
    status: input.status ?? existing.status,
    scheduledStart:
      input.scheduledStart !== undefined ? input.scheduledStart : existing.scheduledStart,
    scheduledEnd:
      input.scheduledEnd !== undefined ? input.scheduledEnd : existing.scheduledEnd,
  };
  const wasCounting = existing.type === "inspection" && isActive(existing.status);
  const windowChanged =
    input.scheduledStart !== undefined || input.scheduledEnd !== undefined;
  const needsGuard =
    next.type === "inspection" &&
    isActive(next.status) &&
    next.scheduledStart != null &&
    (windowChanged || !wasCounting);

  let row: typeof appointmentsTable.$inferSelect | null;
  if (needsGuard) {
    const guarded = await updateInspectionIfAvailable(organizationId, id, safe, {
      start: next.scheduledStart!,
      end: next.scheduledEnd,
    });
    if (guarded === "conflict") return "conflict";
    row = guarded;
  } else {
    const [updated] = await db
      .update(appointmentsTable)
      .set(safe)
      .where(
        and(
          eq(appointmentsTable.id, id),
          eq(appointmentsTable.organizationId, organizationId),
        ),
      )
      .returning();
    row = updated ?? null;
  }
  if (row) {
    // Keep the ~24h homeowner reminder in sync: cancelled/completed/no-show
    // appointments must not send stale reminders, and a rescheduled start
    // gets a fresh reminder aligned to the new window.
    if (row.status !== "scheduled" && row.status !== "confirmed") {
      await cancelAppointmentReminders(organizationId, row.id);
      // Outbound webhook mirror: a booked appointment being cancelled is a
      // lifecycle event outside systems care about. Only fire on the actual
      // transition into cancelled, not repeat saves.
      if (row.status === "cancelled" && existing.status !== "cancelled") {
        void dispatchWebhookEvent(organizationId, "appointment.cancelled", {
          appointmentId: row.id,
          leadId: row.leadId ?? null,
          contactId: row.contactId ?? null,
        }).catch(() => {});
      }
    } else if (input.scheduledStart !== undefined) {
      await cancelAppointmentReminders(organizationId, row.id);
      await scheduleAppointmentReminder(organizationId, row);
    }
  }
  return row ?? null;
}

// ---------- users / dashboard / audit ----------

export async function listMembers(organizationId: string) {
  return db
    .select()
    .from(usersTable)
    .where(eq(usersTable.organizationId, organizationId))
    .orderBy(usersTable.createdAt);
}

export async function listAuditEvents(
  organizationId: string,
  filters: { action?: string; since?: Date } = {},
) {
  const conditions = [eq(auditEventsTable.organizationId, organizationId)];
  if (filters.action) {
    conditions.push(eq(auditEventsTable.action, filters.action));
  }
  if (filters.since) {
    conditions.push(gte(auditEventsTable.createdAt, filters.since));
  }
  return db
    .select()
    .from(auditEventsTable)
    .where(and(...conditions))
    .orderBy(desc(auditEventsTable.createdAt))
    .limit(200);
}

const AI_REFERRER_HOSTS = [
  "chatgpt.com",
  "chat.openai.com",
  "perplexity.ai",
  "www.perplexity.ai",
  "claude.ai",
  "gemini.google.com",
  "copilot.microsoft.com",
  "you.com",
];

const SEARCH_REFERRER_HOSTS = [
  "google.",
  "bing.com",
  "duckduckgo.com",
  "search.yahoo.com",
  "search.brave.com",
  "ecosia.org",
];

const SOCIAL_REFERRER_HOSTS = [
  "facebook.com",
  "instagram.com",
  "t.co",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "nextdoor.com",
  "youtube.com",
  "tiktok.com",
];

function referrerHost(referrer: string | null): string {
  if (!referrer) return "direct";
  try {
    return new URL(referrer).hostname.replace(/^www\./, "") || "direct";
  } catch {
    return referrer.slice(0, 100);
  }
}

function categorizeReferrer(host: string): "ai" | "search" | "social" | "direct" | "other" {
  if (host === "direct") return "direct";
  const h = host.toLowerCase();
  if (AI_REFERRER_HOSTS.some((a) => h === a.replace(/^www\./, "") || h.endsWith(`.${a}`))) return "ai";
  if (SEARCH_REFERRER_HOSTS.some((s) => h.includes(s))) return "search";
  if (SOCIAL_REFERRER_HOSTS.some((s) => h === s || h.endsWith(`.${s}`))) return "social";
  return "other";
}

export async function getMarketingSummary(organizationId: string, days: number) {
  const since = sql`now() - make_interval(days => ${days})`;
  const pageViewFilter = and(
    eq(analyticsEventsTable.organizationId, organizationId),
    eq(analyticsEventsTable.eventName, "page_view"),
    sql`${analyticsEventsTable.occurredAt} >= ${since}`,
  );

  const [totals] = await db
    .select({
      views: count(),
      visitors: sql<number>`count(distinct ${analyticsEventsTable.anonymousId})::int`,
    })
    .from(analyticsEventsTable)
    .where(pageViewFilter);

  const landingPages = await db
    .select({
      path: sql<string>`coalesce(${analyticsEventsTable.path}, '/')`,
      views: count(),
      visitors: sql<number>`count(distinct ${analyticsEventsTable.anonymousId})::int`,
    })
    .from(analyticsEventsTable)
    .where(pageViewFilter)
    .groupBy(sql`coalesce(${analyticsEventsTable.path}, '/')`)
    .orderBy(desc(count()))
    .limit(15);

  const rawReferrers = await db
    .select({
      referrer: analyticsEventsTable.referrer,
      views: count(),
    })
    .from(analyticsEventsTable)
    .where(pageViewFilter)
    .groupBy(analyticsEventsTable.referrer);

  // Aggregate by host + category in application code.
  const byHost = new Map<string, { referrer: string; category: ReturnType<typeof categorizeReferrer>; views: number }>();
  for (const row of rawReferrers) {
    const host = referrerHost(row.referrer);
    const existing = byHost.get(host);
    if (existing) existing.views += row.views;
    else byHost.set(host, { referrer: host, category: categorizeReferrer(host), views: row.views });
  }
  const referrers = [...byHost.values()].sort((a, b) => b.views - a.views).slice(0, 20);
  const aiReferralViews = [...byHost.values()]
    .filter((r) => r.category === "ai")
    .reduce((sum, r) => sum + r.views, 0);

  return {
    days,
    totalPageViews: totals.views,
    uniqueVisitors: totals.visitors,
    aiReferralViews,
    landingPages,
    referrers,
  };
}

export async function getDashboardSummary(organizationId: string) {
  const [leadCount] = await db
    .select({ value: count() })
    .from(leadsTable)
    .where(eq(leadsTable.organizationId, organizationId));

  const [taskCount] = await db
    .select({ value: count() })
    .from(crmTasksTable)
    .where(
      and(
        eq(crmTasksTable.organizationId, organizationId),
        eq(crmTasksTable.status, "open"),
      ),
    );

  const [apptCount] = await db
    .select({ value: count() })
    .from(appointmentsTable)
    .where(
      and(
        eq(appointmentsTable.organizationId, organizationId),
        eq(appointmentsTable.status, "scheduled"),
        sql`${appointmentsTable.scheduledStart} > now()`,
      ),
    );

  const leadsByStatus = await db
    .select({ status: leadsTable.status, count: count() })
    .from(leadsTable)
    .where(eq(leadsTable.organizationId, organizationId))
    .groupBy(leadsTable.status);

  const recentActivities = await db
    .select()
    .from(activitiesTable)
    .where(eq(activitiesTable.organizationId, organizationId))
    .orderBy(desc(activitiesTable.occurredAt))
    .limit(10);

  // Leads whose latest homeowner portal message is newer than any other
  // activity on the lead — i.e. the team has not responded since the
  // homeowner last wrote in.
  const unansweredResult = await db.execute<{ value: number }>(sql`
    select count(*)::int as value from (
      select
        ${activitiesTable.leadId} as lead_id,
        max(${activitiesTable.occurredAt}) filter (where ${activitiesTable.type} = 'portal_message') as last_message,
        max(${activitiesTable.occurredAt}) filter (where ${activitiesTable.type} <> 'portal_message') as last_other
      from ${activitiesTable}
      where ${activitiesTable.organizationId} = ${organizationId}
        and ${activitiesTable.leadId} is not null
      group by ${activitiesTable.leadId}
    ) per_lead
    where last_message is not null
      and (last_other is null or last_message > last_other)
  `);

  return {
    totalLeads: leadCount.value,
    openTasks: taskCount.value,
    upcomingAppointments: apptCount.value,
    unansweredPortalMessages: unansweredResult.rows[0]?.value ?? 0,
    leadsByStatus,
    recentActivities,
  };
}

export async function deleteEstimate(organizationId: string, id: string) {
  const rows = await db
    .delete(estimatesTable)
    .where(
      and(eq(estimatesTable.id, id), eq(estimatesTable.organizationId, organizationId)),
    )
    .returning({ id: estimatesTable.id });
  return rows.length > 0;
}

/** Sentinel returned when an estimate is already linked to another project. */
export const DUPLICATE_ESTIMATE = "duplicate_estimate" as const;

/**
 * True when the estimate is already linked to a different project. An
 * estimate can back at most one project; a partial unique index on
 * projects.estimate_id enforces this under concurrency, this pre-check
 * exists to return a friendly error.
 */
async function estimateAlreadyLinked(
  organizationId: string,
  estimateId: string,
  excludeProjectId?: string,
): Promise<boolean> {
  const conditions = [
    eq(projectsTable.organizationId, organizationId),
    eq(projectsTable.estimateId, estimateId),
  ];
  if (excludeProjectId) {
    conditions.push(ne(projectsTable.id, excludeProjectId));
  }
  const [row] = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(and(...conditions))
    .limit(1);
  return Boolean(row);
}

function isUniqueEstimateViolation(error: unknown): boolean {
  const err = error as { code?: string; constraint?: string } | null;
  return (
    err?.code === "23505" &&
    (err.constraint === undefined ||
      err.constraint === "projects_estimate_unique_idx")
  );
}

export async function updateProject(
  organizationId: string,
  id: string,
  input: {
    estimateId?: string | null;
    name?: string;
    status?: typeof projectsTable.$inferSelect.status;
    scheduledStart?: Date | null;
    scheduledEnd?: Date | null;
    crewUserIds?: string[];
    crewNotes?: string | null;
  },
) {
  const existing = await getProject(organizationId, id);
  if (!existing) return null;
  const ok = await validateProjectRefs(organizationId, {
    estimateId: input.estimateId,
    crewUserIds: input.crewUserIds,
  });
  if (!ok) return null;
  if (
    input.estimateId &&
    (await estimateAlreadyLinked(organizationId, input.estimateId, id))
  ) {
    return DUPLICATE_ESTIMATE;
  }

  const patch: Record<string, unknown> = {};
  if (input.estimateId !== undefined) patch.estimateId = input.estimateId;
  if (input.name !== undefined) patch.name = input.name;
  if (input.scheduledStart !== undefined) patch.scheduledStart = input.scheduledStart;
  if (input.scheduledEnd !== undefined) patch.scheduledEnd = input.scheduledEnd;
  if (input.crewUserIds !== undefined) patch.crewUserIds = input.crewUserIds;
  if (input.crewNotes !== undefined) patch.crewNotes = input.crewNotes;
  if (input.status !== undefined && input.status !== existing.status) {
    patch.status = input.status;
    if (input.status === "completed" && !existing.completedAt) {
      patch.completedAt = new Date();
    }
  }

  try {
    const [row] = await db
      .update(projectsTable)
      .set(patch)
      .where(
        and(eq(projectsTable.id, id), eq(projectsTable.organizationId, organizationId)),
      )
      .returning();
    return row ?? null;
  } catch (error) {
    // Concurrent link raced past the pre-check; the unique index caught it.
    if (isUniqueEstimateViolation(error)) return DUPLICATE_ESTIMATE;
    throw error;
  }
}

interface EstimateLineItemInput {
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
}

export async function createProject(
  organizationId: string,
  input: {
    leadId: string;
    estimateId?: string | null;
    name: string;
    status?: typeof projectsTable.$inferSelect.status;
    scheduledStart?: Date | null;
    scheduledEnd?: Date | null;
    crewUserIds?: string[];
    crewNotes?: string | null;
  },
) {
  const ok = await validateProjectRefs(organizationId, {
    leadId: input.leadId,
    estimateId: input.estimateId,
    crewUserIds: input.crewUserIds,
  });
  if (!ok) return null;
  if (
    input.estimateId &&
    (await estimateAlreadyLinked(organizationId, input.estimateId))
  ) {
    return DUPLICATE_ESTIMATE;
  }
  const status = input.status ?? "scheduled";
  try {
    const [row] = await db
      .insert(projectsTable)
      .values({
        organizationId,
        leadId: input.leadId,
        estimateId: input.estimateId ?? null,
        name: input.name,
        status,
        scheduledStart: input.scheduledStart ?? null,
        scheduledEnd: input.scheduledEnd ?? null,
        crewUserIds: input.crewUserIds ?? [],
        crewNotes: input.crewNotes ?? null,
        completedAt: status === "completed" ? new Date() : null,
      })
      .returning();
    return row;
  } catch (error) {
    // Concurrent create raced past the pre-check; the unique index caught it.
    if (isUniqueEstimateViolation(error)) return DUPLICATE_ESTIMATE;
    throw error;
  }
}

export async function deleteProject(organizationId: string, id: string) {
  const rows = await db
    .delete(projectsTable)
    .where(
      and(eq(projectsTable.id, id), eq(projectsTable.organizationId, organizationId)),
    )
    .returning({ id: projectsTable.id });
  return rows.length > 0;
}

function computeEstimateTotals(lineItems: EstimateLineItemInput[], taxCents: number) {
  const subtotalCents = lineItems.reduce(
    (sum, item) => sum + Math.round(item.quantity * item.unitPriceCents),
    0,
  );
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

export async function getEstimate(organizationId: string, id: string) {
  const [row] = await db
    .select()
    .from(estimatesTable)
    .where(
      and(eq(estimatesTable.id, id), eq(estimatesTable.organizationId, organizationId)),
    );
  return row ?? null;
}

/**
 * Reject negative pricing inputs before totals are computed. A negative
 * quantity, unit price, or tax would produce a negative subtotal/total and
 * misprice a job; the request schema enforces minimum bounds too, but the
 * service re-validates for direct callers.
 */
function validateEstimateAmounts(
  lineItems: EstimateLineItemInput[],
  taxCents: number,
): boolean {
  if (taxCents < 0 || !Number.isFinite(taxCents)) return false;
  return lineItems.every(
    (item) =>
      Number.isFinite(item.quantity) &&
      item.quantity >= 0 &&
      Number.isFinite(item.unitPriceCents) &&
      item.unitPriceCents >= 0,
  );
}
function normalizeLineItems(lineItems: EstimateLineItemInput[]) {
  return lineItems.map((item) => ({
    ...item,
    totalCents: Math.round(item.quantity * item.unitPriceCents),
  }));
}

export async function updateEstimate(
  organizationId: string,
  id: string,
  input: {
    title?: string;
    status?: typeof estimatesTable.$inferSelect.status;
    lineItems?: EstimateLineItemInput[];
    taxCents?: number;
    notes?: string | null;
  },
) {
  const existing = await getEstimate(organizationId, id);
  if (!existing) return null;

  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.lineItems !== undefined || input.taxCents !== undefined) {
    const rawLineItems = input.lineItems ?? existing.lineItems;
    const taxCents = input.taxCents ?? existing.taxCents;
    if (!validateEstimateAmounts(rawLineItems, taxCents)) return null;
    const lineItems = normalizeLineItems(rawLineItems);
    const totals = computeEstimateTotals(lineItems, taxCents);
    patch.lineItems = lineItems;
    patch.subtotalCents = totals.subtotalCents;
    patch.taxCents = totals.taxCents;
    patch.totalCents = totals.totalCents;
  }
  if (input.status !== undefined && input.status !== existing.status) {
    patch.status = input.status;
    if (input.status === "sent" && !existing.sentAt) patch.sentAt = new Date();
    if (input.status === "accepted" && !existing.acceptedAt) {
      patch.acceptedAt = new Date();
    }
  }

  const [row] = await db
    .update(estimatesTable)
    .set(patch)
    .where(
      and(eq(estimatesTable.id, id), eq(estimatesTable.organizationId, organizationId)),
    )
    .returning();
  return row ?? null;
}

async function validateProjectRefs(
  organizationId: string,
  refs: { leadId?: string | null; estimateId?: string | null; crewUserIds?: string[] },
): Promise<boolean> {
  if (refs.leadId && !(await validateOrgRefs(organizationId, { leadId: refs.leadId }))) {
    return false;
  }
  if (refs.estimateId) {
    const estimate = await getEstimate(organizationId, refs.estimateId);
    if (!estimate) return false;
  }
  for (const userId of refs.crewUserIds ?? []) {
    if (!(await validateOrgRefs(organizationId, { assignedUserId: userId }))) {
      return false;
    }
  }
  return true;
}

export async function listProjects(
  organizationId: string,
  filters: { leadId?: string; status?: string } = {},
) {
  const conditions = [eq(projectsTable.organizationId, organizationId)];
  if (filters.leadId) {
    conditions.push(eq(projectsTable.leadId, filters.leadId));
  }
  if (filters.status) {
    conditions.push(
      eq(
        projectsTable.status,
        filters.status as typeof projectsTable.$inferSelect.status,
      ),
    );
  }
  const rows = await db
    .select({
      project: projectsTable,
      leadSummary: leadsTable.summary,
      contactFirstName: contactsTable.firstName,
      contactLastName: contactsTable.lastName,
    })
    .from(projectsTable)
    .leftJoin(leadsTable, eq(projectsTable.leadId, leadsTable.id))
    .leftJoin(contactsTable, eq(leadsTable.contactId, contactsTable.id))
    .where(and(...conditions))
    .orderBy(desc(projectsTable.createdAt))
    .limit(200);
  return rows.map((row) => ({
    ...row.project,
    leadLabel: buildLeadLabel(row),
  }));
}

export async function createEstimate(
  organizationId: string,
  input: {
    leadId: string;
    title: string;
    status?: typeof estimatesTable.$inferSelect.status;
    lineItems?: EstimateLineItemInput[];
    taxCents?: number;
    notes?: string | null;
  },
) {
  if (!(await validateOrgRefs(organizationId, { leadId: input.leadId }))) {
    return null;
  }
  if (!validateEstimateAmounts(input.lineItems ?? [], input.taxCents ?? 0)) {
    return null;
  }
  const lineItems = normalizeLineItems(input.lineItems ?? []);
  const totals = computeEstimateTotals(lineItems, input.taxCents ?? 0);
  const status = input.status ?? "draft";
  const [row] = await db
    .insert(estimatesTable)
    .values({
      organizationId,
      leadId: input.leadId,
      title: input.title,
      status,
      lineItems,
      ...totals,
      notes: input.notes ?? null,
      sentAt: status === "sent" ? new Date() : null,
      acceptedAt: status === "accepted" ? new Date() : null,
    })
    .returning();
  return row;
}

export async function getProject(organizationId: string, id: string) {
  const [row] = await db
    .select()
    .from(projectsTable)
    .where(
      and(eq(projectsTable.id, id), eq(projectsTable.organizationId, organizationId)),
    );
  return row ?? null;
}
