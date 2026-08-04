import {
  db,
  estimatesTable,
  leadsTable,
  playbookTouchesTable,
  playbooksTable,
  type PlaybookStep,
} from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { isLegacyDefaultOrg } from "../lib/orgFlavor";
import { enrollLead, POST_SALE_ACTIVE_STATUSES } from "./playbooks";

export { POST_SALE_ACTIVE_STATUSES };

/**
 * Post-sale value engine: milestone-gated playbooks (review requests,
 * referral asks, maintenance check-ins) plus honest revenue attribution
 * recorded the moment a lead is won. Post-sale playbooks are seeded
 * INACTIVE — an org opts in by activating them — and only ever enroll a
 * lead when the configured milestone status is actually reached.
 */

export const REVIEW_PLAYBOOK_SEED_KEY = "post_sale.review_request";
export const REFERRAL_PLAYBOOK_SEED_KEY = "post_sale.referral_request";
export const MAINTENANCE_PLAYBOOK_SEED_KEY = "post_sale.maintenance_checkin";

interface PostSaleSeed {
  seedKey: string;
  name: string;
  milestoneStatuses: string[];
  steps: PlaybookStep[];
}

const DAY = 60 * 24;

function postSaleSeeds(legacy: boolean): PostSaleSeed[] {
  // "workLabel" gives natural phrasing in sentences ("their roofing work" /
  // "their project") without the redundant "project work" you'd get from a
  // bare "project" variable inserted before "work".
  const workLabel = legacy ? "roofing work" : "project";
  return [
    {
      seedKey: REVIEW_PLAYBOOK_SEED_KEY,
      name: "Review request",
      milestoneStatuses: ["completed"],
      steps: [
        {
          channel: "email",
          delayMinutes: 2 * DAY,
          subject: "How did we do?",
          linkKind: "review",
          prompt: `The customer's ${workLabel} wrapped up a couple of days ago. Warmly thank them, ask how everything turned out, and invite them to leave a quick review using the link below — it genuinely helps a small business. One short paragraph, no pressure.`,
        },
        {
          channel: "email",
          delayMinutes: 7 * DAY,
          subject: "A quick favor?",
          linkKind: "review",
          prompt:
            "Gentle one-time reminder about the review request sent last week. Keep it to two sentences, acknowledge they're busy, and note the link below only takes a moment. Never guilt-trip.",
        },
      ],
    },
    {
      seedKey: REFERRAL_PLAYBOOK_SEED_KEY,
      name: "Referral request",
      milestoneStatuses: ["completed"],
      steps: [
        {
          channel: "email",
          delayMinutes: 14 * DAY,
          subject: "Know someone we can help?",
          linkKind: "referral",
          prompt: `Two weeks after their ${workLabel} wrapped up. Thank them again and ask if a friend or neighbor could use the same help — they can submit a referral with the link below. Warm and brief.`,
        },
      ],
    },
    {
      seedKey: MAINTENANCE_PLAYBOOK_SEED_KEY,
      name: "Maintenance check-in",
      milestoneStatuses: ["completed"],
      steps: [
        {
          channel: "email",
          delayMinutes: 90 * DAY,
          subject: "Checking in — how's everything holding up?",
          prompt: legacy
            ? "Seasonal check-in three months after their roofing project. Ask how the roof has held up through the recent weather, remind them we're happy to take a quick look any time, and invite them to reply with questions."
            : "Check-in three months after their project wrapped up. Ask how everything is holding up, remind them we're happy to help any time, and invite them to reply with questions.",
        },
        {
          channel: "email",
          delayMinutes: 180 * DAY,
          subject: "Time for a seasonal check-up?",
          prompt: legacy
            ? "Six-month seasonal reminder: offer a free maintenance inspection before the harsh season, one short paragraph."
            : "Six-month check-in: offer a quick maintenance review or tune-up, one short paragraph.",
        },
      ],
    },
  ];
}

/**
 * Idempotently seed the post-sale playbooks for an org (INACTIVE — the org
 * enables the ones it wants). Keys on (organizationId, seedKey) under a
 * per-org advisory lock so renames/edits/deactivations are never re-seeded.
 */
export async function ensurePostSalePlaybooks(
  organizationId: string,
): Promise<void> {
  const legacy = await isLegacyDefaultOrg(organizationId);
  const seeds = postSaleSeeds(legacy);
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`post-sale-playbooks:${organizationId}`}))`,
    );
    const existing = await tx
      .select({ seedKey: playbooksTable.seedKey })
      .from(playbooksTable)
      .where(eq(playbooksTable.organizationId, organizationId));
    const have = new Set(existing.map((r) => r.seedKey));
    const missing = seeds.filter((s) => !have.has(s.seedKey));
    if (missing.length === 0) return;
    await tx.insert(playbooksTable).values(
      missing.map((s) => ({
        organizationId,
        name: s.name,
        seedKey: s.seedKey,
        kind: "post_sale",
        isActive: false,
        enrollmentRules: { milestoneStatuses: s.milestoneStatuses },
        steps: s.steps,
      })),
    );
  });
}

/**
 * Called on every REAL lead status transition: enroll the lead into each
 * ACTIVE post-sale playbook whose milestone is exactly the status just
 * reached. Never enrolls before the milestone, never throws.
 */
export async function handlePostSaleTransition(
  organizationId: string,
  leadId: string,
  newStatus: string,
): Promise<void> {
  try {
    await ensurePostSalePlaybooks(organizationId);
    const candidates = await db
      .select()
      .from(playbooksTable)
      .where(
        and(
          eq(playbooksTable.organizationId, organizationId),
          eq(playbooksTable.kind, "post_sale"),
          eq(playbooksTable.isActive, true),
        ),
      );
    for (const playbook of candidates) {
      const milestones = playbook.enrollmentRules?.milestoneStatuses ?? [];
      if (playbook.steps.length === 0) continue;
      if (!milestones.includes(newStatus)) continue;
      await enrollLead(organizationId, leadId, playbook);
    }
  } catch (err) {
    console.error("[post-sale] milestone enrollment failed:", err);
  }
}

export type RevenueAttribution =
  | "directly_attributed"
  | "assisted"
  | "self_reported"
  | "estimated"
  | "unknown";

/** Lead entry paths where the platform itself captured the lead. */
const PLATFORM_CAPTURE_METHODS = new Set([
  "assessment",
  "widget",
  "form",
  "concierge",
  "capture",
  "referral",
]);

/**
 * Record revenue + an honest attribution category the first time a lead is
 * marked won. Revenue comes from the accepted estimate when one exists,
 * otherwise the rep's estimated value (labelled "estimated") — never
 * invented, and never claimed merely because a message was sent.
 */
export async function classifyWonLead(
  organizationId: string,
  leadId: string,
): Promise<void> {
  try {
    const [lead] = await db
      .select()
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.id, leadId),
          eq(leadsTable.organizationId, organizationId),
        ),
      );
    if (!lead || lead.wonAt) return; // classify once, at first win

    const [accepted] = await db
      .select({ totalCents: estimatesTable.totalCents })
      .from(estimatesTable)
      .where(
        and(
          eq(estimatesTable.organizationId, organizationId),
          eq(estimatesTable.leadId, leadId),
          eq(estimatesTable.status, "accepted"),
        ),
      )
      .orderBy(desc(estimatesTable.acceptedAt));

    const [touchStats] = await db
      .select({
        sent: sql<number>`count(*)::int`,
        engaged: sql<number>`count(*) filter (where ${playbookTouchesTable.repliedAt} is not null or ${playbookTouchesTable.bookedAt} is not null)::int`,
      })
      .from(playbookTouchesTable)
      .where(
        and(
          eq(playbookTouchesTable.organizationId, organizationId),
          eq(playbookTouchesTable.leadId, leadId),
        ),
      );

    const revenueCents = accepted?.totalCents ?? lead.estimatedValueCents ?? null;
    let attribution: RevenueAttribution;
    if (revenueCents == null) {
      attribution = "unknown";
    } else if (!accepted) {
      // The figure is the rep's estimate, not a booked amount.
      attribution = "estimated";
    } else if (
      PLATFORM_CAPTURE_METHODS.has(lead.creationMethod ?? "") &&
      (touchStats?.engaged ?? 0) > 0
    ) {
      attribution = "directly_attributed";
    } else if ((touchStats?.sent ?? 0) > 0) {
      attribution = "assisted";
    } else {
      attribution = "self_reported";
    }

    // Write-time guard: only the FIRST classifier ever writes, even if two
    // win handlers race past the read above.
    await db
      .update(leadsTable)
      .set({
        wonAt: new Date(),
        wonRevenueCents: revenueCents,
        wonAttribution: attribution,
      })
      .where(and(eq(leadsTable.id, leadId), sql`${leadsTable.wonAt} is null`));
  } catch (err) {
    console.error("[post-sale] won classification failed:", err);
  }
}
