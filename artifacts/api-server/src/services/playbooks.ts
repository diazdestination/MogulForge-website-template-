import {
  activitiesTable,
  consentRecordsTable,
  contactsTable,
  db,
  leadsTable,
  playbookEnrollmentsTable,
  playbooksTable,
  scheduledActionsTable,
  type EnrollmentHistoryEntry,
  type Lead,
  type Playbook,
  type PlaybookEnrollment,
  type PlaybookStep,
} from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { CLIENT } from "../lib/client.config";
import { recordAudit } from "./audit";
import {
  adjustSendTime,
  chooseVariant,
  recordTouch,
} from "./playbook-learning";
import { draftOutreachMessage, providers } from "./providers";
import {
  checkSendEligibility,
  handleProviderFailure,
  recordBlockedSend,
  unsubscribeFooter,
} from "./send-gate";
import { getOrgSettings } from "./settings";

/**
 * Closer Engine playbooks: every new lead is auto-enrolled in a matching
 * outreach playbook — an ordered sequence of email/SMS steps with delays —
 * that runs until the lead replies, books an inspection, advances past the
 * outreach stages, or the sequence is exhausted. Steps are executed by the
 * existing scheduled-actions engine (action type "playbook_step").
 */

/** Lead statuses where automated outreach is still appropriate. */
export const OUTREACH_ACTIVE_STATUSES = [
  "new",
  "ai_qualified",
  "contact_attempted",
  "follow_up",
  "nurture",
] as const;

export const DEFAULT_PLAYBOOK_SEED_KEY = "default.new_lead_outreach";
export const DEFAULT_PLAYBOOK_NAME = "New lead outreach";

const DEFAULT_STEPS: PlaybookStep[] = [
  {
    channel: "email",
    delayMinutes: 5,
    subject: "About your roof — we're on it",
    prompt:
      "First touch, minutes after the homeowner asked for help. Warmly confirm we received their request, set the expectation that a real person will reach out shortly, and invite them to reply with any details or photos. Short and human, no pressure.",
  },
  {
    channel: "sms",
    delayMinutes: 60 * 4,
    prompt:
      "Same-day text follow-up. One or two sentences: we're ready to schedule their free inspection and they can reply to this text to pick a time.",
  },
  {
    channel: "email",
    delayMinutes: 60 * 24,
    subject: "Your free roof inspection — ready when you are",
    prompt:
      "Day-two follow-up. Gently remind them their free inspection is ready to book, mention the specific concern they reported, and give an easy next step. Helpful, not salesy.",
  },
  {
    channel: "sms",
    delayMinutes: 60 * 24 * 3,
    prompt:
      "Day-five nudge. Brief, friendly check-in: still happy to help whenever they're ready; weather damage tends to get worse, so an early look saves money.",
  },
  {
    channel: "email",
    delayMinutes: 60 * 24 * 4,
    subject: "Should we keep your spot open?",
    prompt:
      "Final touch of the sequence, about nine days in. Politely close the loop: we'll stop reaching out but they can reply any time; include a one-line recap of what we can do for them.",
  },
];

/**
 * Idempotently seed the default playbook for an org. Keys on
 * (organizationId, seedKey) under a per-org advisory lock, so a renamed,
 * edited, or deactivated default is never re-seeded and concurrent calls
 * can't duplicate it.
 */
export async function ensureDefaultPlaybook(
  organizationId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`default-playbook:${organizationId}`}))`,
    );
    const [existing] = await tx
      .select({ id: playbooksTable.id })
      .from(playbooksTable)
      .where(
        and(
          eq(playbooksTable.organizationId, organizationId),
          eq(playbooksTable.seedKey, DEFAULT_PLAYBOOK_SEED_KEY),
        ),
      );
    if (existing) return;
    await tx.insert(playbooksTable).values({
      organizationId,
      name: DEFAULT_PLAYBOOK_NAME,
      seedKey: DEFAULT_PLAYBOOK_SEED_KEY,
      isActive: true,
      enrollmentRules: {},
      steps: DEFAULT_STEPS,
    });
  });
}

function rulesMatch(playbook: Playbook, lead: Lead): boolean {
  const rules = playbook.enrollmentRules ?? {};
  if (
    typeof rules.minScore === "number" &&
    lead.score < rules.minScore
  ) {
    return false;
  }
  if (rules.urgencies?.length && !rules.urgencies.includes(lead.urgency)) {
    return false;
  }
  if (
    rules.serviceTypes?.length &&
    (!lead.serviceType || !rules.serviceTypes.includes(lead.serviceType))
  ) {
    return false;
  }
  if (rules.sources?.length && (!lead.source || !rules.sources.includes(lead.source))) {
    return false;
  }
  return true;
}

/**
 * Auto-enroll a newly created lead into the first matching active playbook.
 * No-ops (never throws) when no playbook matches, the lead already has a
 * live enrollment, or the lead is past the outreach stages.
 */
export async function autoEnrollLead(
  organizationId: string,
  leadId: string,
): Promise<PlaybookEnrollment | null> {
  try {
    await ensureDefaultPlaybook(organizationId);
    const [lead] = await db
      .select()
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.id, leadId),
          eq(leadsTable.organizationId, organizationId),
        ),
      );
    if (!lead) return null;
    if (!OUTREACH_ACTIVE_STATUSES.includes(lead.status as never)) return null;

    const playbooks = await db
      .select()
      .from(playbooksTable)
      .where(
        and(
          eq(playbooksTable.organizationId, organizationId),
          eq(playbooksTable.isActive, true),
        ),
      )
      .orderBy(desc(playbooksTable.createdAt));
    const match = playbooks.find(
      (p) => p.steps.length > 0 && rulesMatch(p, lead),
    );
    if (!match) return null;

    return await enrollLead(organizationId, leadId, match);
  } catch (err) {
    // Enrollment must never break lead capture.
    console.error("[playbooks] auto-enroll failed:", err);
    return null;
  }
}

/** Create the enrollment row and schedule step 0. Skips if one is live.
 * Exported for the reactivation campaign drainer, which enrolls a chosen
 * playbook explicitly rather than via auto-enroll rules. */
export async function enrollLead(
  organizationId: string,
  leadId: string,
  playbook: Playbook,
): Promise<PlaybookEnrollment | null> {
  const firstStep = playbook.steps[0];
  if (!firstStep) return null;
  const runAt = new Date(Date.now() + firstStep.delayMinutes * 60_000);
  try {
    const [enrollment] = await db
      .insert(playbookEnrollmentsTable)
      .values({
        organizationId,
        playbookId: playbook.id,
        leadId,
        status: "active",
        currentStep: 0,
        nextRunAt: runAt,
      })
      .returning();
    await scheduleStep(enrollment, 0, runAt);
    await recordAudit({
      organizationId,
      action: "playbook.enrolled",
      entityType: "lead",
      entityId: leadId,
      metadata: { playbookId: playbook.id, playbookName: playbook.name },
    });
    return enrollment;
  } catch (err) {
    // Unique partial index: another live enrollment already exists.
    if (err instanceof Error && /playbook_enrollments_lead_active_idx/.test(err.message)) {
      return null;
    }
    throw err;
  }
}

async function scheduleStep(
  enrollment: PlaybookEnrollment,
  stepIndex: number,
  runAt: Date,
): Promise<void> {
  await db.insert(scheduledActionsTable).values({
    organizationId: enrollment.organizationId,
    action: {
      type: "playbook_step",
      params: { enrollmentId: enrollment.id, stepIndex },
    },
    context: { leadId: enrollment.leadId },
    runAt,
  });
}

async function appendHistory(
  enrollmentId: string,
  entry: EnrollmentHistoryEntry,
): Promise<void> {
  await db
    .update(playbookEnrollmentsTable)
    .set({
      history: sql`${playbookEnrollmentsTable.history} || ${JSON.stringify([entry])}::jsonb`,
    })
    .where(eq(playbookEnrollmentsTable.id, enrollmentId));
}

/**
 * Execute one due playbook step (called by the scheduled-actions engine).
 * Returns a short status string used as the action result detail.
 * Stale-guards: enrollment must still be active at exactly this step, and
 * the lead must still be in an outreach-appropriate stage.
 */
export async function executePlaybookStep(
  organizationId: string,
  params: { enrollmentId?: string; stepIndex?: number },
): Promise<{ status: "success" | "skipped"; detail: string }> {
  const { enrollmentId, stepIndex } = params;
  if (typeof enrollmentId !== "string" || typeof stepIndex !== "number") {
    return { status: "skipped", detail: "missing enrollment params" };
  }
  const [enrollment] = await db
    .select()
    .from(playbookEnrollmentsTable)
    .where(
      and(
        eq(playbookEnrollmentsTable.id, enrollmentId),
        eq(playbookEnrollmentsTable.organizationId, organizationId),
      ),
    );
  if (!enrollment) return { status: "skipped", detail: "enrollment not found" };
  if (enrollment.status !== "active") {
    return { status: "skipped", detail: `enrollment ${enrollment.status}` };
  }
  if (enrollment.currentStep !== stepIndex) {
    return { status: "skipped", detail: "step already handled" };
  }

  const [playbook] = await db
    .select()
    .from(playbooksTable)
    .where(eq(playbooksTable.id, enrollment.playbookId));
  const step = playbook?.steps[stepIndex];
  if (!playbook || !step) {
    await finishEnrollment(enrollment.id, "completed", "sequence exhausted");
    return { status: "skipped", detail: "no step at index" };
  }

  const [lead] = await db
    .select()
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.id, enrollment.leadId),
        eq(leadsTable.organizationId, organizationId),
      ),
    );
  if (!lead || !OUTREACH_ACTIVE_STATUSES.includes(lead.status as never)) {
    await finishEnrollment(
      enrollment.id,
      "completed",
      lead ? `lead moved to ${lead.status}` : "lead deleted",
    );
    return { status: "skipped", detail: "lead past outreach stages" };
  }
  const [contact] = await db
    .select()
    .from(contactsTable)
    .where(
      and(
        eq(contactsTable.id, lead.contactId),
        eq(contactsTable.organizationId, organizationId),
      ),
    );
  if (!contact) {
    await finishEnrollment(enrollment.id, "stopped", "contact missing");
    return { status: "skipped", detail: "contact missing" };
  }

  // Unified pre-send eligibility gate (suppressions, DNC, consent, quiet
  // hours, frequency caps) — evaluated BEFORE the step is claimed so a
  // deferral re-queues this same step instead of consuming it.
  const gate = await checkSendEligibility({
    organizationId,
    contact,
    channel: step.channel,
    kind: "outreach",
  });
  let gateSkipReason: string | null = null;
  if (!gate.ok) {
    if (gate.outcome === "deferred") {
      // Quiet hours / frequency cap: pause, never drop. Re-queue the exact
      // same step; the currentStep CAS makes duplicate queue rows harmless.
      await db.insert(scheduledActionsTable).values({
        organizationId,
        action: {
          type: "playbook_step",
          params: { enrollmentId: enrollment.id, stepIndex },
        },
        context: { leadId: enrollment.leadId },
        runAt: gate.resumeAt,
      });
      await db
        .update(playbookEnrollmentsTable)
        .set({ nextRunAt: gate.resumeAt })
        .where(eq(playbookEnrollmentsTable.id, enrollment.id));
      await appendHistory(enrollment.id, {
        at: new Date().toISOString(),
        kind: "deferred",
        stepIndex,
        channel: step.channel,
        detail: `${gate.reason} until ${gate.resumeAt.toISOString()}`,
      });
      await recordBlockedSend({
        organizationId,
        channel: step.channel,
        reason: gate.reason,
        outcome: "deferred",
        source: "playbook",
        leadId: lead.id,
        contactId: contact.id,
        resumeAt: gate.resumeAt,
      });
      return { status: "skipped", detail: `deferred: ${gate.reason}` };
    }
    await recordBlockedSend({
      organizationId,
      channel: step.channel,
      reason: gate.reason,
      outcome: "blocked",
      source: "playbook",
      leadId: lead.id,
      contactId: contact.id,
    });
    if (gate.reason.startsWith("suppressed:") || gate.reason === "do_not_contact") {
      // The recipient opted out (or is flagged do-not-contact): exit the
      // whole sequence rather than skipping one step.
      await finishEnrollment(enrollment.id, "stopped", `send blocked: ${gate.reason}`);
      return { status: "skipped", detail: `blocked: ${gate.reason}` };
    }
    // Non-fatal (missing/invalid address, no SMS consent): claim + skip the
    // touch and let the sequence continue on other channels.
    gateSkipReason = gate.reason;
  }

  // Atomically CLAIM this step before any external side effect: advance
  // currentStep (and schedule the next step / complete the sequence) in one
  // transaction, guarded by a compare-and-set on (status, currentStep).
  // A concurrent worker, a scheduler retry after a partial failure, or a
  // duplicate queued action will fail the claim and no-op — the worst case
  // is a skipped touch, never a double send.
  const nextStep = playbook.steps[stepIndex + 1];
  let nextRunAt: Date | null = null;
  if (nextStep) {
    // Learning loop: nudge the follow-up into the org's best-performing
    // send window once there's enough outcome data (no-op before that).
    const tentative = new Date(Date.now() + nextStep.delayMinutes * 60_000);
    nextRunAt = (await adjustSendTime(organizationId, tentative)).runAt;
  }
  const claimed = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(playbookEnrollmentsTable)
      .set(
        nextStep
          ? { currentStep: stepIndex + 1, nextRunAt }
          : {
              currentStep: stepIndex + 1,
              nextRunAt: null,
              status: "completed",
              pauseReason: "sequence exhausted",
            },
      )
      .where(
        and(
          eq(playbookEnrollmentsTable.id, enrollment.id),
          eq(playbookEnrollmentsTable.organizationId, organizationId),
          eq(playbookEnrollmentsTable.status, "active"),
          eq(playbookEnrollmentsTable.currentStep, stepIndex),
        ),
      )
      .returning();
    if (!row) return null;
    if (nextStep && nextRunAt) {
      await tx.insert(scheduledActionsTable).values({
        organizationId,
        action: {
          type: "playbook_step",
          params: { enrollmentId: enrollment.id, stepIndex: stepIndex + 1 },
        },
        context: { leadId: enrollment.leadId },
        runAt: nextRunAt,
      });
    }
    return row;
  });
  if (!claimed) {
    return { status: "skipped", detail: "step already claimed" };
  }

  // Channel reachability + SMS consent gate.
  let sendResult: { id: string; provider: string } | null = null;
  let skipDetail: string | null = null;
  const settings = await getOrgSettings(organizationId);
  const businessName =
    settings.businessProfile.businessName ?? CLIENT.businessShortName;

  // Learning loop: bandit-allocated message variant (pinned wins; even
  // split while exploring; Thompson sampling on reply rate afterwards).
  const variant = await chooseVariant(organizationId, playbook, stepIndex, step);

  const draft = await draftOutreachMessage({
    channel: step.channel,
    prompt: variant.prompt,
    businessName,
    contactFirstName: contact.firstName,
    leadSummary: lead.summary ?? undefined,
    serviceType: lead.serviceType ?? undefined,
    urgency: lead.urgency,
    stepNumber: stepIndex + 1,
    totalSteps: playbook.steps.length,
  });

  if (gateSkipReason) {
    skipDetail = `blocked: ${gateSkipReason}`;
  } else {
    try {
      if (step.channel === "email") {
        sendResult = await providers.email.send(
          contact.email!,
          variant.subject ?? step.subject ?? `${businessName} — about your roof`,
          draft.body + unsubscribeFooter(organizationId, contact.id),
        );
      } else {
        sendResult = await providers.sms.send(contact.phone!, draft.body);
      }
    } catch (err) {
      // Permanently bad address → suppress it and stop the sequence so
      // nothing keeps hammering a dead mailbox/number. Transient/provider
      // config failures rethrow (step is already claimed; no double send).
      const address = step.channel === "email" ? contact.email! : contact.phone!;
      const suppressed = await handleProviderFailure({
        organizationId,
        channel: step.channel,
        address,
        err,
        source: "playbook",
      });
      if (!suppressed) throw err;
      await recordBlockedSend({
        organizationId,
        channel: step.channel,
        reason: `suppressed:${suppressed}`,
        outcome: "blocked",
        source: "playbook",
        leadId: lead.id,
        contactId: contact.id,
      });
      await finishEnrollment(
        enrollment.id,
        "stopped",
        `send failed permanently: ${suppressed}`,
      );
      skipDetail = `provider rejected address (${suppressed})`;
    }
  }

  const now = new Date().toISOString();
  if (sendResult) {
    // Learning loop: record the touch so downstream outcomes (reply,
    // booking, won/lost) can be attributed to this step + variant.
    await recordTouch({
      organizationId,
      playbookId: playbook.id,
      enrollmentId: enrollment.id,
      leadId: lead.id,
      stepIndex,
      variantKey: variant.key,
      channel: step.channel,
      provider: sendResult.provider,
    });
    await db.insert(activitiesTable).values({
      organizationId,
      leadId: lead.id,
      contactId: contact.id,
      type: "playbook_touch_sent",
      title: `Playbook ${step.channel === "email" ? "email" : "text"} sent (step ${stepIndex + 1} of ${playbook.steps.length})`,
      body: draft.body,
      metadata: {
        playbookId: playbook.id,
        playbookName: playbook.name,
        enrollmentId: enrollment.id,
        stepIndex,
        channel: step.channel,
        provider: sendResult.provider,
        aiProvider: draft.provider,
      },
    });
    await appendHistory(enrollment.id, {
      at: now,
      kind: "sent",
      stepIndex,
      channel: step.channel,
      detail: `${sendResult.provider}`,
    });
    await recordAudit({
      organizationId,
      action: "playbook.step_sent",
      entityType: "lead",
      entityId: lead.id,
      metadata: {
        playbookId: playbook.id,
        stepIndex,
        channel: step.channel,
        provider: sendResult.provider,
        mock: sendResult.provider.startsWith("mock-"),
      },
    });
  } else {
    await appendHistory(enrollment.id, {
      at: now,
      kind: "step_skipped",
      stepIndex,
      channel: step.channel,
      detail: skipDetail ?? "unreachable",
    });
  }

  return sendResult
    ? { status: "success", detail: `${step.channel}:${sendResult.provider}` }
    : { status: "skipped", detail: skipDetail ?? "unreachable" };
}

async function finishEnrollment(
  enrollmentId: string,
  status: "completed" | "stopped",
  reason: string,
): Promise<void> {
  await db
    .update(playbookEnrollmentsTable)
    .set({ status, pauseReason: reason, nextRunAt: null })
    .where(eq(playbookEnrollmentsTable.id, enrollmentId));
  await appendHistory(enrollmentId, {
    at: new Date().toISOString(),
    kind: status,
    detail: reason,
  });
}

/**
 * Stop or pause every live enrollment for a lead. Used by conversion
 * triggers (reply received, inspection booked, stage advanced) and the
 * rep-facing pause control. Never throws.
 */
export async function stopEnrollmentsForLead(
  organizationId: string,
  leadId: string,
  reason: string,
  status: "paused" | "completed" | "stopped" = "completed",
): Promise<void> {
  try {
    const live = await db
      .select()
      .from(playbookEnrollmentsTable)
      .where(
        and(
          eq(playbookEnrollmentsTable.organizationId, organizationId),
          eq(playbookEnrollmentsTable.leadId, leadId),
          inArray(playbookEnrollmentsTable.status, ["active", "paused"]),
        ),
      );
    for (const enrollment of live) {
      await db
        .update(playbookEnrollmentsTable)
        .set({ status, pauseReason: reason, nextRunAt: status === "paused" ? enrollment.nextRunAt : null })
        .where(eq(playbookEnrollmentsTable.id, enrollment.id));
      await appendHistory(enrollment.id, {
        at: new Date().toISOString(),
        kind: status === "paused" ? "paused" : status,
        detail: reason,
      });
    }
  } catch (err) {
    console.error("[playbooks] stopEnrollmentsForLead failed:", err);
  }
}

/** Rep control: resume a paused enrollment (reschedules the current step). */
export async function resumeEnrollment(
  organizationId: string,
  enrollmentId: string,
): Promise<PlaybookEnrollment | null> {
  const [enrollment] = await db
    .select()
    .from(playbookEnrollmentsTable)
    .where(
      and(
        eq(playbookEnrollmentsTable.id, enrollmentId),
        eq(playbookEnrollmentsTable.organizationId, organizationId),
      ),
    );
  if (!enrollment || enrollment.status !== "paused") return null;
  const [playbook] = await db
    .select()
    .from(playbooksTable)
    .where(eq(playbooksTable.id, enrollment.playbookId));
  const step = playbook?.steps[enrollment.currentStep];
  if (!playbook || !step) return null;
  const runAt = new Date(Date.now() + Math.min(step.delayMinutes, 60) * 60_000);
  const [updated] = await db
    .update(playbookEnrollmentsTable)
    .set({ status: "active", pauseReason: null, nextRunAt: runAt })
    .where(eq(playbookEnrollmentsTable.id, enrollment.id))
    .returning();
  await scheduleStep(updated, updated.currentStep, runAt);
  await appendHistory(enrollment.id, {
    at: new Date().toISOString(),
    kind: "resumed",
  });
  return updated;
}

/** Rep control: skip the current step and schedule the next one now. */
export async function skipEnrollmentStep(
  organizationId: string,
  enrollmentId: string,
): Promise<PlaybookEnrollment | null> {
  const [enrollment] = await db
    .select()
    .from(playbookEnrollmentsTable)
    .where(
      and(
        eq(playbookEnrollmentsTable.id, enrollmentId),
        eq(playbookEnrollmentsTable.organizationId, organizationId),
      ),
    );
  if (!enrollment || (enrollment.status !== "active" && enrollment.status !== "paused")) {
    return null;
  }
  const [playbook] = await db
    .select()
    .from(playbooksTable)
    .where(eq(playbooksTable.id, enrollment.playbookId));
  if (!playbook) return null;
  await appendHistory(enrollment.id, {
    at: new Date().toISOString(),
    kind: "skipped",
    stepIndex: enrollment.currentStep,
  });
  const nextIndex = enrollment.currentStep + 1;
  const nextStep = playbook.steps[nextIndex];
  if (!nextStep) {
    await finishEnrollment(enrollment.id, "completed", "skipped past final step");
    const [finished] = await db
      .select()
      .from(playbookEnrollmentsTable)
      .where(eq(playbookEnrollmentsTable.id, enrollment.id));
    return finished ?? null;
  }
  const runAt = new Date(Date.now() + nextStep.delayMinutes * 60_000);
  const [updated] = await db
    .update(playbookEnrollmentsTable)
    .set({ currentStep: nextIndex, nextRunAt: runAt, status: "active", pauseReason: null })
    .where(eq(playbookEnrollmentsTable.id, enrollment.id))
    .returning();
  await scheduleStep(updated, nextIndex, runAt);
  return updated;
}

/** The lead-detail panel: live (or most recent) enrollment for a lead. */
export async function getLeadEnrollment(
  organizationId: string,
  leadId: string,
): Promise<(PlaybookEnrollment & { playbookName: string; totalSteps: number }) | null> {
  const [row] = await db
    .select({
      enrollment: playbookEnrollmentsTable,
      playbookName: playbooksTable.name,
      steps: playbooksTable.steps,
    })
    .from(playbookEnrollmentsTable)
    .innerJoin(
      playbooksTable,
      eq(playbookEnrollmentsTable.playbookId, playbooksTable.id),
    )
    .where(
      and(
        eq(playbookEnrollmentsTable.organizationId, organizationId),
        eq(playbookEnrollmentsTable.leadId, leadId),
      ),
    )
    .orderBy(desc(playbookEnrollmentsTable.createdAt))
    .limit(1);
  if (!row) return null;
  return {
    ...row.enrollment,
    playbookName: row.playbookName,
    totalSteps: row.steps.length,
  };
}
