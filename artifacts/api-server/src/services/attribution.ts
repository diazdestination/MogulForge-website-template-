/**
 * Lead attribution + visitor intelligence.
 *
 * Attribution: every lead-capture path builds its touch data through
 * `buildTouch` and persists it via `leadAttributionColumns` (new leads) or
 * `repeatTouchColumns` (dedupe into an existing lead), so first/last-touch
 * UTM, campaign, landing page, referrer and creation method land on the lead
 * row itself instead of staying stranded in analytics events.
 *
 * Visitor association is CONSENT-AWARE: a website visitor's anonymous
 * analytics id is linked to a lead only at identification time — i.e. when
 * the visitor voluntarily submits their contact details through a capture
 * flow that passed the id along. Anonymous visitors are never associated,
 * and behavior lookups return nothing for leads without a linked id.
 */
import {
  analyticsEventsTable,
  db,
  leadsTable,
  type LeadScoringSettings,
} from "@workspace/db";
import { and, asc, eq, gte } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Touch normalization
// ---------------------------------------------------------------------------

export interface AttributionInput {
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmTerm?: string | null;
  utmContent?: string | null;
  landingPage?: string | null;
  referrer?: string | null;
}

export interface Touch {
  channel: string;
  source: string;
  at: string;
  landingPage?: string;
  referrer?: string;
  utm?: Record<string, string>;
}

const clean = (v: unknown, max = 500): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim().slice(0, max);
  return t || undefined;
};

/** Normalize client-supplied attribution into a compact touch record. */
export function buildTouch(params: {
  channel: string;
  source: string;
  attribution?: AttributionInput | null;
}): Touch {
  const a = params.attribution ?? {};
  const utm: Record<string, string> = {};
  const map: [keyof AttributionInput, string][] = [
    ["utmSource", "source"],
    ["utmMedium", "medium"],
    ["utmCampaign", "campaign"],
    ["utmTerm", "term"],
    ["utmContent", "content"],
  ];
  for (const [key, short] of map) {
    const v = clean(a[key], 200);
    if (v) utm[short] = v;
  }
  return {
    channel: params.channel,
    source: params.source,
    at: new Date().toISOString(),
    ...(clean(a.landingPage) ? { landingPage: clean(a.landingPage) } : {}),
    ...(clean(a.referrer) ? { referrer: clean(a.referrer) } : {}),
    ...(Object.keys(utm).length ? { utm } : {}),
  };
}

/**
 * Column values for a NEW lead insert: original + latest source, queryable
 * campaign/landing page/referrer copies, both touches, creation method, and
 * the linked visitor id (identification implies consent to associate).
 */
export function leadAttributionColumns(params: {
  source: string;
  creationMethod: string;
  touch: Touch;
  anonymousId?: string | null;
}) {
  const { touch } = params;
  return {
    source: params.source,
    latestSource: params.source,
    campaign: touch.utm?.campaign ?? null,
    landingPage: touch.landingPage ?? null,
    referrer: touch.referrer ?? null,
    creationMethod: params.creationMethod,
    anonymousId: clean(params.anonymousId, 100) ?? null,
    firstTouch: touch as unknown as Record<string, unknown>,
    lastTouch: touch as unknown as Record<string, unknown>,
  };
}

/**
 * Column values when a repeat submission dedupes into an EXISTING lead:
 * last-touch fields move forward, first-touch fields are left alone, and a
 * visitor id fills in only when the lead has none yet (first link wins).
 */
export function repeatTouchColumns(params: {
  source: string;
  touch: Touch;
  existing: { anonymousId?: string | null; campaign?: string | null };
  anonymousId?: string | null;
}) {
  return {
    latestSource: params.source,
    lastTouch: params.touch as unknown as Record<string, unknown>,
    ...(params.touch.utm?.campaign && !params.existing.campaign
      ? { campaign: params.touch.utm.campaign }
      : {}),
    ...(!params.existing.anonymousId && clean(params.anonymousId, 100)
      ? { anonymousId: clean(params.anonymousId, 100) }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Visitor behavior
// ---------------------------------------------------------------------------

/** Paths that signal buying intent when viewed pre-conversion. */
const HIGH_INTENT_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /financ/i, label: "financing" },
  { pattern: /pricing|cost|estimate/i, label: "pricing" },
  { pattern: /services|repair|replace/i, label: "services" },
  { pattern: /reviews|testimonial/i, label: "reviews" },
];

/** Event names that mean the visitor started an on-site tool. */
const TOOL_EVENTS = new Set([
  "assessment_started",
  "form_started",
  "tool_started",
  "concierge_opened",
]);

export interface VisitorBehavior {
  pageViews: number;
  sessions: number;
  /** Distinct calendar days with activity — "returned N times". */
  activeDays: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  topPages: { path: string; views: number }[];
  highIntentPages: string[];
  toolsStarted: string[];
  abandonedForms: number;
  /** Readable one-line facts for the UI ("returned 3× in 5 days"). */
  highlights: string[];
}

const EMPTY_BEHAVIOR: VisitorBehavior = {
  pageViews: 0,
  sessions: 0,
  activeDays: 0,
  firstSeenAt: null,
  lastSeenAt: null,
  topPages: [],
  highIntentPages: [],
  toolsStarted: [],
  abandonedForms: 0,
  highlights: [],
};

/**
 * Aggregate an identified visitor's first-party events (last 90 days).
 * Returns the empty shape when no id is given — anonymous isolation.
 */
export async function getVisitorBehavior(
  organizationId: string,
  anonymousId: string | null | undefined,
): Promise<VisitorBehavior> {
  const anon = clean(anonymousId, 100);
  if (!anon) return EMPTY_BEHAVIOR;

  const since = new Date(Date.now() - 90 * 24 * 60 * 60_000);
  const events = await db
    .select({
      eventName: analyticsEventsTable.eventName,
      sessionId: analyticsEventsTable.sessionId,
      path: analyticsEventsTable.path,
      properties: analyticsEventsTable.properties,
      occurredAt: analyticsEventsTable.occurredAt,
    })
    .from(analyticsEventsTable)
    .where(
      and(
        eq(analyticsEventsTable.organizationId, organizationId),
        eq(analyticsEventsTable.anonymousId, anon),
        gte(analyticsEventsTable.occurredAt, since),
      ),
    )
    .orderBy(asc(analyticsEventsTable.occurredAt))
    .limit(2000);

  if (events.length === 0) return EMPTY_BEHAVIOR;

  const sessions = new Set<string>();
  const days = new Set<string>();
  const pathViews = new Map<string, number>();
  const highIntent = new Set<string>();
  const tools = new Set<string>();
  let pageViews = 0;
  let formStarts = 0;
  let formSubmits = 0;

  for (const e of events) {
    if (e.sessionId) sessions.add(e.sessionId);
    days.add(e.occurredAt.toISOString().slice(0, 10));
    if (e.eventName === "page_view") {
      pageViews++;
      const path = e.path ?? "/";
      pathViews.set(path, (pathViews.get(path) ?? 0) + 1);
      for (const { pattern, label } of HIGH_INTENT_PATTERNS) {
        if (pattern.test(path)) highIntent.add(label);
      }
    }
    if (TOOL_EVENTS.has(e.eventName)) {
      tools.add(e.eventName.replace(/_started$|_opened$/, ""));
    }
    if (e.eventName === "form_started" || e.eventName === "assessment_started") formStarts++;
    if (e.eventName === "form_submitted" || e.eventName === "assessment_submitted") formSubmits++;
  }

  const firstSeen = events[0].occurredAt;
  const lastSeen = events[events.length - 1].occurredAt;
  const topPages = [...pathViews.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([path, views]) => ({ path, views }));
  const abandonedForms = Math.max(0, formStarts - formSubmits);
  const spanDays = Math.max(
    1,
    Math.round((lastSeen.getTime() - firstSeen.getTime()) / 86_400_000),
  );

  const highlights: string[] = [];
  if (days.size > 1) highlights.push(`Returned ${days.size}× over ${spanDays} day${spanDays === 1 ? "" : "s"}`);
  if (highIntent.size > 0) highlights.push(`Viewed ${[...highIntent].join(", ")} page${highIntent.size === 1 ? "" : "s"}`);
  if (tools.size > 0) highlights.push(`Started ${[...tools].join(", ")}`);
  if (abandonedForms > 0) highlights.push(`Abandoned ${abandonedForms} form${abandonedForms === 1 ? "" : "s"} before converting`);
  if (pageViews > 0) highlights.push(`${pageViews} page view${pageViews === 1 ? "" : "s"} across ${sessions.size || 1} visit${sessions.size === 1 ? "" : "s"}`);

  return {
    pageViews,
    sessions: sessions.size,
    activeDays: days.size,
    firstSeenAt: firstSeen.toISOString(),
    lastSeenAt: lastSeen.toISOString(),
    topPages,
    highIntentPages: [...highIntent],
    toolsStarted: [...tools],
    abandonedForms,
    highlights,
  };
}

/**
 * Behavior-based scoring signals with stored reasons. Zero-weight settings
 * disable a signal; the empty behavior shape contributes nothing.
 */
export function scoreBehavior(
  behavior: VisitorBehavior,
  weights: LeadScoringSettings,
): { points: number; reasons: string[] } {
  let points = 0;
  const reasons: string[] = [];
  if (behavior.activeDays >= 2 && weights.returnVisitBonus > 0) {
    points += weights.returnVisitBonus;
    reasons.push(`Returned to the website on ${behavior.activeDays} separate days`);
  }
  if (behavior.highIntentPages.length > 0 && weights.engagedPagesBonus > 0) {
    points += weights.engagedPagesBonus;
    reasons.push(`Viewed high-intent pages (${behavior.highIntentPages.join(", ")})`);
  }
  if (behavior.toolsStarted.length > 0 && weights.toolUsageBonus > 0) {
    points += weights.toolUsageBonus;
    reasons.push(`Used on-site tools (${behavior.toolsStarted.join(", ")})`);
  }
  return { points, reasons };
}

/**
 * Behavior score for a capture path that has a visitor id: fetches behavior
 * and returns bonus points + reasons (both empty when anonymous).
 */
export async function behaviorSignals(
  organizationId: string,
  anonymousId: string | null | undefined,
  weights: LeadScoringSettings,
): Promise<{ points: number; reasons: string[]; behavior: VisitorBehavior }> {
  const behavior = await getVisitorBehavior(organizationId, anonymousId);
  const { points, reasons } = scoreBehavior(behavior, weights);
  return { points, reasons, behavior };
}

/** Clamp a raw score into the stored 0–100 range. */
export const clampScore = (score: number): number =>
  Math.max(0, Math.min(Math.round(score), 100));

/** The behavior summary a lead-detail page shows, plus link status. */
export async function getLeadBehaviorSummary(
  organizationId: string,
  leadId: string,
): Promise<{
  linked: boolean;
  attribution: {
    source: string | null;
    latestSource: string | null;
    campaign: string | null;
    landingPage: string | null;
    referrer: string | null;
    creationMethod: string | null;
  };
  behavior: VisitorBehavior;
} | null> {
  const [lead] = await db
    .select({
      anonymousId: leadsTable.anonymousId,
      source: leadsTable.source,
      latestSource: leadsTable.latestSource,
      campaign: leadsTable.campaign,
      landingPage: leadsTable.landingPage,
      referrer: leadsTable.referrer,
      creationMethod: leadsTable.creationMethod,
    })
    .from(leadsTable)
    .where(and(eq(leadsTable.id, leadId), eq(leadsTable.organizationId, organizationId)));
  if (!lead) return null;
  const behavior = await getVisitorBehavior(organizationId, lead.anonymousId);
  return {
    linked: Boolean(lead.anonymousId),
    attribution: {
      source: lead.source,
      latestSource: lead.latestSource,
      campaign: lead.campaign,
      landingPage: lead.landingPage,
      referrer: lead.referrer,
      creationMethod: lead.creationMethod,
    },
    behavior,
  };
}
