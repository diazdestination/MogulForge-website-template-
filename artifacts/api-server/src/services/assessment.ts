import type { SubmitAssessmentBody } from "@workspace/api-zod";
import {
  activitiesTable,
  auditEventsTable,
  consentRecordsTable,
  contactsTable,
  db,
  leadsTable,
  propertiesTable,
  type Urgency,
} from "@workspace/db";
import { sql } from "drizzle-orm";
import type { z } from "zod";

import { DEFAULT_LEAD_SCORING, type LeadScoringSettings } from "@workspace/db";

import {
  behaviorSignals,
  buildTouch,
  clampScore,
  leadAttributionColumns,
} from "./attribution";
import { providers } from "./providers";
import { getLeadScoring } from "./settings";

type Submission = z.infer<typeof SubmitAssessmentBody>;

const INTENT_META: Record<string, { reason: string; urgency: Urgency }> = {
  "active-leak": { reason: "Active leak reported", urgency: "emergency" },
  emergency: { reason: "Emergency request", urgency: "emergency" },
  "water-damage": { reason: "Water damage reported", urgency: "high" },
  storm: { reason: "Storm damage reported", urgency: "high" },
  replacement: { reason: "Full replacement interest", urgency: "normal" },
  general: { reason: "General inquiry", urgency: "normal" },
};

export function scoreSubmission(
  submission: Submission,
  weights: LeadScoringSettings = DEFAULT_LEAD_SCORING,
): {
  score: number;
  scoreReasons: string[];
  urgency: Urgency;
} {
  const reasons: string[] = [];
  let score = 0;

  const meta = INTENT_META[submission.intent] ?? INTENT_META.general;
  score += weights.intentPoints[submission.intent] ?? weights.intentPoints.general ?? 10;
  reasons.push(meta.reason);

  let urgency: Urgency = submission.urgency ?? meta.urgency;
  if (urgency === "emergency") {
    score += weights.emergencyUrgencyBonus;
    reasons.push("Marked as emergency urgency");
  } else if (urgency === "high") {
    score += weights.highUrgencyBonus;
    reasons.push("High urgency");
  }

  if (submission.email) {
    score += weights.emailProvidedBonus;
    reasons.push("Email provided");
  }
  if (submission.consent.smsGranted) {
    score += weights.smsConsentBonus;
    reasons.push("SMS consent granted (fast follow-up possible)");
  }
  if (submission.description && submission.description.length > 40) {
    score += weights.detailedDescriptionBonus;
    reasons.push("Detailed description provided");
  }
  if (submission.photoPaths && submission.photoPaths.length > 0) {
    score += 10;
    reasons.push(
      `${submission.photoPaths.length} damage photo${submission.photoPaths.length === 1 ? "" : "s"} attached`,
    );
  }

  return { score: Math.max(0, Math.min(Math.round(score), 100)), scoreReasons: reasons, urgency };
}

function guidanceFor(urgency: Urgency): string {
  switch (urgency) {
    case "emergency":
      return "This looks urgent. Our team treats active leaks and emergencies as same-day priorities — expect a call shortly.";
    case "high":
      return "We prioritize storm and water-damage assessments. Expect contact within a few business hours.";
    default:
      return "Thanks — your free assessment request is in. We'll reach out within one business day.";
  }
}

/**
 * True when the object path is referenced by a photos_attached activity in
 * the given organization — the tenant-scoping check for serving photos.
 */
export async function isLeadPhotoInOrganization(
  organizationId: string,
  objectPath: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: activitiesTable.id })
    .from(activitiesTable)
    .where(
      sql`${activitiesTable.organizationId} = ${organizationId}
        AND ${activitiesTable.type} = 'photos_attached'
        AND ${activitiesTable.metadata} @> ${JSON.stringify({ photoPaths: [objectPath] })}::jsonb`,
    )
    .limit(1);
  return rows.length > 0;
}
/**
 * Public lead capture: creates contact + property + lead + consent evidence +
 * timeline activity in one transaction, org-scoped.
 */
export async function captureAssessment(params: {
  organizationId: string;
  submission: Submission;
  sourceIp?: string;
  userAgent?: string;
}) {
  const { organizationId, submission } = params;
  const weights = await getLeadScoring(organizationId);
  const scored = scoreSubmission(submission, weights);
  const { urgency } = scored;
  // Behavior signals from the visitor's prior session activity (empty when
  // the submission carried no analytics id — anonymous isolation).
  const behavior = await behaviorSignals(
    organizationId,
    submission.anonymousId,
    weights,
  );
  const score = clampScore(scored.score + behavior.points);
  const scoreReasons = [...scored.scoreReasons, ...behavior.reasons];
  const ai = await providers.ai.summarizeLead({
    description: submission.description,
    intent: submission.intent,
    urgency,
  });

  return db.transaction(async (tx) => {
    const [contact] = await tx
      .insert(contactsTable)
      .values({
        organizationId,
        firstName: submission.firstName,
        lastName: submission.lastName ?? null,
        email: submission.email ?? null,
        phone: submission.phone,
      })
      .returning();

    const [property] = await tx
      .insert(propertiesTable)
      .values({
        organizationId,
        contactId: contact.id,
        addressLine1: submission.addressLine1,
        addressLine2: submission.addressLine2 ?? null,
        city: submission.city,
        state: submission.state,
        postalCode: submission.postalCode,
      })
      .returning();

    const source = submission.source ?? "public-site";
    const touch = buildTouch({
      channel: "web",
      source,
      attribution: submission.attribution,
    });

    const [lead] = await tx
      .insert(leadsTable)
      .values({
        organizationId,
        contactId: contact.id,
        propertyId: property.id,
        status: "new",
        urgency,
        serviceType: submission.intent,
        score,
        scoreReasons,
        summary: ai.summary,
        ...leadAttributionColumns({
          source,
          creationMethod: "assessment",
          touch,
          anonymousId: submission.anonymousId,
        }),
      })
      .returning();

    await tx.insert(consentRecordsTable).values([
      {
        organizationId,
        contactId: contact.id,
        channel: "sms" as const,
        granted: submission.consent.smsGranted,
        disclosureVersion: submission.consent.disclosureVersion,
        sourceIp: params.sourceIp ?? null,
        userAgent: params.userAgent ?? null,
      },
      {
        organizationId,
        contactId: contact.id,
        channel: "email" as const,
        granted: submission.consent.emailGranted,
        disclosureVersion: submission.consent.disclosureVersion,
        sourceIp: params.sourceIp ?? null,
        userAgent: params.userAgent ?? null,
      },
    ]);

    await tx.insert(activitiesTable).values({
      organizationId,
      leadId: lead.id,
      contactId: contact.id,
      type: "lead_captured",
      title: "Assessment request submitted from public site",
      body: submission.description ?? null,
      metadata: { score, scoreReasons, intent: submission.intent, aiProvider: ai.provider },
    });

    const photoPaths = (submission.photoPaths ?? []).filter((p) =>
      p.startsWith("/objects/"),
    );
    if (photoPaths.length > 0) {
      await tx.insert(activitiesTable).values({
        organizationId,
        leadId: lead.id,
        contactId: contact.id,
        type: "photos_attached",
        title: `Homeowner attached ${photoPaths.length} damage photo${photoPaths.length === 1 ? "" : "s"}`,
        body: null,
        metadata: { photoPaths },
      });
    }

    await tx.insert(auditEventsTable).values({
      organizationId,
      actorUserId: null,
      action: "lead.captured_public",
      entityType: "lead",
      entityId: lead.id,
      metadata: {
        source: submission.source ?? "public-site",
        consent: {
          smsGranted: submission.consent.smsGranted,
          emailGranted: submission.consent.emailGranted,
          disclosureVersion: submission.consent.disclosureVersion,
        },
      },
    });

    return {
      leadId: lead.id,
      score,
      scoreReasons,
      urgency,
      guidance: guidanceFor(urgency),
    };
  });
}
