import type { SubmitWidgetLeadBody } from "@workspace/api-zod";
import {
  activitiesTable,
  auditEventsTable,
  contactsTable,
  db,
  DEFAULT_WIDGET_SETTINGS,
  leadsTable,
  type WidgetSettings,
} from "@workspace/db";
import type { z } from "zod";

import { scoreSubmission } from "./assessment";
import {
  behaviorSignals,
  buildTouch,
  clampScore,
  leadAttributionColumns,
} from "./attribution";
import { getConciergeSettings, getLeadScoring, getOrgSettings } from "./settings";

type WidgetLead = z.infer<typeof SubmitWidgetLeadBody>;

/**
 * The accent color is interpolated into a <style> block inside the embed
 * script's Shadow DOM, so it must never be able to break out of a CSS value.
 * Allow only simple hex / rgb(a) / hsl(a) forms; anything else falls back to
 * the default.
 */
const SAFE_CSS_COLOR =
  /^(#[0-9a-fA-F]{3,8}|rgba?\([0-9.,%\s/]{1,40}\)|hsla?\([0-9.,%\s/deg]{1,40}\))$/;

export function sanitizeWidgetColor(color: string | undefined): string {
  const trimmed = color?.trim();
  return trimmed && SAFE_CSS_COLOR.test(trimmed)
    ? trimmed
    : DEFAULT_WIDGET_SETTINGS.primaryColor;
}

/**
 * Effective widget config for an org: stored settings merged over defaults.
 * Everything returned here is public — it is served verbatim to any site
 * holding the org's installation key. Never add secrets.
 */
export async function getPublicWidgetConfig(
  organizationId: string,
  opts: { preview?: boolean } = {},
) {
  const settings = await getOrgSettings(organizationId);
  const widget: WidgetSettings = {
    ...DEFAULT_WIDGET_SETTINGS,
    ...(settings.widget ?? {}),
  };
  // Test mode: hide every module from normal visitors; only requests carrying
  // the admin preview flag see the widget until it is switched live.
  const hidden = Boolean(widget.testMode) && !opts.preview;
  const concierge = await getConciergeSettings(organizationId);
  return {
    testMode: Boolean(widget.testMode),
    modules: {
      leadCapture: widget.leadCaptureEnabled && !hidden,
      concierge: Boolean(widget.conciergeEnabled) && !hidden,
    },
    concierge: {
      assistantName: concierge.assistantName,
      greeting: concierge.greeting,
    },
    appearance: {
      primaryColor: sanitizeWidgetColor(widget.primaryColor),
      position: widget.position ?? DEFAULT_WIDGET_SETTINGS.position,
      greeting: widget.greeting ?? DEFAULT_WIDGET_SETTINGS.greeting,
      buttonLabel: widget.buttonLabel ?? DEFAULT_WIDGET_SETTINGS.buttonLabel,
    },
    businessName: settings.businessProfile?.businessName ?? null,
  };
}

/**
 * Create a contact + lead from an embedded widget submission, carrying
 * marketing attribution (UTM/referrer/landing page) into the lead's touch
 * fields so reporting and playbooks see the real source.
 */
export async function captureWidgetLead(params: {
  organizationId: string;
  submission: WidgetLead;
  sourceIp?: string;
  userAgent?: string;
}) {
  const { organizationId, submission } = params;
  const weights = await getLeadScoring(organizationId);
  // Widget submissions are lightweight general inquiries — score them with
  // the shared engine so admin-tuned weights apply consistently.
  const scored = scoreSubmission(
    {
      firstName: submission.firstName,
      lastName: submission.lastName,
      email: submission.email,
      phone: submission.phone,
      addressLine1: "",
      city: "",
      state: "",
      postalCode: "",
      intent: "general",
      description: submission.message,
      source: "widget",
      consent: {
        smsGranted: false,
        emailGranted: Boolean(submission.email),
        disclosureVersion: "widget-v1",
      },
    },
    weights,
  );

  const a = submission.attribution ?? {};
  const touch = buildTouch({
    channel: "widget",
    source: "widget",
    attribution: a,
  });
  const behavior = await behaviorSignals(
    organizationId,
    submission.anonymousId,
    weights,
  );
  const { urgency } = scored;
  const score = clampScore(scored.score + behavior.points);
  const scoreReasons = [...scored.scoreReasons, ...behavior.reasons];

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

    const [lead] = await tx
      .insert(leadsTable)
      .values({
        organizationId,
        contactId: contact.id,
        status: "new",
        urgency,
        serviceType: "general",
        score,
        scoreReasons,
        summary: submission.message?.trim()
          ? submission.message.trim().slice(0, 300)
          : "Website widget inquiry",
        ...leadAttributionColumns({
          source: "widget",
          creationMethod: "widget",
          touch,
          anonymousId: submission.anonymousId,
        }),
      })
      .returning();

    await tx.insert(activitiesTable).values({
      organizationId,
      leadId: lead.id,
      contactId: contact.id,
      type: "lead_captured",
      title: "Lead captured from website widget",
      body: submission.message ?? null,
      metadata: { score, scoreReasons, attribution: a },
    });

    await tx.insert(auditEventsTable).values({
      organizationId,
      actorUserId: null,
      action: "lead.captured_public",
      entityType: "lead",
      entityId: lead.id,
      metadata: {
        source: "widget",
        sourceIp: params.sourceIp ?? null,
        userAgent: params.userAgent ?? null,
      },
    });

    return { leadId: lead.id, urgency };
  });
}
