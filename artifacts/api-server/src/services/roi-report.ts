import {
  activitiesTable,
  appointmentsTable,
  db,
  engagementLinksTable,
  leadsTable,
  playbookEnrollmentsTable,
  playbookTouchesTable,
  playbooksTable,
  reactivationCampaignLeadsTable,
  reactivationCampaignsTable,
} from "@workspace/db";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * Organization-level ROI report: what the platform captured, moved, and
 * won inside a date window — with HONEST attribution. Revenue is never
 * claimed just because a message was sent: every revenue figure carries
 * the attribution category recorded at win time (directly_attributed /
 * assisted / self_reported / estimated / unknown), and review activity is
 * reported as requests + clicks only (completed third-party reviews are
 * not detectable).
 */

const QUALIFIED_STATUSES = [
  "ai_qualified",
  "inspection_scheduled",
  "inspection_completed",
  "estimate_preparing",
  "estimate_sent",
  "claim_pending",
  "follow_up",
  "won",
  "production_scheduled",
  "in_progress",
  "final_walkthrough",
  "completed",
  "review_requested",
];

const OPEN_PIPELINE_STATUSES = [
  "new",
  "ai_qualified",
  "contact_attempted",
  "inspection_scheduled",
  "inspection_completed",
  "estimate_preparing",
  "estimate_sent",
  "claim_pending",
  "follow_up",
  "nurture",
];

export interface BreakdownRow {
  key: string;
  count: number;
}

export interface RoiReport {
  windowDays: number;
  generatedAt: string;
  leads: {
    total: number;
    qualified: number;
    bySource: BreakdownRow[];
    byCampaign: BreakdownRow[];
    byTool: BreakdownRow[];
    byLandingPage: BreakdownRow[];
    byServiceType: BreakdownRow[];
  };
  appointments: {
    total: number;
    leadsWithAppointment: number;
    appointmentRatePct: number | null;
  };
  responsiveness: {
    leadsContacted: number;
    leadsReplied: number;
    responseRatePct: number | null;
    medianMinutesToFirstTouch: number | null;
  };
  playbooks: {
    playbookId: string;
    name: string;
    kind: string;
    sent: number;
    replied: number;
    booked: number;
    won: number;
  }[];
  reviewsAndReferrals: {
    reviewRequestsSent: number;
    reviewLinkClicks: number;
    referralRequestsSent: number;
    referralSubmissions: number;
    referralLeads: number;
  };
  reactivation: {
    campaignsLaunched: number;
    leadsEnrolled: number;
    leadsReplied: number;
  };
  outcomes: {
    won: number;
    revenueWonCents: number;
    revenueByAttribution: { category: string; count: number; revenueCents: number }[];
    pipelineValueCents: number;
    lost: number;
    lostReasons: BreakdownRow[];
  };
}

const breakdown = (
  rows: { key: string | null; count: number }[],
): BreakdownRow[] =>
  rows
    .map((r) => ({ key: r.key ?? "unknown", count: r.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);

export async function getRoiReport(
  organizationId: string,
  windowDays: number,
): Promise<RoiReport> {
  const since = new Date(Date.now() - windowDays * 86_400_000);
  const orgLeads = and(
    eq(leadsTable.organizationId, organizationId),
    gte(leadsTable.createdAt, since),
  );

  const groupCount = <C extends AnyPgColumn>(col: C) =>
    db
      .select({ key: col, count: sql<number>`count(*)::int` })
      .from(leadsTable)
      .where(orgLeads)
      .groupBy(col);

  const [
    [totals],
    bySource,
    byCampaign,
    byTool,
    byLandingPage,
    byServiceType,
    [appts],
    [contactStats],
    [firstTouchStats],
    playbookRows,
    [engagement],
    [activityCounts],
    [referralLeads],
    [reactivationStats],
    [wonTotals],
    revenueByAttribution,
    [pipeline],
    lostReasons,
  ] = await Promise.all([
    db
      .select({
        total: sql<number>`count(*)::int`,
        qualified: sql<number>`count(*) filter (where ${leadsTable.status} in ${sql.raw(`('${QUALIFIED_STATUSES.join("','")}')`)})::int`,
      })
      .from(leadsTable)
      .where(orgLeads),
    groupCount(leadsTable.source),
    groupCount(leadsTable.campaign),
    groupCount(leadsTable.creationMethod),
    groupCount(leadsTable.landingPage),
    groupCount(leadsTable.serviceType),
    db
      .select({
        total: sql<number>`count(*)::int`,
        leadsWith: sql<number>`count(distinct ${appointmentsTable.leadId})::int`,
      })
      .from(appointmentsTable)
      .where(
        and(
          eq(appointmentsTable.organizationId, organizationId),
          gte(appointmentsTable.createdAt, since),
        ),
      ),
    db
      .select({
        contacted: sql<number>`count(distinct ${playbookTouchesTable.leadId})::int`,
        replied: sql<number>`count(distinct ${playbookTouchesTable.leadId}) filter (where ${playbookTouchesTable.repliedAt} is not null)::int`,
      })
      .from(playbookTouchesTable)
      .where(
        and(
          eq(playbookTouchesTable.organizationId, organizationId),
          gte(playbookTouchesTable.sentAt, since),
        ),
      ),
    db
      .select({
        median: sql<number | null>`percentile_cont(0.5) within group (
          order by extract(epoch from (ft.first_sent - ${leadsTable.createdAt})) / 60
        )`,
      })
      .from(leadsTable)
      .innerJoin(
        sql`(
          select lead_id, min(sent_at) as first_sent
          from playbook_touches
          where organization_id = ${organizationId}
          group by lead_id
        ) ft`,
        sql`ft.lead_id = ${leadsTable.id}`,
      )
      .where(orgLeads),
    db
      .select({
        playbookId: playbookTouchesTable.playbookId,
        name: playbooksTable.name,
        kind: playbooksTable.kind,
        sent: sql<number>`count(*)::int`,
        replied: sql<number>`count(${playbookTouchesTable.repliedAt})::int`,
        booked: sql<number>`count(${playbookTouchesTable.bookedAt})::int`,
        won: sql<number>`count(*) filter (where ${playbookTouchesTable.finalOutcome} = 'won')::int`,
      })
      .from(playbookTouchesTable)
      .innerJoin(
        playbooksTable,
        eq(playbookTouchesTable.playbookId, playbooksTable.id),
      )
      .where(
        and(
          eq(playbookTouchesTable.organizationId, organizationId),
          gte(playbookTouchesTable.sentAt, since),
        ),
      )
      .groupBy(
        playbookTouchesTable.playbookId,
        playbooksTable.name,
        playbooksTable.kind,
      ),
    // Window-bounded: count the timestamped click/submission activities,
    // not the links' cumulative counters (those are lifetime totals).
    db
      .select({
        reviewClicks: sql<number>`count(*) filter (where ${activitiesTable.type} = 'review_link_clicked')::int`,
        referralSubmissions: sql<number>`count(*) filter (where ${activitiesTable.type} = 'referral_submitted')::int`,
      })
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.organizationId, organizationId),
          inArray(activitiesTable.type, [
            "review_link_clicked",
            "referral_submitted",
          ]),
          gte(activitiesTable.occurredAt, since),
        ),
      ),
    db
      .select({
        reviewSent: sql<number>`count(*) filter (where pb.seed_key = 'post_sale.review_request' or pb.name ilike '%review%')::int`,
        referralSent: sql<number>`count(*) filter (where pb.seed_key = 'post_sale.referral_request' or pb.name ilike '%referral%')::int`,
      })
      .from(playbookTouchesTable)
      .innerJoin(
        sql`${playbooksTable} pb`,
        sql`pb.id = ${playbookTouchesTable.playbookId} and pb.kind = 'post_sale'`,
      )
      .where(
        and(
          eq(playbookTouchesTable.organizationId, organizationId),
          gte(playbookTouchesTable.sentAt, since),
        ),
      ),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(leadsTable)
      .where(and(orgLeads, eq(leadsTable.source, "referral"))),
    db
      .select({
        campaigns: sql<number>`count(distinct c.id)::int`,
        enrolled: sql<number>`count(cl.id) filter (where cl.status = 'enrolled')::int`,
        replied: sql<number>`count(distinct cl.lead_id) filter (where e.pause_reason ilike '%repl%')::int`,
      })
      .from(sql`${reactivationCampaignsTable} c`)
      .leftJoin(sql`${reactivationCampaignLeadsTable} cl`, sql`cl.campaign_id = c.id`)
      .leftJoin(sql`${playbookEnrollmentsTable} e`, sql`e.id = cl.enrollment_id`)
      .where(
        sql`c.organization_id = ${organizationId} and coalesce(c.launched_at, c.created_at) >= ${since}`,
      ),
    db
      .select({
        won: sql<number>`count(*)::int`,
        revenue: sql<number>`coalesce(sum(${leadsTable.wonRevenueCents}), 0)::bigint`,
      })
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.organizationId, organizationId),
          gte(leadsTable.wonAt, since),
        ),
      ),
    db
      .select({
        category: leadsTable.wonAttribution,
        count: sql<number>`count(*)::int`,
        revenueCents: sql<number>`coalesce(sum(${leadsTable.wonRevenueCents}), 0)::bigint`,
      })
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.organizationId, organizationId),
          gte(leadsTable.wonAt, since),
        ),
      )
      .groupBy(leadsTable.wonAttribution),
    db
      .select({
        value: sql<number>`coalesce(sum(${leadsTable.estimatedValueCents}), 0)::bigint`,
      })
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.organizationId, organizationId),
          inArray(leadsTable.status, OPEN_PIPELINE_STATUSES as never[]),
        ),
      ),
    db
      .select({
        key: leadsTable.lostReason,
        count: sql<number>`count(*)::int`,
      })
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.organizationId, organizationId),
          eq(leadsTable.status, "lost"),
          gte(leadsTable.updatedAt, since),
        ),
      )
      .groupBy(leadsTable.lostReason),
  ]);

  const lostCount = lostReasons.reduce((n, r) => n + r.count, 0);
  const pct = (num: number, den: number) =>
    den > 0 ? Math.round((num / den) * 100) : null;

  return {
    windowDays,
    generatedAt: new Date().toISOString(),
    leads: {
      total: totals.total,
      qualified: totals.qualified,
      bySource: breakdown(bySource),
      byCampaign: breakdown(byCampaign),
      byTool: breakdown(byTool),
      byLandingPage: breakdown(byLandingPage),
      byServiceType: breakdown(byServiceType),
    },
    appointments: {
      total: appts.total,
      leadsWithAppointment: appts.leadsWith,
      appointmentRatePct: pct(appts.leadsWith, totals.total),
    },
    responsiveness: {
      leadsContacted: contactStats.contacted,
      leadsReplied: contactStats.replied,
      responseRatePct: pct(contactStats.replied, contactStats.contacted),
      medianMinutesToFirstTouch:
        firstTouchStats?.median != null
          ? Math.round(Number(firstTouchStats.median))
          : null,
    },
    playbooks: playbookRows.sort((a, b) => b.sent - a.sent),
    reviewsAndReferrals: {
      reviewRequestsSent: activityCounts?.reviewSent ?? 0,
      reviewLinkClicks: engagement?.reviewClicks ?? 0,
      referralRequestsSent: activityCounts?.referralSent ?? 0,
      referralSubmissions: engagement?.referralSubmissions ?? 0,
      referralLeads: referralLeads?.count ?? 0,
    },
    reactivation: {
      campaignsLaunched: reactivationStats?.campaigns ?? 0,
      leadsEnrolled: reactivationStats?.enrolled ?? 0,
      leadsReplied: reactivationStats?.replied ?? 0,
    },
    outcomes: {
      won: wonTotals.won,
      revenueWonCents: Number(wonTotals.revenue),
      revenueByAttribution: revenueByAttribution
        .map((r) => ({
          category: r.category ?? "unknown",
          count: r.count,
          revenueCents: Number(r.revenueCents),
        }))
        .sort((a, b) => b.revenueCents - a.revenueCents),
      pipelineValueCents: Number(pipeline.value),
      lost: lostCount,
      lostReasons: breakdown(lostReasons),
    },
  };
}

/** Flatten the report into CSV rows: section,metric,key,value. */
export function roiReportToCsv(report: RoiReport): string {
  const esc = (v: string | number | null) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows: (string | number | null)[][] = [
    ["section", "metric", "key", "value"],
    ["meta", "window_days", "", report.windowDays],
    ["meta", "generated_at", "", report.generatedAt],
    ["leads", "total", "", report.leads.total],
    ["leads", "qualified", "", report.leads.qualified],
    ...report.leads.bySource.map((r) => ["leads", "by_source", r.key, r.count]),
    ...report.leads.byCampaign.map((r) => ["leads", "by_campaign", r.key, r.count]),
    ...report.leads.byTool.map((r) => ["leads", "by_tool", r.key, r.count]),
    ...report.leads.byLandingPage.map((r) => ["leads", "by_landing_page", r.key, r.count]),
    ...report.leads.byServiceType.map((r) => ["leads", "by_service_type", r.key, r.count]),
    ["appointments", "total", "", report.appointments.total],
    ["appointments", "leads_with_appointment", "", report.appointments.leadsWithAppointment],
    ["appointments", "appointment_rate_pct", "", report.appointments.appointmentRatePct],
    ["responsiveness", "leads_contacted", "", report.responsiveness.leadsContacted],
    ["responsiveness", "leads_replied", "", report.responsiveness.leadsReplied],
    ["responsiveness", "response_rate_pct", "", report.responsiveness.responseRatePct],
    ["responsiveness", "median_minutes_to_first_touch", "", report.responsiveness.medianMinutesToFirstTouch],
    ...report.playbooks.flatMap((p) => [
      ["playbooks", "sent", p.name, p.sent],
      ["playbooks", "replied", p.name, p.replied],
      ["playbooks", "booked", p.name, p.booked],
      ["playbooks", "won", p.name, p.won],
    ]),
    ["reviews_referrals", "review_requests_sent", "", report.reviewsAndReferrals.reviewRequestsSent],
    ["reviews_referrals", "review_link_clicks", "", report.reviewsAndReferrals.reviewLinkClicks],
    ["reviews_referrals", "referral_requests_sent", "", report.reviewsAndReferrals.referralRequestsSent],
    ["reviews_referrals", "referral_submissions", "", report.reviewsAndReferrals.referralSubmissions],
    ["reviews_referrals", "referral_leads", "", report.reviewsAndReferrals.referralLeads],
    ["reactivation", "campaigns_launched", "", report.reactivation.campaignsLaunched],
    ["reactivation", "leads_enrolled", "", report.reactivation.leadsEnrolled],
    ["reactivation", "leads_replied", "", report.reactivation.leadsReplied],
    ["outcomes", "won", "", report.outcomes.won],
    ["outcomes", "revenue_won_cents", "", report.outcomes.revenueWonCents],
    ...report.outcomes.revenueByAttribution.flatMap((r) => [
      ["outcomes", "revenue_by_attribution_cents", r.category, r.revenueCents],
      ["outcomes", "won_by_attribution", r.category, r.count],
    ]),
    ["outcomes", "pipeline_value_cents", "", report.outcomes.pipelineValueCents],
    ["outcomes", "lost", "", report.outcomes.lost],
    ...report.outcomes.lostReasons.map((r) => ["outcomes", "lost_reason", r.key, r.count]),
  ];
  return rows.map((r) => r.map(esc).join(",")).join("\n") + "\n";
}
