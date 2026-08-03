import {
  db,
  playbookDecisionsTable,
  playbookTouchesTable,
  playbooksTable,
  type Playbook,
  type PlaybookStep,
  type PlaybookStepVariant,
  type SendingHoursSettings,
} from "@workspace/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { isWithinWindow } from "./send-gate";
import { getSendingHours } from "./settings";

/**
 * Closer Engine learning loop. Every touch's outcome chain (sent → replied
 * → booked → won/lost) is recorded in playbook_touches; this module turns
 * that data into decisions:
 *
 *  - Variant allocation: Thompson-sampling bandit over reply rate per
 *    (playbook, step, variant). Under MIN_VARIANT_SAMPLE sends a variant is
 *    still "exploring" and traffic is split evenly; admins can pin a
 *    variant to opt a step out entirely.
 *  - Send windows: once an org has enough replied touches, follow-up steps
 *    are nudged into the UTC hour bucket with the best observed reply rate.
 *
 * Everything is org-scoped — no cross-org learning — and every decision is
 * written to playbook_decisions with a human-readable explanation.
 */

/** Safety rail: a variant needs this many sends before results count. */
export const MIN_VARIANT_SAMPLE = 10;
/** Safety rail: send-window shifts need this many replies org-wide. */
export const MIN_WINDOW_SAMPLE = 20;
/** Max hours a send-window shift may move a step (never delays > 12h). */
const MAX_WINDOW_SHIFT_HOURS = 12;

export interface ResolvedVariant {
  key: string;
  prompt: string;
  subject?: string;
}

interface VariantStats {
  key: string;
  sent: number;
  replied: number;
  booked: number;
}

function stepVariants(step: PlaybookStep): ResolvedVariant[] {
  const base: ResolvedVariant = {
    key: "default",
    prompt: step.prompt,
    subject: step.subject,
  };
  const extras = (step.variants ?? []).map((v: PlaybookStepVariant) => ({
    key: v.key,
    prompt: v.prompt,
    subject: v.subject ?? step.subject,
  }));
  return [base, ...extras];
}

async function variantStats(
  organizationId: string,
  playbookId: string,
  stepIndex: number,
): Promise<Map<string, VariantStats>> {
  const rows = await db
    .select({
      key: playbookTouchesTable.variantKey,
      sent: sql<number>`count(*)::int`,
      replied: sql<number>`count(${playbookTouchesTable.repliedAt})::int`,
      booked: sql<number>`count(${playbookTouchesTable.bookedAt})::int`,
    })
    .from(playbookTouchesTable)
    .where(
      and(
        eq(playbookTouchesTable.organizationId, organizationId),
        eq(playbookTouchesTable.playbookId, playbookId),
        eq(playbookTouchesTable.stepIndex, stepIndex),
      ),
    )
    .groupBy(playbookTouchesTable.variantKey);
  return new Map(rows.map((r) => [r.key, r]));
}

/** Deterministic-enough Beta sampler (mean + jitter scaled by uncertainty). */
function sampleBeta(successes: number, failures: number): number {
  const a = successes + 1;
  const b = failures + 1;
  const mean = a / (a + b);
  const variance = (a * b) / ((a + b) ** 2 * (a + b + 1));
  // Box–Muller normal approximation of the Beta posterior.
  const u1 = Math.random() || 1e-9;
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.min(1, Math.max(0, mean + z * Math.sqrt(variance)));
}

async function logDecision(entry: {
  organizationId: string;
  playbookId?: string;
  kind: "variant_allocation" | "send_window";
  stepIndex?: number;
  decision: Record<string, unknown>;
  explanation: string;
}): Promise<void> {
  await db.insert(playbookDecisionsTable).values(entry);
}

/**
 * Pick the message variant for a step. Pinned variants always win; while
 * any variant is under MIN_VARIANT_SAMPLE sends the engine explores (least-
 * sent first); afterwards Thompson sampling on reply rate shifts traffic
 * toward winners. Logs an explainable decision when it exploits.
 */
export async function chooseVariant(
  organizationId: string,
  playbook: Playbook,
  stepIndex: number,
  step: PlaybookStep,
): Promise<ResolvedVariant> {
  const variants = stepVariants(step);
  if (variants.length === 1) return variants[0];

  if (step.pinnedVariant) {
    const pinned = variants.find((v) => v.key === step.pinnedVariant);
    if (pinned) return pinned;
  }

  const stats = await variantStats(organizationId, playbook.id, stepIndex);
  const get = (key: string): VariantStats =>
    stats.get(key) ?? { key, sent: 0, replied: 0, booked: 0 };

  const underSampled = variants.filter(
    (v) => get(v.key).sent < MIN_VARIANT_SAMPLE,
  );
  if (underSampled.length > 0) {
    // Explore: even out sample sizes before trusting any winner.
    underSampled.sort((a, b) => get(a.key).sent - get(b.key).sent);
    return underSampled[0];
  }

  // Exploit: Thompson sample on reply rate (bookings count double).
  let best = variants[0];
  let bestScore = -1;
  const scores: Record<string, number> = {};
  for (const v of variants) {
    const s = get(v.key);
    const successes = s.replied + s.booked;
    const score = sampleBeta(successes, Math.max(0, s.sent - successes));
    scores[v.key] = Number(score.toFixed(4));
    if (score > bestScore) {
      bestScore = score;
      best = v;
    }
  }
  const bestStats = get(best.key);
  const rate = (s: VariantStats) =>
    s.sent > 0 ? (s.replied + s.booked) / s.sent : 0;
  const others = variants.filter((v) => v.key !== best.key).map((v) => get(v.key));
  const bestOtherRate = Math.max(...others.map(rate), 0);
  const lift =
    bestOtherRate > 0 ? (rate(bestStats) / bestOtherRate).toFixed(1) : "∞";
  await logDecision({
    organizationId,
    playbookId: playbook.id,
    kind: "variant_allocation",
    stepIndex,
    decision: {
      chosen: best.key,
      scores,
      samples: Object.fromEntries(
        variants.map((v) => [v.key, get(v.key)]),
      ),
    },
    explanation: `Step ${stepIndex + 1}: chose variant "${best.key}" — ${(
      rate(bestStats) * 100
    ).toFixed(0)}% reply+booking rate over ${bestStats.sent} sends (${lift}x vs next best).`,
  });
  return best;
}

/**
 * Send-window learning: given a tentative runAt for a follow-up step,
 * return a possibly adjusted time in the org's best-performing UTC hour
 * window. Only ever delays within the same 12h horizon (never sends
 * earlier than scheduled, never pushes past MAX_WINDOW_SHIFT_HOURS), and
 * never picks an hour outside the org's permitted sending window — the
 * learning loop must not schedule a 3am local send no matter how well
 * that UTC bucket once performed.
 */
export async function adjustSendTime(
  organizationId: string,
  runAt: Date,
  sendingHours?: SendingHoursSettings,
): Promise<{ runAt: Date; adjusted: boolean }> {
  const rows = await db
    .select({
      hour: playbookTouchesTable.sentHourUtc,
      sent: sql<number>`count(*)::int`,
      replied: sql<number>`count(${playbookTouchesTable.repliedAt})::int`,
    })
    .from(playbookTouchesTable)
    .where(eq(playbookTouchesTable.organizationId, organizationId))
    .groupBy(playbookTouchesTable.sentHourUtc);
  const totalReplies = rows.reduce((n, r) => n + r.replied, 0);
  if (totalReplies < MIN_WINDOW_SAMPLE) return { runAt, adjusted: false };

  const cfg = sendingHours ?? (await getSendingHours(organizationId));
  const eligible = rows
    .filter((r) => r.sent >= MIN_VARIANT_SAMPLE)
    .filter((r) => {
      if (!cfg.quietHoursEnabled) return true;
      // Only consider hour buckets whose resulting send time lands inside
      // the org's permitted local sending window.
      const shift = (r.hour - runAt.getUTCHours() + 24) % 24;
      if (shift > MAX_WINDOW_SHIFT_HOURS) return false;
      return isWithinWindow(cfg, new Date(runAt.getTime() + shift * 3_600_000));
    });
  if (eligible.length < 2) return { runAt, adjusted: false };
  const best = eligible.reduce((a, b) =>
    b.replied / b.sent > a.replied / a.sent ? b : a,
  );
  const scheduledHour = runAt.getUTCHours();
  if (best.hour === scheduledHour) return { runAt, adjusted: false };

  const shift = (best.hour - scheduledHour + 24) % 24;
  if (shift === 0 || shift > MAX_WINDOW_SHIFT_HOURS) {
    return { runAt, adjusted: false };
  }
  const adjusted = new Date(runAt.getTime() + shift * 3_600_000);
  await logDecision({
    organizationId,
    kind: "send_window",
    decision: {
      fromHourUtc: scheduledHour,
      toHourUtc: best.hour,
      shiftHours: shift,
      bestHourReplyRate: Number((best.replied / best.sent).toFixed(3)),
    },
    explanation: `Shifted a follow-up from ${scheduledHour}:00 to ${best.hour}:00 UTC — that window replies at ${(
      (best.replied / best.sent) * 100
    ).toFixed(0)}% over ${best.sent} sends.`,
  });
  return { runAt: adjusted, adjusted: true };
}

/** Record a sent touch (called right after a successful send). */
export async function recordTouch(entry: {
  organizationId: string;
  playbookId: string;
  enrollmentId: string;
  leadId: string;
  stepIndex: number;
  variantKey: string;
  channel: string;
  provider: string;
}): Promise<void> {
  const now = new Date();
  await db.insert(playbookTouchesTable).values({
    ...entry,
    sentHourUtc: now.getUTCHours(),
    sentAt: now,
  });
}

export type TouchOutcome = "replied" | "booked" | "won" | "lost";

/**
 * Attribute a downstream lead event back to that lead's outreach touches.
 * Fills the first-null outcome column on all of the lead's touches, so a
 * reply after step 3 credits steps 1-3. Never throws.
 */
export async function recordLeadOutcome(
  organizationId: string,
  leadId: string,
  outcome: TouchOutcome,
): Promise<void> {
  try {
    const scope = and(
      eq(playbookTouchesTable.organizationId, organizationId),
      eq(playbookTouchesTable.leadId, leadId),
    );
    const now = new Date();
    if (outcome === "replied") {
      await db
        .update(playbookTouchesTable)
        .set({ repliedAt: now })
        .where(and(scope, isNull(playbookTouchesTable.repliedAt)));
    } else if (outcome === "booked") {
      await db
        .update(playbookTouchesTable)
        .set({ bookedAt: now })
        .where(and(scope, isNull(playbookTouchesTable.bookedAt)));
    } else {
      await db
        .update(playbookTouchesTable)
        .set({ finalOutcome: outcome, finalOutcomeAt: now })
        .where(and(scope, isNull(playbookTouchesTable.finalOutcome)));
    }
  } catch (err) {
    console.error("[playbook-learning] outcome attribution failed:", err);
  }
}

// ---------- Conversion Insights ----------

export interface InsightsFunnelRow {
  playbookId: string;
  playbookName: string;
  stepIndex: number;
  variantKey: string;
  channel: string;
  sent: number;
  replied: number;
  booked: number;
  won: number;
  lost: number;
}

export interface InsightsDecision {
  kind: string;
  stepIndex: number | null;
  explanation: string;
  createdAt: string;
}

export interface ConversionInsights {
  funnel: InsightsFunnelRow[];
  decisions: InsightsDecision[];
  /** Reply rate of engine-chosen winners vs the all-variant baseline. */
  baselineReplyRate: number;
  engineReplyRate: number;
  liftPercent: number | null;
  totalTouches: number;
}

export async function getConversionInsights(
  organizationId: string,
): Promise<ConversionInsights> {
  const funnel = await db
    .select({
      playbookId: playbookTouchesTable.playbookId,
      playbookName: playbooksTable.name,
      stepIndex: playbookTouchesTable.stepIndex,
      variantKey: playbookTouchesTable.variantKey,
      channel: playbookTouchesTable.channel,
      sent: sql<number>`count(*)::int`,
      replied: sql<number>`count(${playbookTouchesTable.repliedAt})::int`,
      booked: sql<number>`count(${playbookTouchesTable.bookedAt})::int`,
      won: sql<number>`count(*) filter (where ${playbookTouchesTable.finalOutcome} = 'won')::int`,
      lost: sql<number>`count(*) filter (where ${playbookTouchesTable.finalOutcome} = 'lost')::int`,
    })
    .from(playbookTouchesTable)
    .innerJoin(
      playbooksTable,
      eq(playbookTouchesTable.playbookId, playbooksTable.id),
    )
    .where(eq(playbookTouchesTable.organizationId, organizationId))
    .groupBy(
      playbookTouchesTable.playbookId,
      playbooksTable.name,
      playbookTouchesTable.stepIndex,
      playbookTouchesTable.variantKey,
      playbookTouchesTable.channel,
    )
    .orderBy(
      playbooksTable.name,
      playbookTouchesTable.stepIndex,
      playbookTouchesTable.variantKey,
    );

  const decisionRows = await db
    .select({
      kind: playbookDecisionsTable.kind,
      stepIndex: playbookDecisionsTable.stepIndex,
      explanation: playbookDecisionsTable.explanation,
      createdAt: playbookDecisionsTable.createdAt,
    })
    .from(playbookDecisionsTable)
    .where(eq(playbookDecisionsTable.organizationId, organizationId))
    .orderBy(desc(playbookDecisionsTable.createdAt))
    .limit(50);

  // Baseline = pooled reply rate across all variants; engine = reply rate
  // of the best variant per (playbook, step) weighted by that group's
  // volume — i.e. what the org converges to as traffic shifts to winners.
  const totalSent = funnel.reduce((n, r) => n + r.sent, 0);
  const totalReplied = funnel.reduce((n, r) => n + r.replied, 0);
  const baselineReplyRate = totalSent > 0 ? totalReplied / totalSent : 0;

  const groups = new Map<string, InsightsFunnelRow[]>();
  for (const row of funnel) {
    const key = `${row.playbookId}:${row.stepIndex}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  let engineNumerator = 0;
  let engineDenominator = 0;
  for (const rows of groups.values()) {
    const groupSent = rows.reduce((n, r) => n + r.sent, 0);
    const qualified = rows.filter((r) => r.sent >= MIN_VARIANT_SAMPLE);
    const pool = qualified.length > 0 ? qualified : rows;
    const best = pool.reduce((a, b) =>
      b.replied / b.sent > a.replied / a.sent ? b : a,
    );
    engineNumerator += (best.replied / best.sent) * groupSent;
    engineDenominator += groupSent;
  }
  const engineReplyRate =
    engineDenominator > 0 ? engineNumerator / engineDenominator : 0;
  const liftPercent =
    baselineReplyRate > 0
      ? Math.round(((engineReplyRate - baselineReplyRate) / baselineReplyRate) * 100)
      : null;

  return {
    funnel,
    decisions: decisionRows.map((d) => ({
      ...d,
      createdAt: d.createdAt.toISOString(),
    })),
    baselineReplyRate: Number(baselineReplyRate.toFixed(4)),
    engineReplyRate: Number(engineReplyRate.toFixed(4)),
    liftPercent,
    totalTouches: totalSent,
  };
}
