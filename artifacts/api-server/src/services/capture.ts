import { randomBytes } from "node:crypto";

import {
  CAPTURE_TARGET_FIELDS,
  activitiesTable,
  captureDeliveriesTable,
  captureEndpointsTable,
  contactsTable,
  db,
  leadsTable,
  type CaptureEndpoint,
  type CaptureFieldMapping,
  type CaptureTargetField,
} from "@workspace/db";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";

import { emitAutomationEvent } from "./automation";
import {
  buildTouch,
  leadAttributionColumns,
  repeatTouchColumns,
} from "./attribution";

const OPEN_LEAD_STATUSES = ["new", "contacted", "qualified", "nurture", "follow_up"];

// ---------- endpoint CRUD (org-scoped) ----------

export function generateCaptureToken(): string {
  return `cap_${randomBytes(18).toString("hex")}`;
}

export function sanitizeMapping(raw: unknown): CaptureFieldMapping | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const mapping: CaptureFieldMapping = {};
  for (const [external, target] of Object.entries(raw as Record<string, unknown>)) {
    const ext = String(external).trim().slice(0, 200);
    if (!ext) continue;
    if (
      typeof target !== "string" ||
      !CAPTURE_TARGET_FIELDS.includes(target as CaptureTargetField)
    ) {
      return null;
    }
    mapping[ext] = target;
  }
  return mapping;
}

export async function listCaptureEndpoints(organizationId: string) {
  return db
    .select()
    .from(captureEndpointsTable)
    .where(eq(captureEndpointsTable.organizationId, organizationId))
    .orderBy(desc(captureEndpointsTable.createdAt));
}

export async function createCaptureEndpoint(
  organizationId: string,
  input: { name: string; mapping: CaptureFieldMapping; defaultSource?: string },
) {
  const [row] = await db
    .insert(captureEndpointsTable)
    .values({
      organizationId,
      name: input.name.trim().slice(0, 200),
      token: generateCaptureToken(),
      mapping: input.mapping,
      defaultSource: (input.defaultSource?.trim() || "external-form").slice(0, 100),
    })
    .returning();
  return row;
}

export async function updateCaptureEndpoint(
  organizationId: string,
  id: string,
  input: {
    name?: string;
    mapping?: CaptureFieldMapping;
    defaultSource?: string;
    isActive?: boolean;
  },
) {
  const set: Record<string, unknown> = {};
  if (input.name !== undefined) set.name = input.name.trim().slice(0, 200);
  if (input.mapping !== undefined) set.mapping = input.mapping;
  if (input.defaultSource !== undefined) {
    set.defaultSource = (input.defaultSource.trim() || "external-form").slice(0, 100);
  }
  if (input.isActive !== undefined) set.isActive = input.isActive;
  if (Object.keys(set).length === 0) return null;
  const [row] = await db
    .update(captureEndpointsTable)
    .set(set)
    .where(
      and(
        eq(captureEndpointsTable.id, id),
        eq(captureEndpointsTable.organizationId, organizationId),
      ),
    )
    .returning();
  return row ?? null;
}

export async function deleteCaptureEndpoint(organizationId: string, id: string) {
  const rows = await db
    .update(captureEndpointsTable)
    .set({ isActive: false })
    .where(
      and(
        eq(captureEndpointsTable.id, id),
        eq(captureEndpointsTable.organizationId, organizationId),
      ),
    )
    .returning({ id: captureEndpointsTable.id });
  return rows.length > 0;
}

export async function getEndpointByToken(token: string): Promise<CaptureEndpoint | null> {
  const [row] = await db
    .select()
    .from(captureEndpointsTable)
    .where(and(eq(captureEndpointsTable.token, token), eq(captureEndpointsTable.isActive, true)));
  return row ?? null;
}

// ---------- field mapping ----------

export interface MappedLeadFields {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  message: string | null;
  source: string | null;
  campaign: string | null;
  externalId: string | null;
  /** External fields present in the payload but not covered by the mapping. */
  unmapped: string[];
}

function asText(value: unknown, max = 500): string | null {
  if (value === null || value === undefined) return null;
  const s = (typeof value === "string" ? value : String(value)).trim();
  return s ? s.slice(0, max) : null;
}

/**
 * Apply an endpoint's mapping to a raw external payload (flat JSON object or
 * form-encoded body). Pure — also powers the admin test-payload preview.
 */
export function applyMapping(
  mapping: CaptureFieldMapping,
  payload: Record<string, unknown>,
): MappedLeadFields {
  const out: MappedLeadFields = {
    firstName: null,
    lastName: null,
    email: null,
    phone: null,
    addressLine1: null,
    city: null,
    state: null,
    postalCode: null,
    message: null,
    source: null,
    campaign: null,
    externalId: null,
    unmapped: [],
  };
  const mappedKeys = new Set(Object.keys(mapping));
  for (const [external, target] of Object.entries(mapping)) {
    const value = payload[external];
    if (value === undefined) continue;
    if (target === "fullName") {
      const full = asText(value, 200);
      if (full && !out.firstName) {
        const [first, ...rest] = full.split(/\s+/);
        out.firstName = first;
        if (rest.length && !out.lastName) out.lastName = rest.join(" ");
      }
      continue;
    }
    if (target === "message") {
      out.message = asText(value, 4000);
      continue;
    }
    (out as unknown as Record<string, string | null>)[target] = asText(value);
  }
  for (const key of Object.keys(payload)) {
    if (!mappedKeys.has(key) && !key.startsWith("_")) out.unmapped.push(key);
  }
  out.unmapped = out.unmapped.slice(0, 50);
  return out;
}

// ---------- inbound capture ----------

export type CaptureResult =
  | { ok: true; leadId: string; outcome: "created" | "merged"; duplicateDelivery: boolean }
  | { ok: false; error: string };

/**
 * Capture one external submission into the standard pipeline: map fields,
 * dedupe contact by normalized email/phone, dedupe into an open lead
 * (repeat-touch) or create a new one with full attribution, record the
 * delivery, and emit lead.created so scoring/playbooks/webhooks fire.
 *
 * Idempotency: when the caller supplies a key, a duplicate delivery replays
 * the original outcome instead of touching the CRM again.
 */
export async function captureExternalLead(
  endpoint: CaptureEndpoint,
  payload: Record<string, unknown>,
  opts: { idempotencyKey?: string | null } = {},
): Promise<CaptureResult> {
  const organizationId = endpoint.organizationId;
  const idempotencyKey = asText(opts.idempotencyKey, 200);

  // Reserve-first idempotency: exactly one delivery with a given key wins the
  // insert (partial unique index) and performs the work; concurrent or later
  // duplicates replay the stored outcome instead of re-executing side effects.
  if (idempotencyKey) {
    const reserved = await db
      .insert(captureDeliveriesTable)
      .values({
        organizationId,
        endpointId: endpoint.id,
        idempotencyKey,
        leadId: null,
        outcome: "pending",
        detail: null,
      })
      .onConflictDoNothing()
      .returning({ id: captureDeliveriesTable.id });
    if (reserved.length === 0) {
      // Someone else owns this key — replay their outcome (poll briefly in
      // case they are still mid-flight).
      for (let i = 0; i < 20; i++) {
        const [existing] = await db
          .select()
          .from(captureDeliveriesTable)
          .where(
            and(
              eq(captureDeliveriesTable.endpointId, endpoint.id),
              eq(captureDeliveriesTable.idempotencyKey, idempotencyKey),
            ),
          );
        if (!existing) break; // owner failed and released; fall through to work
        if (existing.outcome !== "pending") {
          if (existing.outcome === "rejected" || !existing.leadId) {
            return { ok: false, error: existing.detail ?? "rejected" };
          }
          return {
            ok: true,
            leadId: existing.leadId,
            outcome: existing.outcome as "created" | "merged",
            duplicateDelivery: true,
          };
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      return { ok: false, error: "Duplicate delivery still processing — retry shortly" };
    }
    try {
      return await runCapture(endpoint, payload, idempotencyKey);
    } catch (err) {
      // Release the reservation so the sender's retry can run the work.
      await db
        .delete(captureDeliveriesTable)
        .where(
          and(
            eq(captureDeliveriesTable.endpointId, endpoint.id),
            eq(captureDeliveriesTable.idempotencyKey, idempotencyKey),
            eq(captureDeliveriesTable.outcome, "pending"),
          ),
        )
        .catch(() => {});
      throw err;
    }
  }
  return runCapture(endpoint, payload, null);
}

/** The actual capture work; delivery-idempotency is handled by the caller. */
async function runCapture(
  endpoint: CaptureEndpoint,
  payload: Record<string, unknown>,
  idempotencyKey: string | null,
): Promise<CaptureResult> {
  const organizationId = endpoint.organizationId;
  const fields = applyMapping(endpoint.mapping, payload);
  const email = fields.email?.toLowerCase() ?? null;
  const phone = fields.phone ? fields.phone.replace(/[^\d+]/g, "") : null;
  if (!email && !phone) {
    await recordDelivery(endpoint, idempotencyKey, null, "rejected", "no email or phone after mapping");
    return { ok: false, error: "Mapped payload has no email or phone" };
  }

  const source = fields.source || endpoint.defaultSource;
  const touch = buildTouch({
    channel: "capture",
    source,
    attribution: { utmCampaign: fields.campaign ?? undefined },
  });

  const result = await db.transaction(async (tx) => {
    // Contact dedupe by normalized email/phone within the org.
    const matchers = [];
    if (email) matchers.push(sql`lower(${contactsTable.email}) = ${email}`);
    if (phone) {
      matchers.push(
        sql`regexp_replace(coalesce(${contactsTable.phone}, ''), '[^0-9+]', '', 'g') = ${phone}`,
      );
    }
    const [existingContact] = await tx
      .select()
      .from(contactsTable)
      .where(and(eq(contactsTable.organizationId, organizationId), or(...matchers)))
      .limit(1);

    let contactId: string;
    if (existingContact) {
      contactId = existingContact.id;
    } else {
      const [contact] = await tx
        .insert(contactsTable)
        .values({
          organizationId,
          firstName: fields.firstName ?? "Unknown",
          lastName: fields.lastName,
          email: fields.email,
          phone: fields.phone,
        })
        .returning();
      contactId = contact.id;
    }

    // Lead dedupe: a live lead for this contact absorbs the touch.
    const [openLead] = existingContact
      ? await tx
          .select()
          .from(leadsTable)
          .where(
            and(
              eq(leadsTable.organizationId, organizationId),
              eq(leadsTable.contactId, contactId),
              inArray(leadsTable.status, OPEN_LEAD_STATUSES as never[]),
            ),
          )
          .limit(1)
      : [];

    if (openLead) {
      await tx
        .update(leadsTable)
        .set(repeatTouchColumns({ source, touch, existing: openLead }))
        .where(eq(leadsTable.id, openLead.id));
      return { leadId: openLead.id, contactId, outcome: "merged" as const };
    }

    const [lead] = await tx
      .insert(leadsTable)
      .values({
        organizationId,
        contactId,
        status: "new",
        summary: fields.message,
        sourceDetail: fields.externalId,
        ...leadAttributionColumns({ source, creationMethod: "capture", touch }),
      })
      .returning();
    return { leadId: lead.id, contactId, outcome: "created" as const };
  });

  await db.insert(activitiesTable).values({
    organizationId,
    leadId: result.leadId,
    contactId: result.contactId,
    type: "lead_captured",
    title: `Captured from "${endpoint.name}"`,
    body: fields.message,
    metadata: { captureEndpointId: endpoint.id, source },
  });
  await recordDelivery(endpoint, idempotencyKey, result.leadId, result.outcome, null);
  await db
    .update(captureEndpointsTable)
    .set({
      lastReceivedAt: new Date(),
      receivedCount: sql`${captureEndpointsTable.receivedCount} + 1`,
    })
    .where(eq(captureEndpointsTable.id, endpoint.id));

  if (result.outcome === "created") {
    emitAutomationEvent(organizationId, "lead.created", {
      leadId: result.leadId,
      contactId: result.contactId,
      fields: { "lead.status": "new", "lead.source": source },
    });
  }
  return { ok: true, leadId: result.leadId, outcome: result.outcome, duplicateDelivery: false };
}

async function recordDelivery(
  endpoint: CaptureEndpoint,
  idempotencyKey: string | null,
  leadId: string | null,
  outcome: string,
  detail: string | null,
) {
  try {
    if (idempotencyKey) {
      // Fill in the reservation made by captureExternalLead (reserve-first
      // idempotency) so duplicates replay the real outcome.
      await db
        .update(captureDeliveriesTable)
        .set({ leadId, outcome, detail })
        .where(
          and(
            eq(captureDeliveriesTable.endpointId, endpoint.id),
            eq(captureDeliveriesTable.idempotencyKey, idempotencyKey),
            eq(captureDeliveriesTable.outcome, "pending"),
          ),
        );
    } else {
      await db.insert(captureDeliveriesTable).values({
        organizationId: endpoint.organizationId,
        endpointId: endpoint.id,
        idempotencyKey,
        leadId,
        outcome,
        detail,
      });
    }
  } catch (err) {
    console.error("[capture] failed to record delivery:", err);
  }
}

export async function listRecentDeliveries(organizationId: string, endpointId?: string) {
  const scope = eq(captureDeliveriesTable.organizationId, organizationId);
  return db
    .select()
    .from(captureDeliveriesTable)
    .where(endpointId ? and(scope, eq(captureDeliveriesTable.endpointId, endpointId)) : scope)
    .orderBy(desc(captureDeliveriesTable.createdAt))
    .limit(100);
}
