import {
  activitiesTable,
  appointmentsTable,
  automationRunsTable,
  automationsTable,
  consentRecordsTable,
  contactsTable,
  crmTasksTable,
  db,
  leadsTable,
  leadTagsTable,
  messageTemplatesTable,
  scheduledActionsTable,
  tagsTable,
  usersTable,
  type ActionResult,
  type Automation,
  type AutomationAction,
} from "@workspace/db";
import { and, desc, eq, lte, sql } from "drizzle-orm";
import { recordAudit } from "./audit";
import { isLegacyDefaultOrg } from "../lib/orgFlavor";
import {
  applyStageBehaviorToLead,
  autoEnrollLead,
  executePlaybookStep,
  stopEnrollmentsForLead,
} from "./playbooks";
import { recordLeadOutcome } from "./playbook-learning";
import { classifyWonLead, handlePostSaleTransition } from "./post-sale";
import { providers } from "./providers";
import {
  checkSendEligibility,
  handleProviderFailure,
  recordBlockedSend,
  unsubscribeFooter,
} from "./send-gate";
import { getAppointmentReminderSettings, getBusinessName, getOrgSettings } from "./settings";
import {
  cleanupExpiredPreviousSecrets,
  dispatchWebhookEvent,
  processPendingDeliveries,
} from "./webhooks";

/**
 * Event-driven automation engine. Events are emitted from CRM flows; rules
 * (automations table) match on event + simple equality conditions and run
 * their configured actions. Every run is recorded; every action is audited.
 * Outbound email/SMS goes through the configured providers (Twilio/Resend
 * when their secrets are set, labeled mocks otherwise).
 */

export type AutomationEventName =
  | "lead.created"
  | "lead.updated"
  | "lead.assigned"
  | "appointment.booked"
  | "estimate.sent"
  | "lead.inactive"
  | "review.request_due"
  | "assessment.abandoned"
  | "portal.photos_added";

export const AUTOMATION_EVENTS: AutomationEventName[] = [
  "lead.created",
  "lead.updated",
  "lead.assigned",
  "appointment.booked",
  "estimate.sent",
  "lead.inactive",
  "review.request_due",
  "assessment.abandoned",
  "portal.photos_added",
];

export interface EventContext {
  leadId?: string;
  contactId?: string;
  appointmentId?: string;
  actorUserId?: string | null;
  event?: string;
  /** Flattened match fields, e.g. { "lead.urgency": "emergency", "lead.status": "new" } */
  fields?: Record<string, unknown>;
}

/** Fire-and-forget entry point used by routes/services. Never throws. */
export function emitAutomationEvent(
  organizationId: string,
  event: AutomationEventName,
  context: EventContext,
): void {
  void runEvent(organizationId, event, context).catch((err) => {
    console.error(`[automation] event ${event} failed:`, err);
  });
}

/** Awaitable variant (used by tests and the scheduler). */
/**
 * Lead-lifecycle events mirrored to outbound webhook endpoints so outside
 * systems (Zapier, dialers, spreadsheets) can react in near-real-time.
 * Dispatch is fire-and-forget — a slow or broken webhook must never delay
 * CRM work (delivery retries live in the webhook queue itself).
 */
function mirrorToWebhooks(
  organizationId: string,
  event: string,
  context: EventContext,
): void {
  void dispatchWebhookEvent(organizationId, event, {
    leadId: context.leadId ?? null,
    contactId: context.contactId ?? null,
    appointmentId: context.appointmentId ?? null,
    ...(context.fields ?? {}),
  }).catch((err) => {
    console.error(`[webhooks] lifecycle dispatch ${event} failed:`, err);
  });
}

export async function runEvent(
  organizationId: string,
  event: AutomationEventName,
  context: EventContext,
): Promise<void> {
  // Outbound webhook mirror for lifecycle events.
  if (event === "lead.created" || event === "appointment.booked") {
    mirrorToWebhooks(organizationId, event, context);
  }
  if (event === "lead.updated" || event === "lead.assigned") {
    const s = context.fields?.["lead.status"];
    // Only mirror terminal events on a REAL status transition — a non-status
    // update to an already-won/lost lead must not re-emit the event.
    // Emitters that don't provide the flag are treated as transitions.
    const changed = context.fields?.["lead.statusChanged"] !== false;
    if (changed && (s === "qualified" || s === "won" || s === "lost")) {
      mirrorToWebhooks(organizationId, `lead.${s}`, context);
    }
  }
  // Closer Engine hooks: enroll new leads in an outreach playbook, and
  // stop live enrollments the moment the lead converts or advances.
  if (event === "lead.created" && context.leadId) {
    await autoEnrollLead(organizationId, context.leadId);
  } else if (event === "appointment.booked" && context.leadId) {
    await stopEnrollmentsForLead(
      organizationId,
      context.leadId,
      "inspection booked",
      "completed",
    );
    // Learning loop: attribute the booking to the outreach touches.
    await recordLeadOutcome(organizationId, context.leadId, "booked");
  } else if (
    (event === "lead.updated" || event === "lead.assigned") &&
    context.leadId
  ) {
    const status = context.fields?.["lead.status"];
    const statusChanged = context.fields?.["lead.statusChanged"] !== false;
    if (typeof status === "string") {
      // Org-configurable stage→behavior map (continue / pause / complete /
      // cancel / hand off to another playbook) for ACQUISITION sequences.
      // Defaults preserve the old fixed behavior: outreach stages continue,
      // everything else completes.
      await applyStageBehaviorToLead(organizationId, context.leadId, status);
    }
    // A lost lead also ends any live post-sale sequence.
    if (status === "lost") {
      await stopEnrollmentsForLead(
        organizationId,
        context.leadId,
        "lead marked lost",
        "stopped",
        "post_sale",
      );
    }
    // Learning loop: terminal stages close each touch's outcome chain.
    if (status === "won" || status === "lost") {
      await recordLeadOutcome(organizationId, context.leadId, status);
    }
    if (typeof status === "string" && statusChanged) {
      // Honest revenue attribution is recorded at first win, BEFORE any
      // post-sale enrollment fires for the same transition.
      if (status === "won") {
        await classifyWonLead(organizationId, context.leadId);
      }
      // Milestone-gated post-sale playbooks (review/referral/maintenance).
      await handlePostSaleTransition(organizationId, context.leadId, status);
    }
  }

  const rules = await db
    .select()
    .from(automationsTable)
    .where(
      and(
        eq(automationsTable.organizationId, organizationId),
        eq(automationsTable.event, event),
        eq(automationsTable.isActive, true),
      ),
    );
  for (const rule of rules) {
    if (!conditionsMatch(rule.conditions, context)) continue;
    await executeRule(rule, event, { ...context, event });
  }
}

function conditionsMatch(
  conditions: Record<string, unknown>,
  context: EventContext,
): boolean {
  const fields = context.fields ?? {};
  return Object.entries(conditions).every(
    ([key, expected]) => fields[key] === expected,
  );
}

async function executeRule(
  rule: Automation,
  event: string,
  context: EventContext,
): Promise<void> {
  const results: ActionResult[] = [];
  for (const action of rule.actions) {
    try {
      results.push(
        await executeAction(rule.organizationId, action, context, rule.id),
      );
    } catch (err) {
      results.push({
        type: action.type,
        status: "failed",
        detail: err instanceof Error ? err.message : "action failed",
      });
    }
  }
  const failed = results.filter((r) => r.status === "failed").length;
  const status =
    results.length === 0
      ? "skipped"
      : failed === results.length
        ? "failed"
        : failed > 0
          ? "partial"
          : "success";
  await db.insert(automationRunsTable).values({
    organizationId: rule.organizationId,
    automationId: rule.id,
    event,
    entityType: context.leadId
      ? "lead"
      : context.appointmentId
        ? "appointment"
        : null,
    entityId: context.leadId ?? context.appointmentId ?? null,
    status,
    actionResults: results,
  });
}

// ---------- actions ----------

async function executeAction(
  organizationId: string,
  action: AutomationAction,
  context: EventContext,
  automationId: string,
): Promise<ActionResult> {
  const audit = (detail: Record<string, unknown>) =>
    recordAudit({
      organizationId,
      action: `automation.${action.type}`,
      entityType: "automation",
      entityId: automationId,
      metadata: { ...detail, leadId: context.leadId ?? null },
    });

  switch (action.type) {
    case "playbook_step": {
      const result = await executePlaybookStep(
        organizationId,
        action.params as { enrollmentId?: string; stepIndex?: number },
      );
      await audit(result);
      return { type: action.type, ...result };
    }
    case "send_email":
    case "send_sms": {
      const channel = action.type === "send_email" ? "email" : "sms";
      const rendered = await renderTemplate(organizationId, action, context);
      if (!rendered.contact) {
        return { type: action.type, status: "skipped", detail: "no contact" };
      }
      const contact = rendered.contact;
      // Unified pre-send gate: DNC, suppressions, consent, quiet hours, caps.
      const gate = await checkSendEligibility({
        organizationId,
        contact,
        channel,
        kind: "outreach",
      });
      if (!gate.ok) {
        if (gate.outcome === "deferred") {
          // Quiet hours / frequency cap: re-queue this exact action for the
          // next allowed window instead of dropping it.
          await db.insert(scheduledActionsTable).values({
            organizationId,
            action,
            context: { ...context },
            runAt: gate.resumeAt,
          });
          await audit({
            deferred: gate.reason,
            resumeAt: gate.resumeAt.toISOString(),
            contactId: contact.id,
          });
          await recordBlockedSend({
            organizationId,
            channel,
            reason: gate.reason,
            outcome: "deferred",
            source: "automation",
            leadId: context.leadId ?? null,
            contactId: contact.id,
            resumeAt: gate.resumeAt,
          });
          return {
            type: action.type,
            status: "skipped",
            detail: `deferred: ${gate.reason} until ${gate.resumeAt.toISOString()}`,
          };
        }
        await audit({ blocked: gate.reason, contactId: contact.id });
        await recordBlockedSend({
          organizationId,
          channel,
          reason: gate.reason,
          outcome: "blocked",
          source: "automation",
          leadId: context.leadId ?? null,
          contactId: contact.id,
        });
        return {
          type: action.type,
          status: "skipped",
          detail: `blocked: ${gate.reason}`,
        };
      }
      let res: { id: string; provider: string };
      try {
        res =
          channel === "email"
            ? await providers.email.send(
                contact.email!,
                rendered.subject ?? `${await getBusinessName(organizationId)} update`,
                rendered.body + unsubscribeFooter(organizationId, contact.id),
              )
            : await providers.sms.send(contact.phone!, rendered.body);
      } catch (err) {
        // Permanently bad address → suppress so nothing retries it.
        const suppressed = await handleProviderFailure({
          organizationId,
          channel,
          address: channel === "email" ? contact.email! : contact.phone!,
          err,
          source: "automation",
        });
        if (!suppressed) throw err;
        await audit({ blocked: `suppressed:${suppressed}`, contactId: contact.id });
        await recordBlockedSend({
          organizationId,
          channel,
          reason: `suppressed:${suppressed}`,
          outcome: "blocked",
          source: "automation",
          leadId: context.leadId ?? null,
          contactId: contact.id,
        });
        return {
          type: action.type,
          status: "skipped",
          detail: `provider rejected address (${suppressed})`,
        };
      }
      // Count this touch toward the contact's frequency cap.
      if (context.leadId) {
        await db.insert(activitiesTable).values({
          organizationId,
          leadId: context.leadId,
          contactId: contact.id,
          type: "automation_message_sent",
          title: `Automation ${channel === "email" ? "email" : "text"} sent`,
          metadata: { automationId, channel, provider: res.provider },
        });
      }
      await audit({
        provider: res.provider,
        to: channel === "email" ? contact.email : contact.phone,
        mock: res.provider.startsWith("mock-"),
      });
      return {
        type: action.type,
        status: "success",
        detail: `${res.provider}:${res.id}`,
      };
    }
    case "create_task": {
      const params = action.params as {
        title?: string;
        assignedUserId?: string;
      };
      let assignedUserId: string | null = null;
      if (params.assignedUserId) {
        const [user] = await db
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(
            and(
              eq(usersTable.id, params.assignedUserId),
              eq(usersTable.organizationId, organizationId),
            ),
          );
        if (!user) {
          return {
            type: action.type,
            status: "failed",
            detail: "user not in org",
          };
        }
        assignedUserId = user.id;
      }
      await db.insert(crmTasksTable).values({
        organizationId,
        title: params.title ?? "Automated follow-up",
        // Human-readable note; the structured sourceEvent column below is
        // what other flows match on (e.g. closing abandoned-chat chase tasks
        // when the homeowner resumes), so description edits can't break them.
        description: context.event ? `Auto-created by automation (event: ${context.event})` : null,
        sourceEvent: context.event ?? null,
        leadId: context.leadId ?? null,
        assignedUserId,
      });
      await audit({ title: params.title ?? "Automated follow-up" });
      return { type: action.type, status: "success" };
    }
    case "assign_lead": {
      const params = action.params as { assignedUserId?: string };
      if (!context.leadId || !params.assignedUserId) {
        return {
          type: action.type,
          status: "skipped",
          detail: "missing lead or user",
        };
      }
      const [user] = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(
          and(
            eq(usersTable.id, params.assignedUserId),
            eq(usersTable.organizationId, organizationId),
          ),
        );
      if (!user) {
        return {
          type: action.type,
          status: "failed",
          detail: "user not in org",
        };
      }
      await db
        .update(leadsTable)
        .set({ assignedUserId: params.assignedUserId })
        .where(
          and(
            eq(leadsTable.id, context.leadId),
            eq(leadsTable.organizationId, organizationId),
          ),
        );
      await audit({ assignedUserId: params.assignedUserId });
      return { type: action.type, status: "success" };
    }
    case "change_stage": {
      const params = action.params as { status?: string };
      if (!context.leadId || !params.status) {
        return {
          type: action.type,
          status: "skipped",
          detail: "missing lead or status",
        };
      }
      await db
        .update(leadsTable)
        .set({ status: params.status as typeof leadsTable.$inferSelect.status })
        .where(
          and(
            eq(leadsTable.id, context.leadId),
            eq(leadsTable.organizationId, organizationId),
          ),
        );
      await audit({ status: params.status });
      return { type: action.type, status: "success" };
    }
    case "add_tag": {
      const params = action.params as { tagId?: string };
      if (!context.leadId || !params.tagId) {
        return {
          type: action.type,
          status: "skipped",
          detail: "missing lead or tag",
        };
      }
      const [tag] = await db
        .select({ id: tagsTable.id })
        .from(tagsTable)
        .where(
          and(
            eq(tagsTable.id, params.tagId),
            eq(tagsTable.organizationId, organizationId),
          ),
        );
      if (!tag) {
        return {
          type: action.type,
          status: "failed",
          detail: "tag not in org",
        };
      }
      await db
        .insert(leadTagsTable)
        .values({ organizationId, leadId: context.leadId, tagId: params.tagId })
        .onConflictDoNothing();
      await audit({ tagId: params.tagId });
      return { type: action.type, status: "success" };
    }
    case "call_webhook": {
      const queued = await dispatchWebhookEvent(
        organizationId,
        context.event ?? "automation",
        {
          leadId: context.leadId ?? null,
          appointmentId: context.appointmentId ?? null,
          fields: context.fields ?? {},
        },
      );
      await audit({ queuedDeliveries: queued });
      return {
        type: action.type,
        status: "success",
        detail: `${queued} deliveries queued`,
      };
    }
    case "appointment_reminder": {
      const appointmentId =
        typeof context.appointmentId === "string" ? context.appointmentId : null;
      if (!appointmentId) {
        return { type: action.type, status: "skipped", detail: "no appointment" };
      }
      const [appointment] = await db
        .select()
        .from(appointmentsTable)
        .where(
          and(
            eq(appointmentsTable.id, appointmentId),
            eq(appointmentsTable.organizationId, organizationId),
          ),
        );
      if (!appointment) {
        return { type: action.type, status: "skipped", detail: "appointment not found" };
      }
      // Stale-guard: only remind for still-active bookings at the originally
      // scheduled time. Cancel/reschedule paths also cancel pending reminders,
      // but this re-check makes stale sends impossible even if they miss.
      if (appointment.status !== "scheduled" && appointment.status !== "confirmed") {
        return {
          type: action.type,
          status: "skipped",
          detail: `appointment ${appointment.status}`,
        };
      }
      const expectedStart = context.fields?.["appointment.scheduledStart"];
      if (
        typeof expectedStart === "string" &&
        appointment.scheduledStart.toISOString() !== expectedStart
      ) {
        return { type: action.type, status: "skipped", detail: "appointment rescheduled" };
      }
      if (appointment.scheduledStart.getTime() <= Date.now()) {
        return { type: action.type, status: "skipped", detail: "appointment already started" };
      }

      // Resolve the homeowner contact (directly or via the lead).
      let contactId = appointment.contactId ?? context.contactId ?? null;
      if (!contactId && appointment.leadId) {
        const [lead] = await db
          .select({ contactId: leadsTable.contactId })
          .from(leadsTable)
          .where(
            and(
              eq(leadsTable.id, appointment.leadId),
              eq(leadsTable.organizationId, organizationId),
            ),
          );
        contactId = lead?.contactId ?? null;
      }
      if (!contactId) {
        return { type: action.type, status: "skipped", detail: "no contact" };
      }
      const [contact] = await db
        .select({
          id: contactsTable.id,
          firstName: contactsTable.firstName,
          email: contactsTable.email,
          phone: contactsTable.phone,
          preferredContactMethod: contactsTable.preferredContactMethod,
          doNotContact: contactsTable.doNotContact,
          doNotContactEmail: contactsTable.doNotContactEmail,
          doNotContactSms: contactsTable.doNotContactSms,
        })
        .from(contactsTable)
        .where(
          and(
            eq(contactsTable.id, contactId),
            eq(contactsTable.organizationId, organizationId),
          ),
        );
      if (!contact) {
        return { type: action.type, status: "skipped", detail: "contact not found" };
      }

      const settings = await getOrgSettings(organizationId);
      const businessName =
        await getBusinessName(organizationId);
      const businessPhone = settings.businessProfile.phone ?? "";
      const windowLabel = new Intl.DateTimeFormat("en-US", {
        timeZone: process.env.CONCIERGE_TIMEZONE ?? "America/New_York",
        weekday: "long",
        month: "short",
        day: "numeric",
        hour: "numeric",
        hour12: true,
      }).format(appointment.scheduledStart);
      const reschedule = businessPhone
        ? `Need to reschedule? Call or text us at ${businessPhone}.`
        : "Need to reschedule? Contact our office and we'll find a time that works.";
      // Admin-customizable copy (org settings), rendered with the same
      // placeholder syntax message templates use. Defaults keep the built-in
      // wording.
      const reminderSettings = await getAppointmentReminderSettings(
        organizationId,
      );
      const reminderVars: Record<string, string> = {
        "contact.firstName": contact.firstName ?? "there",
        "business.name": businessName,
        "business.phone": businessPhone,
        "appointment.window": windowLabel,
        "reschedule.line": reschedule,
      };
      const renderReminder = (input: string) =>
        input.replace(
          /\{\{\s*([\w.]+)\s*\}\}/g,
          (_, key: string) => reminderVars[key] ?? "",
        );
      const smsBody = renderReminder(reminderSettings.smsBody);
      const emailSubject = renderReminder(reminderSettings.emailSubject);
      const emailBody = renderReminder(reminderSettings.emailBody);

      // Channel choice: honor the homeowner's preferred contact method —
      // explicit booking-time preference (concierge) first, then the
      // preference stored on the contact record — falling back to whichever
      // channel is actually reachable. SMS is always consent-gated.
      const params = action.params as { contactMethod?: string | null };
      const rawPreference = (
        params.contactMethod ??
        contact.preferredContactMethod ??
        ""
      ).toLowerCase();
      const preference =
        rawPreference === "email"
          ? "email"
          : rawPreference === "text" || rawPreference === "sms"
            ? "sms"
            : null;
      // Transactional gate: DNC + suppression list + SMS consent (no quiet
      // hours — a reminder about an appointment the homeowner booked is
      // expected and time-sensitive).
      const smsAllowed = (
        await checkSendEligibility({
          organizationId,
          contact,
          channel: "sms",
          kind: "transactional",
        })
      ).ok;
      const emailAllowed = (
        await checkSendEligibility({
          organizationId,
          contact,
          channel: "email",
          kind: "transactional",
        })
      ).ok;
      let channel: "sms" | "email" | null = null;
      if (preference === "email") {
        channel = emailAllowed ? "email" : smsAllowed ? "sms" : null;
      } else {
        // "text"/"sms" preference, "call", or no preference: SMS-first
        // (consent-gated), email as fallback.
        channel = smsAllowed ? "sms" : emailAllowed ? "email" : null;
      }
      if (!channel) {
        await audit({
          blocked: "no_reachable_channel",
          appointmentId,
          contactId: contact.id,
        });
        return {
          type: action.type,
          status: "skipped",
          detail: "no reachable channel (missing details or SMS consent)",
        };
      }
      const res =
        channel === "email"
          ? await providers.email.send(contact.email!, emailSubject, emailBody)
          : await providers.sms.send(contact.phone!, smsBody);
      if (appointment.leadId) {
        await db.insert(activitiesTable).values({
          organizationId,
          leadId: appointment.leadId,
          contactId: contact.id,
          type: "appointment_reminder_sent",
          title: `Inspection reminder sent via ${channel === "email" ? "email" : "text"}`,
          body: `Reminder for the ${windowLabel} inspection window sent to ${channel === "email" ? contact.email : contact.phone}.`,
          metadata: {
            appointmentId,
            channel,
            provider: res.provider,
            scheduledStart: appointment.scheduledStart.toISOString(),
          },
        });
      }
      await audit({
        appointmentId,
        channel,
        provider: res.provider,
        to: channel === "email" ? contact.email : contact.phone,
        mock: res.provider.startsWith("mock-"),
      });
      return {
        type: action.type,
        status: "success",
        detail: `${channel}:${res.provider}:${res.id}`,
      };
    }
    case "schedule_followup": {
      const params = action.params as {
        delayMinutes?: number;
        action?: AutomationAction;
      };
      if (!params.action) {
        return {
          type: action.type,
          status: "skipped",
          detail: "no nested action",
        };
      }
      const delay = Math.max(1, params.delayMinutes ?? 60);
      await db.insert(scheduledActionsTable).values({
        organizationId,
        automationId,
        action: params.action,
        context: context as unknown as Record<string, unknown>,
        runAt: new Date(Date.now() + delay * 60_000),
      });
      await audit({ delayMinutes: delay, nested: params.action.type });
      return { type: action.type, status: "success", detail: `in ${delay}m` };
    }
    default:
      return {
        type: (action as { type: string }).type,
        status: "skipped",
        detail: "unknown action type",
      };
  }
}

// ---------- helpers ----------

/**
 * Cancel pending scheduled follow-up actions queued for a lead by a given
 * event (e.g. abandoned-chat follow-ups once the homeowner resumes the chat).
 * Returns the number of actions cancelled.
 */
export async function cancelScheduledFollowups(
  organizationId: string,
  leadId: string,
  event: AutomationEventName,
): Promise<number> {
  const cancelled = await db
    .update(scheduledActionsTable)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(scheduledActionsTable.organizationId, organizationId),
        eq(scheduledActionsTable.status, "pending"),
        sql`${scheduledActionsTable.context} ->> 'leadId' = ${leadId}`,
        sql`${scheduledActionsTable.context} ->> 'event' = ${event}`,
      ),
    )
    .returning({ id: scheduledActionsTable.id });
  return cancelled.length;
}

/** Context event marker used to find/cancel pending appointment reminders. */
export const APPOINTMENT_REMINDER_EVENT = "appointment.reminder";
async function renderTemplate(
  organizationId: string,
  action: AutomationAction,
  context: EventContext,
) {
  const params = action.params as {
    templateId?: string;
    body?: string;
    subject?: string;
  };
  let subject = params.subject;
  let body = params.body ?? "";
  if (params.templateId) {
    const [template] = await db
      .select()
      .from(messageTemplatesTable)
      .where(
        and(
          eq(messageTemplatesTable.id, params.templateId),
          eq(messageTemplatesTable.organizationId, organizationId),
          eq(messageTemplatesTable.isActive, true),
        ),
      );
    if (template) {
      subject = template.subject ?? subject;
      body = template.body;
    }
  }

  let contact: {
    id: string;
    firstName: string;
    email: string | null;
    phone: string | null;
    doNotContact: boolean;
    doNotContactEmail: boolean;
    doNotContactSms: boolean;
  } | null = null;
  let contactId = context.contactId;
  if (!contactId && context.leadId) {
    const [lead] = await db
      .select({ contactId: leadsTable.contactId })
      .from(leadsTable)
      .where(
        and(
          eq(leadsTable.id, context.leadId),
          eq(leadsTable.organizationId, organizationId),
        ),
      );
    contactId = lead?.contactId;
  }
  if (contactId) {
    const [row] = await db
      .select({
        id: contactsTable.id,
        firstName: contactsTable.firstName,
        email: contactsTable.email,
        phone: contactsTable.phone,
        doNotContact: contactsTable.doNotContact,
        doNotContactEmail: contactsTable.doNotContactEmail,
        doNotContactSms: contactsTable.doNotContactSms,
      })
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.id, contactId),
          eq(contactsTable.organizationId, organizationId),
        ),
      );
    contact = row ?? null;
  }

  const settings = await getOrgSettings(organizationId);
  const vars: Record<string, string> = {
    "contact.firstName": contact?.firstName ?? "there",
    "business.name":
      await getBusinessName(organizationId),
    "business.phone": settings.businessProfile.phone ?? "",
  };
  for (const [key, value] of Object.entries(context.fields ?? {})) {
    vars[key] = String(value ?? "");
  }
  const render = (input: string) =>
    input.replace(
      /\{\{\s*([\w.]+)\s*\}\}/g,
      (_, key: string) => vars[key] ?? "",
    );
  return {
    subject: subject ? render(subject) : undefined,
    body: render(body),
    contact,
  };
}

// ---------- scheduler ----------

let schedulerTimer: NodeJS.Timeout | null = null;

/**
 * Run one scheduler stage in isolation: a failure is logged, never thrown,
 * so one broken stage (e.g. a DB error while querying scheduled actions)
 * can't stop later stages like webhook retry delivery from running.
 */
async function runStage(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[automation] scheduler stage "${name}" failed:`, err);
  }
}

/** Stage 1: execute due scheduled automation actions. */
async function processDueScheduledActions(organizationId?: string): Promise<void> {
  const due = await db
    .select()
    .from(scheduledActionsTable)
    .where(
      and(
        eq(scheduledActionsTable.status, "pending"),
        lte(scheduledActionsTable.runAt, new Date()),
        organizationId
          ? eq(scheduledActionsTable.organizationId, organizationId)
          : undefined,
      ),
    )
    .limit(20);
  for (const item of due) {
    // Atomically CLAIM the row before executing: bump attempts guarded by a
    // compare-and-set on (status='pending', attempts unchanged). A concurrent
    // worker or overlapping tick loses the CAS and skips the row, so each
    // scheduled send executes at most once — no double sends, no duplicate
    // deferral re-queues, and frequency caps stay accurate.
    const [claimed] = await db
      .update(scheduledActionsTable)
      .set({ attempts: item.attempts + 1 })
      .where(
        and(
          eq(scheduledActionsTable.id, item.id),
          eq(scheduledActionsTable.status, "pending"),
          eq(scheduledActionsTable.attempts, item.attempts),
        ),
      )
      .returning({ id: scheduledActionsTable.id });
    if (!claimed) continue; // another worker took it
    try {
      await executeAction(
        item.organizationId,
        item.action,
        item.context as EventContext,
        item.automationId ?? item.id,
      );
      await db
        .update(scheduledActionsTable)
        .set({ status: "done" })
        .where(eq(scheduledActionsTable.id, item.id));
    } catch (err) {
      const attempts = item.attempts + 1;
      await db
        .update(scheduledActionsTable)
        .set({
          status: attempts >= 3 ? "failed" : "pending",
          lastError: err instanceof Error ? err.message : "failed",
          runAt: new Date(Date.now() + 5 * 60_000),
        })
        .where(eq(scheduledActionsTable.id, item.id));
    }
  }
}

/**
 * Process due scheduled actions, retry pending webhook deliveries, and run
 * housekeeping sweeps. Each stage is isolated (see runStage) so a crash in
 * one stage never skips the others — in particular, webhook retries and the
 * abandoned-chat sweep still run if executing scheduled actions throws.
 *
 * @param organizationId - When provided, only the scheduled-actions stage runs
 *   and it is restricted to that org. All other global housekeeping stages are
 *   skipped. This prevents parallel test workers from stealing each other's
 *   pending actions or processing each other's webhook deliveries.
 */
export async function processScheduledWork(organizationId?: string): Promise<void> {
  await runStage("scheduled-actions", () => processDueScheduledActions(organizationId));
  // Throttled reactivation campaigns release their next batch of leads into
  // playbook sequences (their first step becomes due on a later tick).
  // Dynamic import avoids a static circular dependency (reactivation →
  // playbooks → automation).
  await runStage("reactivation-drain", async () => {
    const { drainReactivationCampaigns } = await import("./reactivation");
    await drainReactivationCampaigns(organizationId);
  });
  // Skip the remaining global housekeeping stages when scoped to a single org
  // (i.e. in tests). Those stages are not org-specific and would interfere with
  // parallel test workers that own different portions of the shared database.
  if (organizationId) return;
  await runStage("webhook-retries", async () => {
    await processPendingDeliveries();
  });
  // Drop encrypted previous webhook secrets whose grace window has elapsed.
  await runStage("webhook-secret-cleanup", async () => {
    await cleanupExpiredPreviousSecrets();
  });
  // Flag concierge chats idle >30 min as abandoned (emits assessment.abandoned).
  // Dynamic import avoids a static circular dependency (concierge → automation).
  await runStage("abandoned-chat-sweep", async () => {
    const { markAbandonedConversations } = await import("./concierge");
    await markAbandonedConversations();
  });
  // Delete expired/consumed portal login codes and expired portal sessions.
  await runStage("portal-credential-cleanup", async () => {
    const { cleanupExpiredPortalCredentials } = await import("./portal");
    await cleanupExpiredPortalCredentials();
  });
  // Email org admins once when an active API key nears its expiry date.
  await runStage("api-key-expiry-reminders", async () => {
    const { processApiKeyExpiryReminders } = await import(
      "./api-key-expiry-reminder"
    );
    await processApiKeyExpiryReminders();
  });
  // Periodically delete orphaned public photo uploads (runs at most hourly).
  // maybeCleanupOrphanedUploads already catches its own errors.
  await maybeCleanupOrphanedUploads();
}

const UPLOAD_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
export function startAutomationScheduler(intervalMs = 60_000): void {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    void processScheduledWork().catch((err) =>
      console.error("[automation] scheduler tick failed:", err),
    );
  }, intervalMs);
  schedulerTimer.unref();
}

export function stopAutomationScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

/** Display name of the seeded abandoned-chat follow-up rule (editable by admins). */
export const DEFAULT_ABANDONED_FOLLOWUP_NAME = "Abandoned chat follow-up";

/**
 * Immutable seed identifier. Seeding keys on (organizationId, seedKey) — not
 * the mutable display name — and a partial unique index enforces at most one
 * row per org+seedKey. Because deleteAutomation only deactivates rows, a rule
 * an admin renamed, edited, or deleted is never re-seeded.
 */
export const DEFAULT_ABANDONED_FOLLOWUP_SEED_KEY =
  "default.assessment_abandoned_followup";

/**
 * Names of the editable message templates the seeded abandoned-chat rule
 * sends from. Seeded alongside the rule; admins edit them in
 * Command Center → Settings → Templates to change future follow-up copy.
 * message_templates has a unique (org, name) index, so name doubles as the
 * seed identity for these.
 */
export const DEFAULT_ABANDONED_SMS_TEMPLATE_NAME =
  "Abandoned chat follow-up (SMS)";
export async function listAutomations(organizationId: string) {
  return db
    .select()
    .from(automationsTable)
    .where(eq(automationsTable.organizationId, organizationId))
    .orderBy(automationsTable.createdAt);
}

export async function createAutomation(
  organizationId: string,
  input: {
    name: string;
    event: string;
    conditions?: Record<string, unknown>;
    actions?: AutomationAction[];
    isActive?: boolean;
  },
) {
  const [row] = await db
    .insert(automationsTable)
    .values({ ...input, organizationId })
    .returning();
  return row;
}

export async function updateAutomation(
  organizationId: string,
  id: string,
  input: Partial<{
    name: string;
    event: string;
    conditions: Record<string, unknown>;
    actions: AutomationAction[];
    isActive: boolean;
  }>,
) {
  const [row] = await db
    .update(automationsTable)
    .set(input)
    .where(
      and(
        eq(automationsTable.id, id),
        eq(automationsTable.organizationId, organizationId),
      ),
    )
    .returning();
  return row ?? null;
}

export async function deleteAutomation(organizationId: string, id: string) {
  const rows = await db
    .update(automationsTable)
    .set({ isActive: false })
    .where(
      and(
        eq(automationsTable.id, id),
        eq(automationsTable.organizationId, organizationId),
      ),
    )
    .returning({ id: automationsTable.id });
  return rows.length > 0;
}

export async function listAutomationRuns(
  organizationId: string,
  automationId?: string,
) {
  const scope = eq(automationRunsTable.organizationId, organizationId);
  return db
    .select()
    .from(automationRunsTable)
    .where(
      automationId
        ? and(scope, eq(automationRunsTable.automationId, automationId))
        : scope,
    )
    .orderBy(desc(automationRunsTable.createdAt))
    .limit(200);
}

/**
 * How the most recent send_email attempts are doing. Scans recent runs
 * (newest first) and counts consecutive failed send_email results until the
 * first success; skipped results (no contact email) are not send attempts
 * and are ignored. Used by the settings UI to warn admins when the email
 * connection (e.g. an expired Gmail token) is silently failing.
 */
export async function getEmailSendHealth(organizationId: string): Promise<{
  consecutiveFailures: number;
  lastFailureAt: string | null;
  lastFailureDetail: string | null;
}> {
  const runs = await db
    .select({
      actionResults: automationRunsTable.actionResults,
      createdAt: automationRunsTable.createdAt,
    })
    .from(automationRunsTable)
    .where(eq(automationRunsTable.organizationId, organizationId))
    .orderBy(desc(automationRunsTable.createdAt))
    .limit(50);

  let consecutiveFailures = 0;
  let lastFailureAt: string | null = null;
  let lastFailureDetail: string | null = null;
  outer: for (const run of runs) {
    for (const result of run.actionResults ?? []) {
      if (result.type !== "send_email" || result.status === "skipped") continue;
      if (result.status === "failed") {
        consecutiveFailures += 1;
        if (!lastFailureAt) {
          lastFailureAt = run.createdAt.toISOString();
          lastFailureDetail = result.detail ?? null;
        }
      } else {
        break outer;
      }
    }
  }
  return { consecutiveFailures, lastFailureAt, lastFailureDetail };
}
export async function listTemplates(organizationId: string) {
  return db
    .select()
    .from(messageTemplatesTable)
    .where(eq(messageTemplatesTable.organizationId, organizationId))
    .orderBy(messageTemplatesTable.name);
}

export async function createTemplate(
  organizationId: string,
  input: {
    name: string;
    channel: "email" | "sms";
    subject?: string | null;
    body: string;
  },
) {
  const [row] = await db
    .insert(messageTemplatesTable)
    .values({ ...input, organizationId })
    .returning();
  return row;
}

export async function updateTemplate(
  organizationId: string,
  id: string,
  input: Partial<{
    name: string;
    channel: "email" | "sms";
    subject: string | null;
    body: string;
    isActive: boolean;
  }>,
) {
  const [row] = await db
    .update(messageTemplatesTable)
    .set(input)
    .where(
      and(
        eq(messageTemplatesTable.id, id),
        eq(messageTemplatesTable.organizationId, organizationId),
      ),
    )
    .returning();
  return row ?? null;
}

export async function deleteTemplate(organizationId: string, id: string) {
  const rows = await db
    .update(messageTemplatesTable)
    .set({ isActive: false })
    .where(
      and(
        eq(messageTemplatesTable.id, id),
        eq(messageTemplatesTable.organizationId, organizationId),
      ),
    )
    .returning({ id: messageTemplatesTable.id });
  return rows.length > 0;
}

// ---------- tags ----------

export async function listTags(organizationId: string) {
  return db
    .select()
    .from(tagsTable)
    .where(eq(tagsTable.organizationId, organizationId))
    .orderBy(tagsTable.name);
}

export async function createTag(
  organizationId: string,
  input: { name: string; color?: string | null },
) {
  const [row] = await db
    .insert(tagsTable)
    .values({ ...input, organizationId })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

let lastUploadCleanupAt = 0;
/**
 * Seed the default `assessment.abandoned` follow-up rule for an organization.
 * Seeded ACTIVE (for both new and existing orgs): the SMS action is already
 * consent-gated by the engine, so it only ever reaches customers who opted in,
 * and the callback task is harmless. Admins can toggle or delete the rule in
 * Command Center → Settings → Automations. Safe to call repeatedly.
 */
export async function ensureDefaultAutomations(
  organizationId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // Per-org advisory lock serializes concurrent seeding (e.g. simultaneous
    // first logins + server boot) so the check-then-insert cannot race and
    // create duplicate default rules. Released automatically at commit.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`default-automations:${organizationId}`}))`,
    );
    const [existing] = await tx
      .select({ id: automationsTable.id, actions: automationsTable.actions })
      .from(automationsTable)
      .where(
        and(
          eq(automationsTable.organizationId, organizationId),
          eq(automationsTable.seedKey, DEFAULT_ABANDONED_FOLLOWUP_SEED_KEY),
        ),
      )
      .limit(1);

    // Seed (or find) the editable message templates the rule sends from.
    // Unique (org, name) index + advisory lock keep this idempotent.
    const seedTemplate = async (input: {
      name: string;
      channel: "email" | "sms";
      subject?: string;
      body: string;
    }): Promise<string> => {
      const [inserted] = await tx
        .insert(messageTemplatesTable)
        .values({ ...input, organizationId })
        .onConflictDoNothing()
        .returning({ id: messageTemplatesTable.id });
      if (inserted) return inserted.id;
      const [found] = await tx
        .select({ id: messageTemplatesTable.id })
        .from(messageTemplatesTable)
        .where(
          and(
            eq(messageTemplatesTable.organizationId, organizationId),
            eq(messageTemplatesTable.name, input.name),
          ),
        );
      return found.id;
    };

    if (existing) {
      // Upgrade path: orgs seeded before templates existed have the copy
      // hardcoded in action params. If (and only if) the bodies are still the
      // untouched defaults, wire the actions to freshly seeded templates so
      // admins can edit the copy. Rules an admin already customized are left
      // exactly as they are.
      const actions = existing.actions;
      const sms = actions.find((a) => a.type === "send_sms");
      const email = actions.find((a) => a.type === "send_email");
      const smsParams = (sms?.params ?? {}) as {
        templateId?: string;
        body?: string;
      };
      const emailParams = (email?.params ?? {}) as {
        templateId?: string;
        subject?: string;
        body?: string;
      };
      const smsIsDefault =
        sms && !smsParams.templateId && smsParams.body === DEFAULT_ABANDONED_SMS_BODY;
      const emailIsDefault =
        email &&
        !emailParams.templateId &&
        emailParams.body === DEFAULT_ABANDONED_EMAIL_BODY &&
        emailParams.subject === DEFAULT_ABANDONED_EMAIL_SUBJECT;
      if (!smsIsDefault && !emailIsDefault) return;
      const nextActions = await Promise.all(
        actions.map(async (a) => {
          if (a.type === "send_sms" && smsIsDefault) {
            const templateId = await seedTemplate({
              name: DEFAULT_ABANDONED_SMS_TEMPLATE_NAME,
              channel: "sms",
              body: DEFAULT_ABANDONED_SMS_BODY,
            });
            return { ...a, params: { ...a.params, templateId } };
          }
          if (a.type === "send_email" && emailIsDefault) {
            const templateId = await seedTemplate({
              name: DEFAULT_ABANDONED_EMAIL_TEMPLATE_NAME,
              channel: "email",
              subject: DEFAULT_ABANDONED_EMAIL_SUBJECT,
              body: DEFAULT_ABANDONED_EMAIL_BODY,
            });
            return { ...a, params: { ...a.params, templateId } };
          }
          return a;
        }),
      );
      await tx
        .update(automationsTable)
        .set({ actions: nextActions })
        .where(eq(automationsTable.id, existing.id));
      return;
    }

    // Fresh orgs get industry-neutral copy; only the legacy default org
    // keeps the historical roofing-flavored templates.
    const legacy = await isLegacyDefaultOrg(organizationId);
    const smsTemplateId = await seedTemplate({
      name: DEFAULT_ABANDONED_SMS_TEMPLATE_NAME,
      channel: "sms",
      body: legacy ? DEFAULT_ABANDONED_SMS_BODY : GENERIC_ABANDONED_SMS_BODY,
    });
    const emailTemplateId = await seedTemplate({
      name: DEFAULT_ABANDONED_EMAIL_TEMPLATE_NAME,
      channel: "email",
      subject: legacy
        ? DEFAULT_ABANDONED_EMAIL_SUBJECT
        : GENERIC_ABANDONED_EMAIL_SUBJECT,
      body: legacy ? DEFAULT_ABANDONED_EMAIL_BODY : GENERIC_ABANDONED_EMAIL_BODY,
    });

    await tx.insert(automationsTable).values({
      organizationId,
      name: DEFAULT_ABANDONED_FOLLOWUP_NAME,
      seedKey: DEFAULT_ABANDONED_FOLLOWUP_SEED_KEY,
      event: "assessment.abandoned",
      conditions: {},
      isActive: true,
      actions: [
        {
          type: "send_sms",
          params: {
            templateId: smsTemplateId,
            // Fallback copy if the template is ever deactivated or deleted.
            body: DEFAULT_ABANDONED_SMS_BODY,
          },
        },
        {
          type: "send_email",
          params: {
            templateId: emailTemplateId,
            subject: DEFAULT_ABANDONED_EMAIL_SUBJECT,
            body: DEFAULT_ABANDONED_EMAIL_BODY,
          },
        },
        {
          type: "create_task",
          params: { title: "Call back: homeowner abandoned concierge chat" },
        },
      ],
    });
  });
}

async function maybeCleanupOrphanedUploads(): Promise<void> {
  const now = Date.now();
  if (now - lastUploadCleanupAt < UPLOAD_CLEANUP_INTERVAL_MS) return;
  lastUploadCleanupAt = now;
  try {
    const { cleanupOrphanedUploads } = await import("./upload-cleanup");
    const result = await cleanupOrphanedUploads();
    if (result.deleted > 0 || result.errors > 0) {
      console.log(
        `[upload-cleanup] scanned=${result.scanned} deleted=${result.deleted} kept=${result.kept} errors=${result.errors}`,
      );
    }
  } catch (err) {
    console.error("[upload-cleanup] run failed:", err);
  }
}

/**
 * Queue a homeowner reminder before an appointment's scheduled start. The
 * lead time is org-configurable (Command Center → Settings; default ~24h).
 * Booked closer than the lead time → the reminder runs shortly after booking;
 * booked less than 2h out → skipped (the booking confirmation just went out).
 * The action re-verifies status and start time at send time, so cancelled or
 * rescheduled appointments never produce stale reminders.
 */
export async function scheduleAppointmentReminder(
  organizationId: string,
  appointment: {
    id: string;
    leadId?: string | null;
    contactId?: string | null;
    scheduledStart: Date;
  },
  contactMethod?: string | null,
): Promise<boolean> {
  const startMs = appointment.scheduledStart.getTime();
  const now = Date.now();
  if (startMs - now <= 2 * 3_600_000) return false;
  const { leadTimeHours } = await getAppointmentReminderSettings(organizationId);
  const runAt = new Date(Math.max(now, startMs - leadTimeHours * 3_600_000));
  await db.insert(scheduledActionsTable).values({
    organizationId,
    automationId: null,
    action: {
      type: "appointment_reminder",
      params: { contactMethod: contactMethod ?? null },
    },
    context: {
      event: APPOINTMENT_REMINDER_EVENT,
      appointmentId: appointment.id,
      leadId: appointment.leadId ?? undefined,
      contactId: appointment.contactId ?? undefined,
      fields: {
        "appointment.scheduledStart": appointment.scheduledStart.toISOString(),
      },
    } as unknown as Record<string, unknown>,
    runAt,
  });
  return true;
}

/**
 * Cancel pending reminders for an appointment (call on cancel/reschedule).
 * Returns the number cancelled.
 */
export async function cancelAppointmentReminders(
  organizationId: string,
  appointmentId: string,
): Promise<number> {
  const cancelled = await db
    .update(scheduledActionsTable)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(scheduledActionsTable.organizationId, organizationId),
        eq(scheduledActionsTable.status, "pending"),
        sql`${scheduledActionsTable.context} ->> 'appointmentId' = ${appointmentId}`,
        sql`${scheduledActionsTable.context} ->> 'event' = ${APPOINTMENT_REMINDER_EVENT}`,
      ),
    )
    .returning({ id: scheduledActionsTable.id });
  return cancelled.length;
}

export const DEFAULT_ABANDONED_EMAIL_TEMPLATE_NAME =
  "Abandoned chat follow-up (Email)";

const DEFAULT_ABANDONED_SMS_BODY =
  "Hi {{contact.firstName}}, this is {{business.name}} — looks like we got disconnected. Still want help with your roof? Pick up right where you left off, or call us at {{business.phone}} to schedule your free inspection.";

const DEFAULT_ABANDONED_EMAIL_SUBJECT =
  "Still there? Let's finish your roof assessment";

const DEFAULT_ABANDONED_EMAIL_BODY =
  "Hi {{contact.firstName}},\n\nIt looks like we got disconnected while going over your roof concern. We'd hate for a small issue to turn into a big one — you can pick up your assessment right where you left off, or call {{business.phone}} and we'll get your free inspection on the calendar.\n\n— {{business.name}}";

// Industry-neutral copy seeded for non-legacy orgs (fresh sign-ups).
const GENERIC_ABANDONED_SMS_BODY =
  "Hi {{contact.firstName}}, this is {{business.name}} — looks like we got disconnected. Still want a hand? Pick up right where you left off, or call us at {{business.phone}} and we'll get you scheduled.";

const GENERIC_ABANDONED_EMAIL_SUBJECT =
  "Still there? Let's pick up where we left off";

const GENERIC_ABANDONED_EMAIL_BODY =
  "Hi {{contact.firstName}},\n\nIt looks like we got disconnected while going over your request. You can pick up right where you left off, or call {{business.phone}} and we'll get you on the calendar.\n\n— {{business.name}}";
