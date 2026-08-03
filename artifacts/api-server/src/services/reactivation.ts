import {
  activitiesTable,
  appointmentsTable,
  contactsTable,
  db,
  leadImportsTable,
  leadsTable,
  playbookEnrollmentsTable,
  playbooksTable,
  reactivationCampaignLeadsTable,
  reactivationCampaignsTable,
  suppressionsTable,
  type LeadImport,
  type Playbook,
  type ReactivationCampaign,
  type ReactivationSegment,
} from "@workspace/db";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";

import { recordAudit } from "./audit";
import { OUTREACH_ACTIVE_STATUSES, enrollLead, stopEnrollmentsForLead } from "./playbooks";
import { draftOutreachMessage } from "./providers";
import { normalizeAddress } from "./send-gate";
import { getOrgSettings } from "./settings";

/**
 * Cold-lead reactivation: CSV lead import, segment building over stale
 * leads, and throttled win-back campaigns that drain a segment snapshot
 * into a playbook at an org-configured rate. Every send still passes the
 * unified pre-send gate inside the playbook engine.
 */

// ---------------------------------------------------------------------------
// CSV parsing (RFC 4180-ish, dependency-free)
// ---------------------------------------------------------------------------

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

// ---------------------------------------------------------------------------
// Lead import
// ---------------------------------------------------------------------------

/** Fields a CSV column can map to. */
export const IMPORT_FIELDS = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "addressLine1",
  "city",
  "state",
  "postalCode",
  "status",
  "source",
  "serviceType",
  "notes",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

const VALID_STATUSES = new Set([
  "new",
  "contact_attempted",
  "inspection_scheduled",
  "inspection_completed",
  "estimate_preparing",
  "estimate_sent",
  "claim_pending",
  "follow_up",
  "won",
  "completed",
  "nurture",
  "lost",
]);

const MAX_IMPORT_ROWS = 10_000;
const MAX_ERROR_SAMPLES = 20;

function clean(v: string | undefined, max = 200): string | null {
  const s = (v ?? "").trim();
  return s ? s.slice(0, max) : null;
}

export async function importLeads(
  organizationId: string,
  params: {
    csv: string;
    /** Map of import field → 0-based CSV column index. */
    mapping: Partial<Record<ImportField, number>>;
    fileName?: string;
    hasHeader?: boolean;
    defaultStatus?: string;
    defaultSource?: string;
    createdByUserId?: string | null;
  },
): Promise<LeadImport | { error: string }> {
  const all = parseCsv(params.csv);
  const rows = params.hasHeader === false ? all : all.slice(1);
  if (rows.length === 0) return { error: "No data rows found in the file" };
  if (rows.length > MAX_IMPORT_ROWS) {
    return { error: `Too many rows (max ${MAX_IMPORT_ROWS})` };
  }
  const m = params.mapping;
  if (m.firstName === undefined) return { error: "A First name column mapping is required" };
  if (m.email === undefined && m.phone === undefined) {
    return { error: "Map at least an Email or Phone column" };
  }
  const defaultStatus = VALID_STATUSES.has(params.defaultStatus ?? "")
    ? (params.defaultStatus as string)
    : "nurture";
  const source = clean(params.defaultSource, 100) ?? "csv-import";

  let imported = 0;
  let duplicates = 0;
  let skipped = 0;
  let suppressedCount = 0;
  const errors: string[] = [];

  // Suppression list snapshot for flagging (send gate re-checks at send time).
  const suppressions = await db
    .select({ channel: suppressionsTable.channel, value: suppressionsTable.value })
    .from(suppressionsTable)
    .where(eq(suppressionsTable.organizationId, organizationId));
  const suppressedSet = new Set(suppressions.map((s) => `${s.channel}:${s.value}`));

  // Dedupe within the file too.
  const seenInFile = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const get = (f: ImportField) => (m[f] === undefined ? undefined : row[m[f]!]);
    const firstName = clean(get("firstName"), 100);
    const email = clean(get("email"), 200)?.toLowerCase() ?? null;
    const phone = clean(get("phone"), 40);
    const phoneDigits = phone ? phone.replace(/\D/g, "") : null;
    const rowNo = i + (params.hasHeader === false ? 1 : 2);

    if (!firstName) {
      skipped++;
      if (errors.length < MAX_ERROR_SAMPLES) errors.push(`Row ${rowNo}: missing first name`);
      continue;
    }
    if (!email && (!phoneDigits || phoneDigits.length < 7)) {
      skipped++;
      if (errors.length < MAX_ERROR_SAMPLES) {
        errors.push(`Row ${rowNo}: needs a valid email or phone`);
      }
      continue;
    }

    const fileKey = email ?? `p:${phoneDigits}`;
    if (seenInFile.has(fileKey)) {
      duplicates++;
      continue;
    }
    seenInFile.add(fileKey);

    // Dedupe against existing contacts by email/phone.
    const matchConds = [];
    if (email) matchConds.push(sql`lower(${contactsTable.email}) = ${email}`);
    if (phoneDigits && phoneDigits.length >= 7) {
      matchConds.push(
        sql`regexp_replace(coalesce(${contactsTable.phone}, ''), '\\D', '', 'g') = ${phoneDigits}`,
      );
    }
    const [existing] = await db
      .select({ id: contactsTable.id })
      .from(contactsTable)
      .where(and(eq(contactsTable.organizationId, organizationId), or(...matchConds)))
      .limit(1);
    if (existing) {
      duplicates++;
      continue;
    }

    const isSuppressed =
      (email && suppressedSet.has(`email:${normalizeAddress("email", email)}`)) ||
      (phone && suppressedSet.has(`sms:${normalizeAddress("sms", phone)}`));
    if (isSuppressed) suppressedCount++;

    const rawStatus = clean(get("status"), 40);
    const status = rawStatus && VALID_STATUSES.has(rawStatus) ? rawStatus : defaultStatus;

    try {
      await db.transaction(async (tx) => {
        const [contact] = await tx
          .insert(contactsTable)
          .values({
            organizationId,
            firstName,
            lastName: clean(get("lastName"), 100),
            email,
            phone,
          })
          .returning();
        await tx.insert(leadsTable).values({
          organizationId,
          contactId: contact.id,
          status: status as typeof leadsTable.$inferSelect.status,
          serviceType: clean(get("serviceType"), 100),
          summary: clean(get("notes"), 500),
          source: clean(get("source"), 100) ?? source,
          latestSource: clean(get("source"), 100) ?? source,
          creationMethod: "import",
        });
      });
      imported++;
    } catch {
      skipped++;
      if (errors.length < MAX_ERROR_SAMPLES) errors.push(`Row ${rowNo}: failed to save`);
    }
  }

  const [record] = await db
    .insert(leadImportsTable)
    .values({
      organizationId,
      fileName: clean(params.fileName, 200),
      totalRows: rows.length,
      imported,
      duplicates,
      skipped,
      suppressed: suppressedCount,
      errors,
      createdByUserId: params.createdByUserId ?? null,
    })
    .returning();
  await recordAudit({
    organizationId,
    actorUserId: params.createdByUserId ?? null,
    action: "leads.imported",
    entityType: "lead_import",
    entityId: record.id,
    metadata: { imported, duplicates, skipped },
  });
  return record;
}

export async function listImports(organizationId: string): Promise<LeadImport[]> {
  return db
    .select()
    .from(leadImportsTable)
    .where(eq(leadImportsTable.organizationId, organizationId))
    .orderBy(desc(leadImportsTable.createdAt))
    .limit(50);
}

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

function sanitizeSegment(input: unknown): ReactivationSegment {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const seg: ReactivationSegment = {};
  if (Array.isArray(raw.statuses)) {
    seg.statuses = raw.statuses
      .filter((s): s is string => typeof s === "string" && VALID_STATUSES.has(s))
      .slice(0, 20);
  }
  if (typeof raw.minAgeDays === "number" && raw.minAgeDays > 0) {
    seg.minAgeDays = Math.min(Math.floor(raw.minAgeDays), 3650);
  }
  if (typeof raw.inactiveDays === "number" && raw.inactiveDays > 0) {
    seg.inactiveDays = Math.min(Math.floor(raw.inactiveDays), 3650);
  }
  if (Array.isArray(raw.sources)) {
    seg.sources = raw.sources
      .filter((s): s is string => typeof s === "string" && s.length <= 100)
      .slice(0, 20);
  }
  return seg;
}

function segmentConditions(organizationId: string, seg: ReactivationSegment) {
  const conds = [eq(leadsTable.organizationId, organizationId)];
  if (seg.statuses && seg.statuses.length > 0) {
    conds.push(
      inArray(leadsTable.status, seg.statuses as (typeof leadsTable.$inferSelect.status)[]),
    );
  }
  if (seg.minAgeDays) {
    conds.push(lt(leadsTable.createdAt, new Date(Date.now() - seg.minAgeDays * 86_400_000)));
  }
  if (seg.inactiveDays) {
    const cutoff = new Date(Date.now() - seg.inactiveDays * 86_400_000);
    conds.push(
      sql`NOT EXISTS (
        SELECT 1 FROM ${activitiesTable}
        WHERE ${activitiesTable.leadId} = ${leadsTable.id}
          AND ${activitiesTable.organizationId} = ${leadsTable.organizationId}
          AND ${activitiesTable.occurredAt} > ${cutoff}
      )`,
    );
  }
  if (seg.sources && seg.sources.length > 0) {
    conds.push(inArray(leadsTable.source, seg.sources));
  }
  // Leads already in a live sequence are excluded up front.
  conds.push(
    sql`NOT EXISTS (
      SELECT 1 FROM ${playbookEnrollmentsTable}
      WHERE ${playbookEnrollmentsTable.leadId} = ${leadsTable.id}
        AND ${playbookEnrollmentsTable.status} IN ('active','paused')
    )`,
  );
  return conds;
}

export interface SegmentPreview {
  segment: ReactivationSegment;
  count: number;
  sample: {
    id: string;
    contactName: string | null;
    status: string;
    source: string | null;
    createdAt: string;
  }[];
}

export async function previewSegment(
  organizationId: string,
  segmentInput: unknown,
): Promise<SegmentPreview> {
  const segment = sanitizeSegment(segmentInput);
  const conds = segmentConditions(organizationId, segment);
  const [{ value: count }] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(leadsTable)
    .where(and(...conds));
  const sample = await db
    .select({
      id: leadsTable.id,
      firstName: contactsTable.firstName,
      lastName: contactsTable.lastName,
      status: leadsTable.status,
      source: leadsTable.source,
      createdAt: leadsTable.createdAt,
    })
    .from(leadsTable)
    .leftJoin(contactsTable, eq(leadsTable.contactId, contactsTable.id))
    .where(and(...conds))
    .orderBy(desc(leadsTable.createdAt))
    .limit(5);
  return {
    segment,
    count: Number(count),
    sample: sample.map((s) => ({
      id: s.id,
      contactName: [s.firstName, s.lastName].filter(Boolean).join(" ") || null,
      status: s.status,
      source: s.source,
      createdAt: s.createdAt.toISOString(),
    })),
  };
}

/** Recommended win-back segments with live counts. */
export async function recommendedSegments(organizationId: string) {
  const presets: { key: string; name: string; description: string; segment: ReactivationSegment }[] = [
    {
      key: "never_contacted",
      name: "Never contacted",
      description: "Leads that came in over 30 days ago and never got past first contact.",
      segment: { statuses: ["new", "contact_attempted"], minAgeDays: 30 },
    },
    {
      key: "estimate_no_decision",
      name: "Estimate sent, no decision",
      description: "An estimate went out but the homeowner went quiet for 3+ weeks.",
      segment: { statuses: ["estimate_sent"], inactiveDays: 21 },
    },
    {
      key: "lost",
      name: "Lost to timing or price",
      description: "Marked lost — circumstances change; a friendly check-in can revive them.",
      segment: { statuses: ["lost"], minAgeDays: 60 },
    },
    {
      key: "past_customers",
      name: "Past customers",
      description: "Completed jobs — a maintenance or referral touch keeps you top of mind.",
      segment: { statuses: ["completed", "won"], inactiveDays: 180 },
    },
    {
      key: "gone_quiet",
      name: "Gone quiet",
      description: "Follow-up or nurture leads with no activity in the last 30 days.",
      segment: { statuses: ["follow_up", "nurture"], inactiveDays: 30 },
    },
  ];
  const out = [];
  for (const p of presets) {
    const conds = segmentConditions(organizationId, p.segment);
    const [{ value }] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(leadsTable)
      .where(and(...conds));
    out.push({ ...p, count: Number(value) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

const MAX_CAMPAIGN_LEADS = 10_000;
const MAX_ENROLL_PER_TICK = 25;

async function getOrgPlaybook(
  organizationId: string,
  playbookId: string,
): Promise<Playbook | null> {
  const [pb] = await db
    .select()
    .from(playbooksTable)
    .where(and(eq(playbooksTable.id, playbookId), eq(playbooksTable.organizationId, organizationId)));
  return pb ?? null;
}

export async function createCampaign(
  organizationId: string,
  params: {
    name: string;
    playbookId: string;
    segment: unknown;
    ratePerHour?: number;
    createdByUserId?: string | null;
  },
): Promise<ReactivationCampaign | { error: string }> {
  const name = clean(params.name, 200);
  if (!name) return { error: "Campaign name is required" };
  const playbook = await getOrgPlaybook(organizationId, params.playbookId);
  if (!playbook) return { error: "Playbook not found" };
  if (playbook.steps.length === 0) return { error: "Playbook has no steps" };
  const rate = Math.min(Math.max(Math.floor(params.ratePerHour ?? 20), 1), 500);
  const [row] = await db
    .insert(reactivationCampaignsTable)
    .values({
      organizationId,
      name,
      playbookId: playbook.id,
      segment: sanitizeSegment(params.segment),
      ratePerHour: rate,
      createdByUserId: params.createdByUserId ?? null,
    })
    .returning();
  return row;
}

export async function launchCampaign(
  organizationId: string,
  campaignId: string,
): Promise<ReactivationCampaign | { error: string }> {
  const campaign = await getCampaignRow(organizationId, campaignId);
  if (!campaign) return { error: "Campaign not found" };
  if (campaign.status !== "draft") return { error: `Campaign is ${campaign.status}` };

  const conds = segmentConditions(organizationId, campaign.segment);
  const leads = await db
    .select({ id: leadsTable.id, status: leadsTable.status })
    .from(leadsTable)
    .where(and(...conds))
    .orderBy(desc(leadsTable.createdAt))
    .limit(MAX_CAMPAIGN_LEADS);
  if (leads.length === 0) return { error: "The segment matches no leads" };

  await db.transaction(async (tx) => {
    for (let i = 0; i < leads.length; i += 500) {
      await tx
        .insert(reactivationCampaignLeadsTable)
        .values(
          leads.slice(i, i + 500).map((l) => ({
            organizationId,
            campaignId,
            leadId: l.id,
            previousLeadStatus: l.status,
          })),
        )
        .onConflictDoNothing();
    }
    await tx
      .update(reactivationCampaignsTable)
      .set({ status: "running", totalLeads: leads.length, launchedAt: new Date() })
      .where(eq(reactivationCampaignsTable.id, campaignId));
  });
  await recordAudit({
    organizationId,
    action: "reactivation.launched",
    entityType: "reactivation_campaign",
    entityId: campaignId,
    metadata: { totalLeads: leads.length, ratePerHour: campaign.ratePerHour },
  });
  return (await getCampaignRow(organizationId, campaignId))!;
}

export async function setCampaignStatus(
  organizationId: string,
  campaignId: string,
  action: "pause" | "resume" | "cancel",
): Promise<ReactivationCampaign | { error: string }> {
  const campaign = await getCampaignRow(organizationId, campaignId);
  if (!campaign) return { error: "Campaign not found" };
  const allowed: Record<string, string[]> = {
    pause: ["running"],
    resume: ["paused"],
    cancel: ["draft", "running", "paused"],
  };
  if (!allowed[action].includes(campaign.status)) {
    return { error: `Cannot ${action} a ${campaign.status} campaign` };
  }
  const next = action === "pause" ? "paused" : action === "resume" ? "running" : "cancelled";
  await db
    .update(reactivationCampaignsTable)
    .set({ status: next, ...(next === "cancelled" ? { completedAt: new Date() } : {}) })
    .where(eq(reactivationCampaignsTable.id, campaignId));

  if (action === "cancel") {
    // Leads not yet enrolled never will be; sequences already running stop.
    await db
      .update(reactivationCampaignLeadsTable)
      .set({ status: "skipped", detail: "campaign cancelled" })
      .where(
        and(
          eq(reactivationCampaignLeadsTable.campaignId, campaignId),
          eq(reactivationCampaignLeadsTable.status, "pending"),
        ),
      );
    const enrolled = await db
      .select({ leadId: reactivationCampaignLeadsTable.leadId })
      .from(reactivationCampaignLeadsTable)
      .where(
        and(
          eq(reactivationCampaignLeadsTable.campaignId, campaignId),
          eq(reactivationCampaignLeadsTable.status, "enrolled"),
        ),
      );
    for (const row of enrolled) {
      await stopEnrollmentsForLead(
        organizationId,
        row.leadId,
        "reactivation campaign cancelled",
        "stopped",
      );
    }
  }
  await recordAudit({
    organizationId,
    action: `reactivation.${action}`,
    entityType: "reactivation_campaign",
    entityId: campaignId,
  });
  return (await getCampaignRow(organizationId, campaignId))!;
}

async function getCampaignRow(
  organizationId: string,
  campaignId: string,
): Promise<ReactivationCampaign | null> {
  const [row] = await db
    .select()
    .from(reactivationCampaignsTable)
    .where(
      and(
        eq(reactivationCampaignsTable.id, campaignId),
        eq(reactivationCampaignsTable.organizationId, organizationId),
      ),
    );
  return row ?? null;
}

export async function listCampaigns(organizationId: string) {
  const rows = await db
    .select({
      campaign: reactivationCampaignsTable,
      playbookName: playbooksTable.name,
      enrolled: sql<number>`(
        SELECT count(*)::int FROM ${reactivationCampaignLeadsTable}
        WHERE ${reactivationCampaignLeadsTable.campaignId} = ${reactivationCampaignsTable.id}
          AND ${reactivationCampaignLeadsTable.status} = 'enrolled'
      )`,
    })
    .from(reactivationCampaignsTable)
    .leftJoin(playbooksTable, eq(reactivationCampaignsTable.playbookId, playbooksTable.id))
    .where(eq(reactivationCampaignsTable.organizationId, organizationId))
    .orderBy(desc(reactivationCampaignsTable.createdAt))
    .limit(50);
  return rows.map((r) => ({
    ...r.campaign,
    playbookName: r.playbookName,
    enrolledCount: Number(r.enrolled),
  }));
}

// ---------------------------------------------------------------------------
// Throttled drainer (called from the automation scheduler tick)
// ---------------------------------------------------------------------------

/**
 * Enroll due campaign leads at each campaign's configured hourly rate.
 * Target-based pacing: after `t` hours, at most `ceil(t * ratePerHour)`
 * leads have entered the sequence, regardless of tick cadence or restarts.
 */
export async function drainReactivationCampaigns(organizationId?: string): Promise<void> {
  const conds = [eq(reactivationCampaignsTable.status, "running" as const)];
  if (organizationId) {
    conds.push(eq(reactivationCampaignsTable.organizationId, organizationId));
  }
  const running = await db
    .select()
    .from(reactivationCampaignsTable)
    .where(and(...conds));

  for (const campaign of running) {
    try {
      await drainCampaign(campaign);
    } catch (err) {
      console.error(`[reactivation] drain failed for campaign ${campaign.id}:`, err);
    }
  }
}

async function drainCampaign(campaign: ReactivationCampaign): Promise<void> {
  if (!campaign.launchedAt) return;
  const [{ processed }] = await db
    .select({
      processed: sql<number>`count(*) FILTER (WHERE ${reactivationCampaignLeadsTable.status} <> 'pending')::int`,
    })
    .from(reactivationCampaignLeadsTable)
    .where(eq(reactivationCampaignLeadsTable.campaignId, campaign.id));
  const elapsedHours = (Date.now() - campaign.launchedAt.getTime()) / 3_600_000;
  // First tick always releases at least one lead so a launch shows progress.
  const target = Math.min(
    campaign.totalLeads,
    Math.max(1, Math.ceil(elapsedHours * campaign.ratePerHour)),
  );
  const budget = Math.min(target - Number(processed), MAX_ENROLL_PER_TICK);
  if (budget <= 0) return;

  const playbook = await getOrgPlaybook(campaign.organizationId, campaign.playbookId);
  if (!playbook) return;

  // Claim a batch atomically so concurrent ticks never double-process.
  const claimed = await db.execute(sql`
    UPDATE ${reactivationCampaignLeadsTable} SET status = 'enrolled', enrolled_at = now()
    WHERE id IN (
      SELECT id FROM ${reactivationCampaignLeadsTable}
      WHERE campaign_id = ${campaign.id} AND status = 'pending'
      ORDER BY created_at
      LIMIT ${budget}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, lead_id
  `);
  const rows = claimed.rows as { id: string; lead_id: string }[];

  for (const row of rows) {
    try {
      const outcome = await enrollCampaignLead(campaign, playbook, row.lead_id);
      if (outcome.status === "skipped") {
        await db
          .update(reactivationCampaignLeadsTable)
          .set({ status: "skipped", detail: outcome.detail, enrollmentId: null })
          .where(eq(reactivationCampaignLeadsTable.id, row.id));
      } else {
        await db
          .update(reactivationCampaignLeadsTable)
          .set({ enrollmentId: outcome.enrollmentId })
          .where(eq(reactivationCampaignLeadsTable.id, row.id));
      }
    } catch (err) {
      // Per-lead isolation: one failed enrollment must not abort the batch
      // or strand its claimed row. Release the row back to pending so a
      // later tick retries it (the claim happens before send scheduling, so
      // a retry can never double-send).
      console.error(
        `[reactivation] drain failed for campaign ${campaign.id}:`,
        err,
      );
      await db
        .update(reactivationCampaignLeadsTable)
        .set({
          status: "pending",
          enrollmentId: null,
          detail: err instanceof Error ? err.message : "enrollment failed",
        })
        .where(eq(reactivationCampaignLeadsTable.id, row.id));
    }
  }

  // Completed when every snapshot lead has been processed.
  const [{ remaining }] = await db
    .select({
      remaining: sql<number>`count(*) FILTER (WHERE ${reactivationCampaignLeadsTable.status} = 'pending')::int`,
    })
    .from(reactivationCampaignLeadsTable)
    .where(eq(reactivationCampaignLeadsTable.campaignId, campaign.id));
  if (Number(remaining) === 0) {
    await db
      .update(reactivationCampaignsTable)
      .set({ status: "completed", completedAt: new Date() })
      .where(
        and(
          eq(reactivationCampaignsTable.id, campaign.id),
          eq(reactivationCampaignsTable.status, "running"),
        ),
      );
  }
}

async function enrollCampaignLead(
  campaign: ReactivationCampaign,
  playbook: Playbook,
  leadId: string,
): Promise<{ status: "enrolled"; enrollmentId: string } | { status: "skipped"; detail: string }> {
  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.organizationId, campaign.organizationId)));
  if (!lead) return { status: "skipped", detail: "lead deleted" };

  // The playbook engine only sends to outreach-active leads; move cold
  // stages (lost, completed, …) back into nurture so the win-back sequence
  // can run. The original stage is kept on the campaign lead row.
  if (!OUTREACH_ACTIVE_STATUSES.includes(lead.status as never)) {
    await db
      .update(leadsTable)
      .set({ status: "nurture" })
      .where(eq(leadsTable.id, lead.id));
  }
  const enrollment = await enrollLead(campaign.organizationId, lead.id, playbook);
  if (!enrollment) return { status: "skipped", detail: "already in a live sequence" };
  return { status: "enrolled", enrollmentId: enrollment.id };
}

// ---------------------------------------------------------------------------
// Preview + reporting
// ---------------------------------------------------------------------------

/** Generate the first-step outreach for a few sample segment leads. */
export async function previewOutreach(
  organizationId: string,
  params: { playbookId: string; segment: unknown },
): Promise<{ samples: { leadId: string; contactName: string | null; channel: string; subject: string | null; body: string }[] } | { error: string }> {
  const playbook = await getOrgPlaybook(organizationId, params.playbookId);
  if (!playbook || playbook.steps.length === 0) return { error: "Playbook not found" };
  const step = playbook.steps[0];
  const conds = segmentConditions(organizationId, sanitizeSegment(params.segment));
  const leads = await db
    .select({
      id: leadsTable.id,
      summary: leadsTable.summary,
      serviceType: leadsTable.serviceType,
      urgency: leadsTable.urgency,
      firstName: contactsTable.firstName,
      lastName: contactsTable.lastName,
    })
    .from(leadsTable)
    .leftJoin(contactsTable, eq(leadsTable.contactId, contactsTable.id))
    .where(and(...conds))
    .orderBy(desc(leadsTable.createdAt))
    .limit(3);
  if (leads.length === 0) return { error: "The segment matches no leads" };

  const settings = await getOrgSettings(organizationId);
  const businessName = settings.businessProfile.businessName ?? "our team";
  const samples = [];
  for (const lead of leads) {
    const draft = await draftOutreachMessage({
      channel: step.channel,
      prompt: step.prompt,
      businessName,
      contactFirstName: lead.firstName ?? "there",
      leadSummary: lead.summary ?? undefined,
      serviceType: lead.serviceType ?? undefined,
      urgency: lead.urgency,
      stepNumber: 1,
      totalSteps: playbook.steps.length,
    });
    samples.push({
      leadId: lead.id,
      contactName: [lead.firstName, lead.lastName].filter(Boolean).join(" ") || null,
      channel: step.channel,
      subject: step.subject ?? null,
      body: draft.body,
    });
  }
  return { samples };
}

export interface CampaignReport {
  campaign: ReactivationCampaign & { playbookName: string | null };
  enrolled: number;
  pending: number;
  skipped: number;
  contacted: number;
  replied: number;
  booked: number;
  recoveredRevenueCents: number;
}

export async function getCampaignReport(
  organizationId: string,
  campaignId: string,
): Promise<CampaignReport | null> {
  const campaign = await getCampaignRow(organizationId, campaignId);
  if (!campaign) return null;
  const [pb] = await db
    .select({ name: playbooksTable.name })
    .from(playbooksTable)
    .where(eq(playbooksTable.id, campaign.playbookId));

  const [counts] = await db
    .select({
      enrolled: sql<number>`count(*) FILTER (WHERE status = 'enrolled')::int`,
      pending: sql<number>`count(*) FILTER (WHERE status = 'pending')::int`,
      skipped: sql<number>`count(*) FILTER (WHERE status = 'skipped')::int`,
    })
    .from(reactivationCampaignLeadsTable)
    .where(eq(reactivationCampaignLeadsTable.campaignId, campaignId));

  // Contacted: enrollments that recorded at least one sent touch.
  const [outcomes] = await db
    .select({
      contacted: sql<number>`count(DISTINCT cl.lead_id) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM jsonb_array_elements(e.history) h
          WHERE h->>'kind' = 'sent'
        )
      )::int`,
      replied: sql<number>`count(DISTINCT cl.lead_id) FILTER (
        WHERE e.pause_reason ILIKE '%repl%'
      )::int`,
    })
    .from(sql`${reactivationCampaignLeadsTable} cl`)
    .leftJoin(sql`${playbookEnrollmentsTable} e`, sql`e.id = cl.enrollment_id`)
    .where(sql`cl.campaign_id = ${campaignId}`);

  const launched = campaign.launchedAt ?? campaign.createdAt;
  const [booked] = await db
    .select({
      value: sql<number>`count(DISTINCT ${appointmentsTable.leadId})::int`,
    })
    .from(appointmentsTable)
    .where(
      and(
        eq(appointmentsTable.organizationId, organizationId),
        sql`${appointmentsTable.leadId} IN (
          SELECT lead_id FROM ${reactivationCampaignLeadsTable}
          WHERE campaign_id = ${campaignId} AND status = 'enrolled'
        )`,
        sql`${appointmentsTable.createdAt} > ${launched}`,
      ),
    );

  const [revenue] = await db
    .select({
      value: sql<number>`coalesce(sum(${leadsTable.estimatedValueCents}), 0)::bigint`,
    })
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.organizationId, organizationId),
        inArray(leadsTable.status, [
          "won",
          "production_scheduled",
          "in_progress",
          "final_walkthrough",
          "completed",
        ]),
        sql`${leadsTable.id} IN (
          SELECT lead_id FROM ${reactivationCampaignLeadsTable}
          WHERE campaign_id = ${campaignId} AND status = 'enrolled'
        )`,
      ),
    );

  return {
    campaign: { ...campaign, playbookName: pb?.name ?? null },
    enrolled: Number(counts.enrolled),
    pending: Number(counts.pending),
    skipped: Number(counts.skipped),
    contacted: Number(outcomes?.contacted ?? 0),
    replied: Number(outcomes?.replied ?? 0),
    booked: Number(booked?.value ?? 0),
    recoveredRevenueCents: Number(revenue?.value ?? 0),
  };
}
