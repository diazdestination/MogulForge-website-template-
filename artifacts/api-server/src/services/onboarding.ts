import {
  activitiesTable,
  contactsTable,
  db,
  leadsTable,
  orgSettingsTable,
  playbookEnrollmentsTable,
  scheduledActionsTable,
  type OnboardingState,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getOrgSettings } from "./settings";
import { getLeadScoring } from "./settings";
import { autoEnrollLead } from "./playbooks";

/** Canonical wizard step order (mirrored by the command-center wizard UI). */
export const ONBOARDING_STEPS = [
  "company",
  "services",
  "hours",
  "channels",
  "booking",
  "playbook",
  "concierge",
  "domain",
  "snippet",
  "verify",
  "test-lead",
  "invite-team",
  "launch",
] as const;

const STEP_SET = new Set<string>(ONBOARDING_STEPS);

export async function getOnboardingState(
  organizationId: string,
): Promise<OnboardingState> {
  const settings = await getOrgSettings(organizationId);
  const raw = settings.onboarding ?? { completedSteps: [] };
  return {
    completedSteps: (raw.completedSteps ?? []).filter((s) => STEP_SET.has(s)),
    currentStep:
      raw.currentStep && STEP_SET.has(raw.currentStep) ? raw.currentStep : undefined,
    completedAt: raw.completedAt ?? null,
    dismissedAt: raw.dismissedAt ?? null,
  };
}

/**
 * Merge a progress patch into the stored wizard state. Steps accumulate
 * (marking a step complete twice is fine); unknown step keys are rejected.
 */
export async function updateOnboardingState(
  organizationId: string,
  patch: {
    completeSteps?: string[];
    currentStep?: string;
    launched?: boolean;
    dismissed?: boolean;
  },
): Promise<OnboardingState | { error: string }> {
  const badStep = [...(patch.completeSteps ?? []), ...(patch.currentStep ? [patch.currentStep] : [])]
    .find((s) => !STEP_SET.has(s));
  if (badStep) return { error: `Unknown onboarding step: ${badStep}` };

  const current = await getOnboardingState(organizationId);
  const completed = [...current.completedSteps];
  for (const step of patch.completeSteps ?? []) {
    if (!completed.includes(step)) completed.push(step);
  }
  const next: OnboardingState = {
    completedSteps: completed,
    currentStep: patch.currentStep ?? current.currentStep,
    completedAt: patch.launched
      ? (current.completedAt ?? new Date().toISOString())
      : (current.completedAt ?? null),
    dismissedAt:
      patch.dismissed === undefined
        ? (current.dismissedAt ?? null)
        : patch.dismissed
          ? new Date().toISOString()
          : null,
  };
  await db
    .update(orgSettingsTable)
    .set({ onboarding: next })
    .where(eq(orgSettingsTable.organizationId, organizationId));
  return next;
}

/** Marker stored on demo records so they are identifiable and cleanable. */
export const TEST_LEAD_SOURCE_DETAIL = "onboarding-test-lead";

/**
 * Guided demo: create a clearly-marked sandbox lead that walks the new org
 * through the full journey — captured → scored → enrolled in the default
 * playbook → simulated reply — WITHOUT contacting anyone real. The demo
 * contact has no email or phone, so every outreach attempt is safely
 * skipped by the channel-reachability gate; the journey is narrated through
 * timeline activities instead.
 */
export async function createTestLead(organizationId: string): Promise<{
  leadId: string;
  contactId: string;
  score: number;
  enrolled: boolean;
}> {
  // One demo lead at a time — clean up any previous run first.
  await deleteTestLeads(organizationId);

  const [contact] = await db
    .insert(contactsTable)
    .values({
      organizationId,
      firstName: "Taylor",
      lastName: "Example (Test)",
      // Deliberately NO email or phone: outreach is skipped, never sent.
    })
    .returning();

  const scoring = await getLeadScoring(organizationId);
  const intentPoints = Object.values(scoring.intentPoints);
  const score = Math.min(
    100,
    (intentPoints.length ? Math.max(...intentPoints) : 20) +
      scoring.detailedDescriptionBonus,
  );

  const [lead] = await db
    .insert(leadsTable)
    .values({
      organizationId,
      contactId: contact.id,
      status: "new",
      source: "onboarding-test",
      sourceDetail: TEST_LEAD_SOURCE_DETAIL,
      creationMethod: "api",
      score,
      summary:
        "[TEST] Sample inquiry created by the onboarding wizard — shows how a new lead is captured, scored, and followed up automatically.",
    })
    .returning();

  const narrate = (type: string, description: string) =>
    db.insert(activitiesTable).values({
      organizationId,
      leadId: lead.id,
      type: "note",
      title: description,
      metadata: { onboardingDemo: true, stage: type },
    });

  await narrate("captured", "[TEST] Lead captured — this is where every new inquiry lands, from your website, forms, or connected systems.");
  await narrate("scored", `[TEST] Lead scored ${score}/100 using your scoring weights, so your team always works the hottest leads first.`);

  const enrollment = await autoEnrollLead(organizationId, lead.id);
  const enrolled = enrollment !== null;
  await narrate(
    "enrolled",
    enrolled
      ? "[TEST] Enrolled in your follow-up playbook. Because this demo contact has no email or phone, every touch is safely skipped — no real messages are ever sent."
      : "[TEST] Follow-up playbook not enrolled (it may be disabled) — real leads matching your rules are enrolled automatically.",
  );
  await narrate("replied", "[TEST] A reply from the customer would appear here and automatically pause the follow-up sequence.");

  return { leadId: lead.id, contactId: contact.id, score, enrolled };
}

/** Remove every sandbox record the guided demo created. Returns count removed. */
export async function deleteTestLeads(organizationId: string): Promise<number> {
  const leads = await db
    .select({ id: leadsTable.id, contactId: leadsTable.contactId })
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.organizationId, organizationId),
        eq(leadsTable.sourceDetail, TEST_LEAD_SOURCE_DETAIL),
      ),
    );
  if (leads.length === 0) return 0;
  const leadIds = leads.map((l) => l.id);
  const contactIds = [...new Set(leads.map((l) => l.contactId).filter((c): c is string => !!c))];

  await db.transaction(async (tx) => {
    await tx
      .delete(scheduledActionsTable)
      .where(
        and(
          eq(scheduledActionsTable.organizationId, organizationId),
          inArray(sql`${scheduledActionsTable.context} ->> 'leadId'`, leadIds),
        ),
      );
    await tx
      .delete(playbookEnrollmentsTable)
      .where(
        and(
          eq(playbookEnrollmentsTable.organizationId, organizationId),
          inArray(playbookEnrollmentsTable.leadId, leadIds),
        ),
      );
    await tx
      .delete(activitiesTable)
      .where(
        and(
          eq(activitiesTable.organizationId, organizationId),
          inArray(activitiesTable.leadId, leadIds),
        ),
      );
    await tx
      .delete(leadsTable)
      .where(
        and(
          eq(leadsTable.organizationId, organizationId),
          inArray(leadsTable.id, leadIds),
        ),
      );
    if (contactIds.length > 0) {
      await tx
        .delete(contactsTable)
        .where(
          and(
            eq(contactsTable.organizationId, organizationId),
            inArray(contactsTable.id, contactIds),
          ),
        );
    }
  });
  return leadIds.length;
}
