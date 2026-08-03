/**
 * AI Roof Concierge — server-side dialogue orchestration.
 *
 * The engine is a deterministic slot-filling state machine (so intake is
 * reliable and testable), with the AI provider interface used to produce the
 * internal sales summary. Guardrails: the assistant never guarantees
 * insurance approval, pricing, damage conclusions, or structural safety, and
 * emits emergency safety language when danger is indicated.
 */
import {
  DEFAULT_CONCIERGE_SETTINGS,
  type ConciergeIntent,
  type ConciergeSettings,
  activitiesTable,
  appointmentsTable,
  auditEventsTable,
  consentRecordsTable,
  contactsTable,
  conversationMessagesTable,
  conversationsTable,
  crmTasksTable,
  db,
  leadsTable,
  organizationsTable,
  propertiesTable,
  DEFAULT_LEAD_SCORING,
  type Conversation,
  type LeadScoringSettings,
  type Urgency,
} from "@workspace/db";
import { and, asc, eq, gt, gte, inArray, lt, lte, sql } from "drizzle-orm";

import {
  cancelScheduledFollowups,
  emitAutomationEvent,
  scheduleAppointmentReminder,
} from "./automation";
import {
  type AttributionInput,
  behaviorSignals,
  buildTouch,
  clampScore,
  leadAttributionColumns,
} from "./attribution";
import { insertInspectionIfAvailable } from "./inspection-booking";
import { stopEnrollmentsForLead } from "./playbooks";
import { recordLeadOutcome } from "./playbook-learning";
import { buildKnowledgeFacts, findKnowledgeAnswer } from "./knowledge";
import { isSafeMailbox, mockAiProvider, openAiProvider, providers, type AiProvider } from "./providers";
import { getAiInstructions, getConciergeSettings, getInspectionAvailability, getLeadScoring, getOrgSettings } from "./settings";

/** Concierge-scoped provider selection: real OpenAI when a key is present. */
function conciergeAi(): AiProvider {
  return process.env.OPENAI_API_KEY ? openAiProvider : mockAiProvider;
}

export const CONCIERGE_DISCLOSURE_VERSION = "concierge-v1-2026-08";

/** Effective org concierge config (defaults = original Painless behavior). */
export type ConciergeConfig = Required<ConciergeSettings>;

/** Intent catalog as a key-indexed map for a config. */
function intentMap(cfg: ConciergeConfig): Record<string, ConciergeIntent> {
  return Object.fromEntries(cfg.intents.map((i) => [i.key, i]));
}

const DEFAULT_CFG: ConciergeConfig = DEFAULT_CONCIERGE_SETTINGS;

type Step =
  | "intent"
  | "emergency_check"
  | "details"
  | "name"
  | "phone"
  | "email"
  | "address_street"
  | "address_city"
  | "property_type"
  | "contact_method"
  | "consent"
  | "scheduling"
  | "done";

export interface ConciergeState {
  step: Step;
  intent?: string;
  urgency: Urgency;
  emergencyFlag?: boolean;
  details?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string | null;
  addressLine1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  addressRaw?: string;
  addressRetries?: number;
  propertyType?: string;
  contactMethod?: string;
  consentGranted?: boolean;
  offeredSlots?: OfferedSlot[];
  appointmentId?: string;
  appointmentStart?: string;
  appointmentLabel?: string;
  confirmationSentVia?: string;
  slotDeclined?: boolean;
  contactId?: string;
  propertyId?: string;
  leadId?: string;
  [key: string]: unknown;
}

// Universal guardrails — deliberately NOT org-configurable: every industry
// gets the same protection against emergencies going unnoticed and against
// the assistant inventing pricing/insurance/safety conclusions.
const EMERGENCY_KEYWORDS = /collaps|sagging|sparking|pouring in|gushing|emergency/i;
const PROHIBITED_TOPIC = /how much|price|pricing|cost|quote|estimate\??$|will insurance|covered by insurance|approve|guarantee|total(ed| loss)|is it safe/i;
/** A visitor message that reads as a question rather than an intake answer. */
const QUESTION_LIKE = /\?\s*$/;

interface OfferedSlot {
  label: string;
  start: string; // ISO
  end: string; // ISO
}
function detectIntent(text: string, cfg: ConciergeConfig): string | undefined {
  const trimmed = text.trim().toLowerCase();
  const byLabel = cfg.intents.find((i) => i.label.toLowerCase() === trimmed);
  if (byLabel) return byLabel.key;
  const haystack = text.toLowerCase();
  for (const intent of cfg.intents) {
    if (intent.keywords.some((k) => haystack.includes(k))) return intent.key;
  }
  return undefined;
}

function isYes(text: string): boolean {
  return /^\s*(y|yes|yeah|yep|yup|correct|it is|sure)\b/i.test(text);
}
function isNo(text: string): boolean {
  return /^\s*(n|no|nope|nah|not)\b/i.test(text);
}

function promptFor(step: Step, state: ConciergeState, cfg: ConciergeConfig): { text: string; quickReplies: string[] } {
  switch (step) {
    case "intent":
      return {
        text: "What brought you in today? Pick the closest option or describe it in your own words.",
        quickReplies: cfg.intents.map((i) => i.label),
      };
    case "emergency_check":
      return {
        text: "Quick safety check: is water actively coming in right now, is any ceiling or roof section sagging, or is water near outlets or light fixtures?",
        quickReplies: ["Yes", "No"],
      };
    case "details":
      return {
        text: "Got it. In a sentence or two — when did this start, and what are you seeing?",
        quickReplies: [],
      };
    case "name":
      return { text: "What's your name?", quickReplies: [] };
    case "phone":
      return {
        text: `Thanks${state.firstName ? `, ${state.firstName}` : ""}. What's the best phone number to reach you?`,
        quickReplies: [],
      };
    case "email":
      return {
        text: "And your email? (Type “skip” if you'd rather not share it.)",
        quickReplies: ["Skip"],
      };
    case "address_street":
      return { text: "What's the street address of the property?", quickReplies: [] };
    case "address_city":
      return {
        text: "And the city, state and ZIP? (e.g. “Springfield, TX 75001”)",
        quickReplies: [],
      };
    case "property_type":
      return {
        text: "Is this a residential or commercial property?",
        quickReplies: ["Residential", "Commercial"],
      };
    case "contact_method":
      return {
        text: "How do you prefer we reach you — call, text, or email?",
        quickReplies: ["Call", "Text", "Email"],
      };
    case "consent":
      return {
        text: "Last step: do we have your permission to contact you by phone, text, and email about this request? Message and data rates may apply; you can opt out anytime. (Consent disclosure " + CONCIERGE_DISCLOSURE_VERSION + ")",
        quickReplies: ["Yes, you have my consent", "No"],
      };
    default:
      return { text: "", quickReplies: [] };
  }
}

export function scoreConcierge(
  state: ConciergeState,
  weights: LeadScoringSettings = DEFAULT_LEAD_SCORING,
  cfg: ConciergeConfig = DEFAULT_CFG,
): { score: number; scoreReasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const intent = state.intent ? intentMap(cfg)[state.intent] : undefined;
  if (intent && state.intent) {
    score += weights.intentPoints[state.intent] ?? intent.points;
    reasons.push(intent.reason);
  }
  if (state.urgency === "emergency") {
    score += weights.emergencyUrgencyBonus;
    reasons.push("Emergency conditions reported in concierge chat");
  } else if (state.urgency === "high") {
    score += weights.highUrgencyBonus;
    reasons.push("High urgency");
  }
  if (state.email) {
    score += weights.emailProvidedBonus;
    reasons.push("Email provided");
  }
  if (state.addressLine1 && state.postalCode) {
    score += weights.completeAddressBonus;
    reasons.push("Complete property address provided");
  }
  if (state.details && state.details.length > 40) {
    score += weights.detailedDescriptionBonus;
    reasons.push("Detailed problem description");
  }
  if (state.contactMethod) {
    score += weights.contactMethodBonus;
    reasons.push("Preferred contact method confirmed");
  }
  if (state.consentGranted) {
    score += weights.smsConsentBonus;
    reasons.push("Contact consent granted (fast follow-up possible)");
  }
  if (state.appointmentId) {
    score += 10;
    reasons.push("Inspection appointment booked in chat");
  }
  return { score: Math.max(0, Math.min(Math.round(score), 100)), scoreReasons: reasons };
}

function knownFacts(state: ConciergeState, cfg: ConciergeConfig = DEFAULT_CFG): string[] {
  const facts: string[] = [];
  const intent = state.intent ? intentMap(cfg)[state.intent] : undefined;
  if (intent) facts.push(`Request: ${intent.label} (recommended service: ${intent.service})`);
  facts.push(`Urgency: ${state.urgency}${state.emergencyFlag ? " — hazard conditions reported (safety guidance sent)" : ""}`);
  if (state.details) facts.push(`Homeowner description: ${state.details.slice(0, 300)}`);
  if (state.firstName) facts.push(`Name: ${[state.firstName, state.lastName].filter(Boolean).join(" ")}`);
  if (state.phone) facts.push(`Phone: ${state.phone}`);
  if (state.email) facts.push(`Email: ${state.email}`);
  if (state.addressLine1) {
    facts.push(
      `Property: ${state.addressLine1}${state.city ? `, ${state.city}` : ""}${state.state ? `, ${state.state}` : ""} ${state.postalCode ?? ""}`.trim(),
    );
  } else if (state.addressRaw) {
    facts.push(`Address (unparsed, verify with caller): ${state.addressRaw}`);
  }
  if (state.propertyType) facts.push(`Property type: ${state.propertyType}`);
  if (state.contactMethod) facts.push(`Preferred contact: ${state.contactMethod}`);
  if (state.appointmentId && state.appointmentStart) {
    facts.push(`Inspection appointment: booked in chat for ${new Date(state.appointmentStart).toISOString()}`);
  } else if (state.slotDeclined) {
    facts.push("Inspection appointment: homeowner skipped slot selection — team should call to schedule");
  }
  facts.push(
    state.consentGranted === undefined
      ? "Consent: not yet captured"
      : `Consent: ${state.consentGranted ? "granted" : "declined"} (${CONCIERGE_DISCLOSURE_VERSION})`,
  );
  return facts;
}

/** Deterministic internal summary used for partial/progressive updates. */
function buildPartialSummary(state: ConciergeState, cfg: ConciergeConfig = DEFAULT_CFG): string {
  return ["Concierge intake (in progress)", ...knownFacts(state, cfg)].join("\n");
}

/**
 * Progressive lead upsert — creates contact/lead as soon as name+phone exist
 * and keeps updating as more slots fill so abandoned chats aren't lost.
 */
async function syncLead(
  organizationId: string,
  conversation: Conversation,
  state: ConciergeState,
  opts: { sourceIp?: string; userAgent?: string; final?: boolean },
): Promise<void> {
  if (!state.firstName || !state.phone) return;
  const cfg = await getConciergeSettings(organizationId);
  const weights = await getLeadScoring(organizationId);
  const base = scoreConcierge(state, weights, cfg);
  // Website behavior signals (empty when the chat carried no visitor id).
  const behavior = await behaviorSignals(
    organizationId,
    typeof state.anonymousId === "string" ? state.anonymousId : null,
    weights,
  );
  const behaviorScored = {
    score: clampScore(base.score + behavior.points),
    scoreReasons: [...base.scoreReasons, ...behavior.reasons],
  };
  const intent = state.intent ? intentMap(cfg)[state.intent] : undefined;

  await db.transaction(async (tx) => {
    if (!state.contactId) {
      const [contact] = await tx
        .insert(contactsTable)
        .values({
          organizationId,
          firstName: state.firstName!,
          lastName: state.lastName ?? null,
          email: state.email ?? null,
          phone: state.phone!,
          preferredContactMethod: state.contactMethod ?? null,
        })
        .returning();
      state.contactId = contact.id;
    } else {
      await tx
        .update(contactsTable)
        .set({
          lastName: state.lastName ?? null,
          email: state.email ?? null,
          phone: state.phone!,
          // Persist the booking-time channel choice so later reminder
          // scheduling (e.g. after a CRM reschedule) honors it.
          preferredContactMethod: state.contactMethod ?? undefined,
        })
        .where(and(eq(contactsTable.id, state.contactId), eq(contactsTable.organizationId, organizationId)));
    }

    if (!state.propertyId && state.addressLine1 && state.city && state.state && state.postalCode) {
      const [property] = await tx
        .insert(propertiesTable)
        .values({
          organizationId,
          contactId: state.contactId!,
          addressLine1: state.addressLine1,
          city: state.city,
          state: state.state,
          postalCode: state.postalCode,
          propertyType: state.propertyType ?? null,
        })
        .returning();
      state.propertyId = property.id;
    }

    const source = conversation.source ?? "concierge";
    const touch = buildTouch({
      channel: "web_chat",
      source,
      attribution: (state.attribution as AttributionInput | undefined) ?? null,
    });
    if (!state.leadId) {
      const [lead] = await tx
        .insert(leadsTable)
        .values({
          organizationId,
          contactId: state.contactId!,
          propertyId: state.propertyId ?? null,
          status: opts.final ? "ai_qualified" : "new",
          urgency: state.urgency,
          serviceType: intent?.service ?? state.intent ?? null,
          sourceDetail: "ai-roof-concierge",
          score: behaviorScored.score,
          scoreReasons: behaviorScored.scoreReasons,
          summary: buildPartialSummary(state, cfg).split("\n").slice(0, 2).join(" — "),
          ...leadAttributionColumns({
            source,
            creationMethod: "concierge",
            touch,
            anonymousId: typeof state.anonymousId === "string" ? state.anonymousId : null,
          }),
        })
        .returning();
      state.leadId = lead.id;
      await tx
        .update(conversationsTable)
        .set({ leadId: lead.id, contactId: state.contactId })
        .where(eq(conversationsTable.id, conversation.id));
      await tx.insert(activitiesTable).values({
        organizationId,
        leadId: lead.id,
        contactId: state.contactId,
        type: "lead_captured",
        title: `Lead created by ${cfg.assistantName}`,
        body: buildPartialSummary(state, cfg),
        metadata: {
          conversationId: conversation.id,
          score: behaviorScored.score,
          scoreReasons: behaviorScored.scoreReasons,
        },
      });
      await tx.insert(auditEventsTable).values({
        organizationId,
        actorUserId: null,
        action: "lead.captured_concierge",
        entityType: "lead",
        entityId: lead.id,
        metadata: { conversationId: conversation.id },
      });
    } else {
      await tx
        .update(leadsTable)
        .set({
          propertyId: state.propertyId ?? null,
          urgency: state.urgency,
          serviceType: intent?.service ?? state.intent ?? null,
          score: behaviorScored.score,
          scoreReasons: behaviorScored.scoreReasons,
          status: opts.final ? "ai_qualified" : undefined,
          lastTouch: touch as unknown as Record<string, unknown>,
          latestSource: source,
        })
        .where(and(eq(leadsTable.id, state.leadId), eq(leadsTable.organizationId, organizationId)));
    }
  });
}

async function recordConsent(
  organizationId: string,
  state: ConciergeState,
  granted: boolean,
  opts: { sourceIp?: string; userAgent?: string },
): Promise<void> {
  if (!state.contactId) return;
  await db.insert(consentRecordsTable).values(
    (["sms", "email", "phone"] as const).map((channel) => ({
      organizationId,
      contactId: state.contactId!,
      channel,
      granted,
      disclosureVersion: CONCIERGE_DISCLOSURE_VERSION,
      sourceIp: opts.sourceIp ?? null,
      userAgent: opts.userAgent ?? null,
    })),
  );
}

export async function startConversation(params: {
  organizationId: string;
  source?: string;
  intentHint?: string;
  attribution?: AttributionInput | null;
  anonymousId?: string | null;
}): Promise<{
  conversationId: string;
  messages: string[];
  quickReplies: string[];
  emergency: boolean;
  done: boolean;
  leadId: string | null;
  urgency: Urgency;
}> {
  const cfg = await getConciergeSettings(params.organizationId);
  const intents = intentMap(cfg);
  const hinted = params.intentHint ? detectIntent(params.intentHint, cfg) : undefined;
  const state: ConciergeState = { step: "intent", urgency: "normal" };
  // Attribution + visitor id captured at chat start ride in the conversation
  // state; they reach the lead only if the visitor later identifies
  // themselves (name + phone) — anonymous chats never link.
  if (params.attribution) state.attribution = params.attribution;
  if (params.anonymousId && typeof params.anonymousId === "string") {
    state.anonymousId = params.anonymousId.slice(0, 100);
  }
  const messages: string[] = [
    cfg.greeting,
  ];
  let quickReplies: string[];
  if (hinted) {
    state.intent = hinted;
    state.urgency = intents[hinted].urgency;
    state.step = intents[hinted].triage ? "emergency_check" : "details";
    const p = promptFor(state.step, state, cfg);
    messages.push(p.text);
    quickReplies = p.quickReplies;
  } else {
    const p = promptFor("intent", state, cfg);
    messages.push(p.text);
    quickReplies = p.quickReplies;
  }

  const [conversation] = await db
    .insert(conversationsTable)
    .values({
      organizationId: params.organizationId,
      source: params.source ?? "public-site",
      intent: state.intent ?? null,
      urgency: state.urgency,
      state: state as Record<string, unknown>,
    })
    .returning();
  await db.insert(conversationMessagesTable).values(
    messages.map((content) => ({
      organizationId: params.organizationId,
      conversationId: conversation.id,
      role: "assistant" as const,
      content,
    })),
  );
  return {
    conversationId: conversation.id,
    messages,
    quickReplies,
    emergency: false,
    done: false,
    leadId: null,
    urgency: state.urgency,
  };
}

export async function handleMessage(params: {
  organizationId: string;
  conversationId: string;
  content: string;
  sourceIp?: string;
  userAgent?: string;
}): Promise<
  | {
      conversationId: string;
      messages: string[];
      quickReplies: string[];
      emergency: boolean;
      done: boolean;
      leadId: string | null;
      urgency: Urgency;
    }
  | null
> {
  const [conversation] = await db
    .select()
    .from(conversationsTable)
    .where(
      and(
        eq(conversationsTable.id, params.conversationId),
        eq(conversationsTable.organizationId, params.organizationId),
      ),
    );
  if (!conversation) return null;

  const state = { urgency: "normal", step: "intent", ...(conversation.state as Partial<ConciergeState>) } as ConciergeState;
  const text = params.content.trim();
  const out: string[] = [];
  let quickReplies: string[] = [];

  // Homeowner picked an abandoned chat back up: reactivate it, drop the
  // partial-summary snapshot, and cancel any pending abandoned-chat
  // follow-up automations so they aren't contacted about a chat they resumed.
  const resumed = conversation.status === "abandoned";
  if (resumed) {
    if (conversation.leadId) {
      const cancelled = await cancelScheduledFollowups(
        params.organizationId,
        conversation.leadId,
        "assessment.abandoned",
      );
      // Close out any auto-created "chase abandoned chat" tasks so a rep
      // doesn't call about a chat that's now active again.
      const closedTasks = await db
        .update(crmTasksTable)
        .set({ status: "done", completedAt: new Date() })
        .where(
          and(
            eq(crmTasksTable.organizationId, params.organizationId),
            eq(crmTasksTable.leadId, conversation.leadId),
            inArray(crmTasksTable.status, ["open", "in_progress"]),
            eq(crmTasksTable.sourceEvent, "assessment.abandoned"),
          ),
        )
        .returning({ id: crmTasksTable.id, title: crmTasksTable.title });
      // Visible timeline entry so the team can skip redundant outreach.
      await db.insert(activitiesTable).values({
        organizationId: params.organizationId,
        leadId: conversation.leadId,
        contactId: conversation.contactId ?? null,
        type: "conversation_resumed",
        title: "Homeowner resumed the concierge chat",
        body: [
          "The homeowner came back to a chat that had been marked abandoned — no need to chase this one.",
          cancelled > 0 ? `Cancelled ${cancelled} pending follow-up${cancelled === 1 ? "" : "s"}.` : null,
          closedTasks.length > 0
            ? `Closed ${closedTasks.length} auto-created follow-up task${closedTasks.length === 1 ? "" : "s"}: ${closedTasks.map((t) => t.title).join(", ")}.`
            : null,
        ]
          .filter(Boolean)
          .join(" "),
        metadata: {
          conversationId: conversation.id,
          cancelledFollowups: cancelled,
          closedTaskIds: closedTasks.map((t) => t.id),
        },
      });
      // The homeowner is actively chatting again — pause automated
      // playbook outreach so the concierge conversation isn't stepped on.
      await stopEnrollmentsForLead(
        params.organizationId,
        conversation.leadId,
        "homeowner resumed concierge chat",
        "paused",
      );
      // Learning loop: a resumed chat is a reply — attribute it to the
      // outreach touches that preceded it.
      await recordLeadOutcome(params.organizationId, conversation.leadId, "replied");
      await db.insert(auditEventsTable).values({
        organizationId: params.organizationId,
        actorUserId: null,
        action: "conversation.resumed",
        entityType: "conversation",
        entityId: conversation.id,
        metadata: { leadId: conversation.leadId, cancelledFollowups: cancelled },
      });
    } else {
      await db.insert(auditEventsTable).values({
        organizationId: params.organizationId,
        actorUserId: null,
        action: "conversation.resumed",
        entityType: "conversation",
        entityId: conversation.id,
        metadata: { leadId: null, cancelledFollowups: 0 },
      });
    }
  }

  await db.insert(conversationMessagesTable).values({
    organizationId: params.organizationId,
    conversationId: conversation.id,
    role: "user",
    content: text,
  });

  const cfg = await getConciergeSettings(params.organizationId);
  const intents = intentMap(cfg);

  // Global guardrail: pricing / insurance-approval / safety-conclusion asks.
  const prohibited = PROHIBITED_TOPIC.test(text) && state.step !== "consent";
  if (prohibited) {
    out.push(cfg.intakeDisclaimer);
  }
  // Global emergency keyword watch at any step.
  if (EMERGENCY_KEYWORDS.test(text) && !state.emergencyFlag) {
    state.emergencyFlag = true;
    state.urgency = "emergency";
    out.push(cfg.emergencySafety, cfg.emergencyEscalation);
  }

  // Knowledge-grounded Q&A: when the visitor asks a question mid-intake, the
  // concierge answers ONLY from the org knowledge base. On a match it quotes
  // the stored entry and re-asks the current step; with no match it says it
  // doesn't know (never guesses) and flags it for human follow-up. Yes/no
  // steps are exempt ("is that ok?" style answers must stay in the flow).
  let answeredQuestion = false;
  if (
    QUESTION_LIKE.test(text) &&
    !["emergency_check", "consent", "scheduling"].includes(state.step)
  ) {
    const entry = await findKnowledgeAnswer(params.organizationId, text);
    if (entry) {
      out.push(entry.content);
      answeredQuestion = true;
    } else if (!prohibited) {
      out.push(cfg.unknownAnswerFallback);
      state.openQuestions = [
        ...((state.openQuestions as string[] | undefined) ?? []),
        text.slice(0, 300),
      ].slice(-5);
      // Not a hard stop: intake continues so contact info still gets captured
      // for the human follow-up.
      answeredQuestion = state.step !== "intent";
    } else {
      answeredQuestion = state.step !== "intent";
    }
  }

  if (answeredQuestion) {
    const p = promptFor(state.step, state, cfg);
    if (p.text) out.push(p.text);
    quickReplies = p.quickReplies;
  } else
  switch (state.step) {
    case "intent": {
      const intent = detectIntent(text, cfg);
      if (!intent) {
        out.push("I want to route you to the right team. Which of these is closest to your situation?");
        quickReplies = cfg.intents.map((i) => i.label);
        break;
      }
      state.intent = intent;
      if (intents[intent].urgency !== "normal" || state.urgency === "normal") {
        state.urgency = state.emergencyFlag ? "emergency" : intents[intent].urgency;
      }
      state.step = intents[intent].triage && !state.emergencyFlag ? "emergency_check" : "details";
      break;
    }
    case "emergency_check": {
      if (isYes(text) || (state.emergencyFlag && !isNo(text))) {
        if (!state.emergencyFlag) {
          state.emergencyFlag = true;
          state.urgency = "emergency";
          out.push(cfg.emergencySafety, cfg.emergencyEscalation);
        }
      } else if (isNo(text)) {
        out.push("Good — no immediate hazard signs. Let's keep this moving.");
      } else {
        out.push("Just to be safe, is that a yes or a no?");
        quickReplies = ["Yes", "No"];
        break;
      }
      state.step = "details";
      break;
    }
    case "details": {
      state.details = text;
      if (!out.some((m) => m === cfg.intakeDisclaimer)) out.push(cfg.intakeDisclaimer);
      state.step = "name";
      break;
    }
    case "name": {
      const parts = text.replace(/^(i'?m|my name is|this is)\s+/i, "").split(/\s+/);
      state.firstName = parts[0];
      state.lastName = parts.slice(1).join(" ") || undefined;
      state.step = "phone";
      break;
    }
    case "phone": {
      const digits = text.replace(/\D/g, "");
      if (digits.length < 7) {
        out.push("That number looks short — could you share a full phone number with area code?");
        break;
      }
      state.phone = text;
      state.step = "email";
      break;
    }
    case "email": {
      if (/^skip$/i.test(text) || isNo(text)) {
        state.email = null;
      } else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
        state.email = text;
      } else {
        out.push("That doesn't look like a valid email — try again, or type “skip”.");
        quickReplies = ["Skip"];
        break;
      }
      state.step = "address_street";
      break;
    }
    case "address_street": {
      state.addressLine1 = text;
      state.step = "address_city";
      break;
    }
    case "address_city": {
      const m = text.match(/^(.+?)[,\s]+([A-Za-z]{2})[,\s]+(\d{4,10}(?:-\d{4})?)$/);
      if (m) {
        state.city = m[1].trim();
        state.state = m[2].toUpperCase();
        state.postalCode = m[3];
        state.step = "property_type";
      } else {
        state.addressRetries = (state.addressRetries ?? 0) + 1;
        if (state.addressRetries >= 2) {
          state.addressRaw = `${state.addressLine1 ?? ""} ${text}`.trim();
          out.push("No problem — I've noted the address as you wrote it and our team will confirm it with you.");
          state.step = "property_type";
        } else {
          out.push("Almost — could you give it as “City, ST 12345”?");
          break;
        }
      }
      break;
    }
    case "property_type": {
      state.propertyType = /comm/i.test(text) ? "commercial" : "residential";
      state.step = "contact_method";
      break;
    }
    case "contact_method": {
      state.contactMethod = /text|sms/i.test(text) ? "text" : /email/i.test(text) ? "email" : "call";
      state.step = "consent";
      break;
    }
    case "consent": {
      if (isYes(text)) {
        state.consentGranted = true;
      } else if (isNo(text)) {
        state.consentGranted = false;
        out.push("Understood — we won't contact you without permission. Your request is saved, and you're always welcome to call us directly.");
        state.step = "done";
        break;
      } else {
        out.push("Sorry — is that a yes or a no on being contacted?");
        quickReplies = ["Yes, you have my consent", "No"];
        break;
      }
      // Consent granted — offer real inspection windows before wrapping up.
      const slots = await generateInspectionSlots(params.organizationId);
      if (slots.length === 0) {
        state.step = "done";
        break;
      }
      state.offeredSlots = slots;
      state.step = "scheduling";
      out.push(
        [
          "Great — I can actually get your inspection on the calendar right now. Here are the next open windows:",
          ...slots.map((s, i) => `${i + 1}. ${s.label}`),
          "Pick one, or skip and our team will call to arrange a time.",
        ].join("\n"),
      );
      quickReplies = [...slots.map((s) => s.label), SLOT_SKIP_LABEL];
      break;
    }
    case "scheduling": {
      const slots = state.offeredSlots ?? [];
      if (/^skip\b/i.test(text) || isNo(text) || text === SLOT_SKIP_LABEL) {
        state.slotDeclined = true;
        out.push("No problem — our team will reach out to find a time that works for you.");
        state.step = "done";
        break;
      }
      const slot = matchSlot(text, slots);
      if (!slot) {
        out.push("Sorry, I didn't catch that — pick one of the windows below, or skip.");
        quickReplies = [...slots.map((s) => s.label), SLOT_SKIP_LABEL];
        break;
      }
      const appointment = await bookInspectionSlot({
        organizationId: params.organizationId,
        slot,
        leadId: state.leadId ?? null,
        contactId: state.contactId ?? null,
        propertyId: state.propertyId ?? null,
        notes: `Booked by ${cfg.assistantName} during chat${state.intent ? ` (${intents[state.intent]?.label ?? state.intent})` : ""}.`,
      });
      if (!appointment) {
        // Someone else grabbed this window between offer and booking — re-offer.
        const fresh = await generateInspectionSlots(params.organizationId);
        if (fresh.length === 0) {
          state.offeredSlots = [];
          state.slotDeclined = true;
          out.push(
            "I'm sorry — that window was just taken by another homeowner, and I don't see any other open windows right now. Our team will call you to find a time that works.",
          );
          state.step = "done";
          break;
        }
        state.offeredSlots = fresh;
        out.push(
          [
            "I'm sorry — that window was just booked by someone else. Here are the windows still open:",
            ...fresh.map((s, i) => `${i + 1}. ${s.label}`),
            "Pick one, or skip and our team will call to arrange a time.",
          ].join("\n"),
        );
        quickReplies = [...fresh.map((s) => s.label), SLOT_SKIP_LABEL];
        break;
      }
      state.appointmentId = appointment.id;
      state.appointmentStart = slot.start;
      state.appointmentLabel = slot.label;
      // Queue the ~24h no-show reminder via the homeowner's preferred channel.
      try {
        await scheduleAppointmentReminder(
          params.organizationId,
          {
            id: appointment.id,
            leadId: state.leadId ?? null,
            contactId: state.contactId ?? null,
            scheduledStart: new Date(slot.start),
          },
          state.contactMethod,
        );
      } catch (err) {
        console.error("[concierge] reminder scheduling failed:", err);
      }
      if (state.leadId) {
        await db.insert(activitiesTable).values({
          organizationId: params.organizationId,
          leadId: state.leadId,
          contactId: state.contactId ?? null,
          type: "appointment_scheduled",
          title: `Inspection booked via AI Concierge — ${slot.label}`,
          body: `Homeowner selected this window in chat. Appointment ${appointment.id}.`,
          metadata: { conversationId: conversation.id, appointmentId: appointment.id, scheduledStart: slot.start },
        });
      }
      await db.insert(auditEventsTable).values({
        organizationId: params.organizationId,
        actorUserId: null,
        action: "appointment.booked_concierge",
        entityType: "appointment",
        entityId: appointment.id,
        metadata: { conversationId: conversation.id, leadId: state.leadId ?? null },
      });
      // Run the org's appointment.booked automations for chat bookings too
      // (same event the CRM API emits). The direct chat confirmation below is
      // separate and sent exactly once (guarded by confirmationSentVia); any
      // additional messaging here comes only from org-configured rules.
      emitAutomationEvent(params.organizationId, "appointment.booked", {
        appointmentId: appointment.id,
        leadId: state.leadId ?? undefined,
        contactId: state.contactId ?? undefined,
        actorUserId: null,
        fields: {
          "appointment.type": "inspection",
          "appointment.source": "concierge",
          ...(state.urgency ? { "lead.urgency": state.urgency } : {}),
        },
      });
      out.push(
        `📅 You're booked: ${slot.label}. A licensed inspector will come to ${state.addressLine1 ?? "your property"} — if that time stops working, just call us and we'll move it.`,
      );
      state.step = "done";
      break;
    }
    case "done":
      out.push("You're all set — your request is with our team. If anything changes (especially new leaks or sagging), call us right away.");
      break;
  }

  // Ask the next question if the conversation isn't finished.
  const finishing = state.step === "done" && (conversation.status === "active" || resumed);
  if (state.step !== "done" && quickReplies.length === 0) {
    const p = promptFor(state.step, state, cfg);
    if (p.text) out.push(p.text);
    quickReplies = p.quickReplies;
  }

  // Progressive lead sync + consent + finalization.
  await syncLead(params.organizationId, conversation, state, {
    sourceIp: params.sourceIp,
    userAgent: params.userAgent,
    final: finishing,
  });
  if (finishing && state.consentGranted !== undefined) {
    await recordConsent(params.organizationId, state, state.consentGranted, params);
  }

  // Appointment confirmation — sent once, after consent has been recorded,
  // to the homeowner's preferred contact channel. Never breaks the chat.
  if (finishing && state.appointmentId && !state.confirmationSentVia) {
    try {
      const sentVia = await sendBookingConfirmation(params.organizationId, conversation.id, state);
      if (sentVia) {
        state.confirmationSentVia = sentVia.channel;
        out.push(
          sentVia.channel === "email"
            ? `📧 I've emailed a confirmation with your inspection time to ${sentVia.to}.`
            : `📲 I've texted a confirmation with your inspection time to ${sentVia.to}.`,
        );
      }
    } catch (err) {
      console.error("[concierge] booking confirmation failed:", err);
    }
  }

  let salesSummary: string | undefined;
  if (finishing) {
    const transcript = await db
      .select()
      .from(conversationMessagesTable)
      .where(eq(conversationMessagesTable.conversationId, conversation.id))
      .orderBy(asc(conversationMessagesTable.createdAt));
    const finalWeights = await getLeadScoring(params.organizationId);
    const finalBase = scoreConcierge(state, finalWeights, cfg);
    const finalBehavior = await behaviorSignals(
      params.organizationId,
      typeof state.anonymousId === "string" ? state.anonymousId : null,
      finalWeights,
    );
    const score = clampScore(finalBase.score + finalBehavior.points);
    const scoreReasons = [...finalBase.scoreReasons, ...finalBehavior.reasons];
    try {
      const orgInstructions = await getAiInstructions(params.organizationId);
      const knowledgeFacts = await buildKnowledgeFacts(params.organizationId);
      const ai = await conciergeAi().generateSalesSummary({
        intent: state.intent,
        urgency: state.urgency,
        facts: orgInstructions
          ? [...knownFacts(state, cfg), ...knowledgeFacts, `Org instructions: ${orgInstructions}`]
          : [...knownFacts(state, cfg), ...knowledgeFacts],
        transcript: transcript.map((m) => ({ role: m.role, content: m.content })),
      });
      salesSummary = ai.summary;
    } catch (err) {
      console.warn("[concierge] AI provider failed for sales summary, using mock provider:", err);
      salesSummary = (
        await mockAiProvider.generateSalesSummary({
          intent: state.intent,
          urgency: state.urgency,
          facts: knownFacts(state, cfg),
          transcript: [],
        })
      ).summary;
    }
    if (state.leadId) {
      await db
        .update(leadsTable)
        .set({ summary: salesSummary.split("\n")[0], score, scoreReasons })
        .where(and(eq(leadsTable.id, state.leadId), eq(leadsTable.organizationId, params.organizationId)));
      await db.insert(activitiesTable).values({
        organizationId: params.organizationId,
        leadId: state.leadId,
        contactId: state.contactId ?? null,
        type: "ai_summary",
        title: "AI Concierge sales summary",
        body: salesSummary,
        metadata: { conversationId: conversation.id, score, scoreReasons },
      });
    }
    const intentInfo = state.intent ? intents[state.intent] : undefined;
    out.push(
      [
        state.urgency === "emergency"
          ? "✅ Done — you're flagged as a same-day emergency and a priority callback is queued."
          : state.appointmentId
            ? "✅ Done — your request is in and your inspection is on our calendar."
            : "✅ Done — your request is in and our team will reach out soon.",
        intentInfo ? `Recommended service: ${intentInfo.label} → ${intentInfo.service.replace(/-/g, " ")}.` : "",
        cfg.wrapUpNote,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  await db
    .update(conversationsTable)
    .set({
      state: state as Record<string, unknown>,
      intent: state.intent ?? null,
      urgency: state.urgency,
      status: finishing ? "completed" : resumed ? "active" : conversation.status,
      // On resume, clear the abandoned-chat partial summary so the CRM does
      // not show a stale "in progress" snapshot on an active conversation.
      salesSummary: salesSummary ?? (resumed ? null : conversation.salesSummary),
      leadId: state.leadId ?? conversation.leadId,
      contactId: state.contactId ?? conversation.contactId,
    })
    .where(eq(conversationsTable.id, conversation.id));

  await db.insert(conversationMessagesTable).values(
    out.map((content) => ({
      organizationId: params.organizationId,
      conversationId: conversation.id,
      role: "assistant" as const,
      content,
    })),
  );

  return {
    conversationId: conversation.id,
    messages: out,
    quickReplies,
    emergency: state.urgency === "emergency",
    done: state.step === "done",
    leadId: state.leadId ?? null,
    urgency: state.urgency,
  };
}

/**
 * Send the homeowner a booking confirmation (date/window, property address,
 * reschedule instructions) via their preferred contact channel. Respects the
 * consent captured in chat: never sends unless consent was granted (which is
 * also required to reach the scheduling step). Logs an activity on the lead
 * and an audit event. Returns the channel used, or null when skipped.
 */
async function sendBookingConfirmation(
  organizationId: string,
  conversationId: string,
  state: ConciergeState,
): Promise<{ channel: "email" | "sms"; to: string } | null> {
  if (!state.appointmentId || !state.appointmentStart || state.consentGranted !== true) return null;

  const settings = await getOrgSettings(organizationId);
  const [orgRow] = await db
    .select({ name: organizationsTable.name })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, organizationId));
  const businessName = settings.businessProfile.businessName ?? orgRow?.name ?? "Our team";
  const businessPhone = settings.businessProfile.phone ?? "";

  const windowLabel =
    state.appointmentLabel ??
    new Intl.DateTimeFormat("en-US", {
      timeZone: process.env.CONCIERGE_TIMEZONE ?? "America/New_York",
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      hour12: true,
    }).format(new Date(state.appointmentStart));
  const address =
    [state.addressLine1, state.city, state.state, state.postalCode].filter(Boolean).join(", ") ||
    state.addressRaw ||
    "your property";
  const reschedule = businessPhone
    ? `Need to reschedule? Call or text us at ${businessPhone} and we'll find a time that works.`
    : `Need to reschedule? Reply to this message or contact our office and we'll find a time that works.`;

  // Preferred channel first (email if they chose email and shared one; text
  // otherwise), falling back to whichever contact detail we actually have.
  const emailOk = Boolean(state.email && isSafeMailbox(state.email));
  const useEmail = state.contactMethod === "email" ? emailOk : emailOk && !state.phone;

  const bodyLines = [
    `Hi ${state.firstName ?? "there"},`,
    "",
    `Your inspection with ${businessName} is confirmed.`,
    `🗓 When: ${windowLabel}`,
    `🏠 Where: ${address}`,
    "",
    reschedule,
    "",
    `— ${businessName}`,
  ];

  let channel: "email" | "sms";
  let to: string;
  let providerResult: { id: string; provider: string };
  if (useEmail) {
    channel = "email";
    to = state.email!;
    providerResult = await providers.email.send(
      to,
      `Your inspection is confirmed — ${windowLabel}`,
      bodyLines.join("\n"),
    );
  } else if (state.phone) {
    channel = "sms";
    to = state.phone;
    providerResult = await providers.sms.send(
      to,
      `${businessName}: your inspection is confirmed for ${windowLabel} at ${address}. ${reschedule}`,
    );
  } else if (emailOk) {
    channel = "email";
    to = state.email!;
    providerResult = await providers.email.send(
      to,
      `Your inspection is confirmed — ${windowLabel}`,
      bodyLines.join("\n"),
    );
  } else {
    return null;
  }

  if (state.leadId) {
    await db.insert(activitiesTable).values({
      organizationId,
      leadId: state.leadId,
      contactId: state.contactId ?? null,
      type: "confirmation_sent",
      title: `Inspection confirmation sent via ${channel} — ${windowLabel}`,
      body: `Booking confirmation sent to ${to} (preferred contact: ${state.contactMethod ?? "unknown"}). Provider: ${providerResult.provider}.`,
      metadata: {
        conversationId,
        appointmentId: state.appointmentId,
        channel,
        to,
        provider: providerResult.provider,
        providerMessageId: providerResult.id,
        mock: providerResult.provider.startsWith("mock"),
      },
    });
  }
  await db.insert(auditEventsTable).values({
    organizationId,
    actorUserId: null,
    action: "appointment.confirmation_sent",
    entityType: "appointment",
    entityId: state.appointmentId,
    metadata: {
      conversationId,
      leadId: state.leadId ?? null,
      channel,
      provider: providerResult.provider,
      mock: providerResult.provider.startsWith("mock"),
    },
  });
  return { channel, to };
}

/** Idle threshold after which an active conversation counts as abandoned. */
export const ABANDONED_AFTER_MS = 30 * 60_000;

/**
 * Periodic job: mark conversations idle for >30 minutes as abandoned, persist
 * their partial sales summary, and emit `assessment.abandoned` for the linked
 * lead so automations can trigger a follow-up. Runs across all organizations.
 */
export async function markAbandonedConversations(
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - ABANDONED_AFTER_MS);
  const stale = await db
    .select()
    .from(conversationsTable)
    .where(and(eq(conversationsTable.status, "active"), lt(conversationsTable.updatedAt, cutoff)))
    .limit(50);

  let marked = 0;
  for (const conversation of stale) {
    const state = { urgency: "normal", step: "intent", ...(conversation.state as Partial<ConciergeState>) } as ConciergeState;
    const partialSummary = conversation.salesSummary ?? buildPartialSummary(state);
    const [updated] = await db
      .update(conversationsTable)
      .set({ status: "abandoned", salesSummary: partialSummary })
      .where(and(eq(conversationsTable.id, conversation.id), eq(conversationsTable.status, "active")))
      .returning();
    if (!updated) continue; // raced with a finishing message
    marked += 1;

    await db.insert(auditEventsTable).values({
      organizationId: conversation.organizationId,
      actorUserId: null,
      action: "conversation.abandoned",
      entityType: "conversation",
      entityId: conversation.id,
      metadata: { leadId: conversation.leadId, idleSince: conversation.updatedAt.toISOString() },
    });

    if (conversation.leadId) {
      await db.insert(activitiesTable).values({
        organizationId: conversation.organizationId,
        leadId: conversation.leadId,
        contactId: conversation.contactId ?? null,
        type: "ai_summary",
        title: "Concierge chat abandoned — partial intake summary",
        body: partialSummary,
        metadata: { conversationId: conversation.id, abandoned: true },
      });
      const [lead] = await db
        .select()
        .from(leadsTable)
        .where(
          and(
            eq(leadsTable.id, conversation.leadId),
            eq(leadsTable.organizationId, conversation.organizationId),
          ),
        );
      emitAutomationEvent(conversation.organizationId, "assessment.abandoned", {
        leadId: conversation.leadId,
        contactId: conversation.contactId ?? undefined,
        fields: {
          "conversation.status": "abandoned",
          "conversation.intent": conversation.intent ?? undefined,
          "lead.status": lead?.status,
          "lead.urgency": lead?.urgency,
          "lead.source": lead?.source,
        },
      });
    }
  }
  return marked;
}

export async function listLeadConversations(organizationId: string, leadId: string) {
  const conversations = await db
    .select()
    .from(conversationsTable)
    .where(and(eq(conversationsTable.organizationId, organizationId), eq(conversationsTable.leadId, leadId)))
    .orderBy(asc(conversationsTable.createdAt));
  const result = [];
  for (const c of conversations) {
    const messages = await db
      .select()
      .from(conversationMessagesTable)
      .where(eq(conversationMessagesTable.conversationId, c.id))
      .orderBy(asc(conversationMessagesTable.createdAt));
    result.push({
      id: c.id,
      leadId: c.leadId,
      status: c.status,
      intent: c.intent,
      urgency: c.urgency,
      salesSummary: c.salesSummary,
      source: c.source,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      })),
    });
  }
  return result;
}

function slotLabel(start: Date, end: Date, tz: string): string {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(start);
  const time = (d: Date) =>
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: true }).format(d);
  return `${day}, ${time(start)}–${time(end)}`;
}

/** Build a Date for a local wall-clock hour on the given UTC-midnight day in the scheduling TZ. */
function atLocalHour(dayUtc: Date, hour: number, tz: string): Date {
  // Target wall-clock instant expressed as if the zone were UTC, then correct
  // by probing the real local time. The correction must ITERATE: around DST
  // transitions the UTC offset at the guess can differ from the offset at the
  // corrected time, and a single-pass probe lands one hour off (homeowner told
  // 9 AM, calendar says 10 AM).
  const want = Date.UTC(dayUtc.getUTCFullYear(), dayUtc.getUTCMonth(), dayUtc.getUTCDate(), hour, 0, 0);
  let ts = want;
  for (let i = 0; i < 3; i++) {
    const got = tzParts(new Date(ts), tz);
    const gotWall = Date.UTC(got.y, got.m - 1, got.day, got.hour, got.minute, 0);
    const diff = want - gotWall;
    if (diff === 0) break;
    ts += diff;
  }
  return new Date(ts);
}

/** Local calendar parts of a Date in the scheduling timezone. */
function tzParts(d: Date, tz: string): { y: number; m: number; day: number; hour: number; minute: number; weekday: string } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour === "24" ? "0" : parts.hour),
    minute: Number(parts.minute),
    weekday: parts.weekday,
  };
}

const SLOT_SKIP_LABEL = "Skip — have the team call me";
/**
 * Offer the next 3 open inspection windows over the coming business days,
 * driven by the org's configured availability (days, windows, timezone,
 * blackout dates, and per-window booking capacity). Windows at capacity are
 * skipped.
 */
export async function generateInspectionSlots(organizationId: string): Promise<OfferedSlot[]> {
  const avail = await getInspectionAvailability(organizationId);
  const tz = avail.timezone;
  const now = new Date();
  const horizon = new Date(now.getTime() + 14 * 86_400_000);
  const existing = await db
    .select({ start: appointmentsTable.scheduledStart, end: appointmentsTable.scheduledEnd })
    .from(appointmentsTable)
    .where(
      and(
        eq(appointmentsTable.organizationId, organizationId),
        inArray(appointmentsTable.status, ["scheduled", "confirmed"]),
        gte(appointmentsTable.scheduledStart, now),
        lte(appointmentsTable.scheduledStart, horizon),
      ),
    );

  const blackouts = new Set(avail.blackoutDates);
  const slots: OfferedSlot[] = [];
  for (let offset = 1; offset <= 14 && slots.length < 3; offset++) {
    const day = new Date(now.getTime() + offset * 86_400_000);
    const dayUtc = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
    const noonLocal = tzParts(atLocalHour(dayUtc, 12, tz), tz);
    if (!avail.days.includes(noonLocal.weekday)) continue;
    const localDate = `${noonLocal.y}-${String(noonLocal.m).padStart(2, "0")}-${String(noonLocal.day).padStart(2, "0")}`;
    if (blackouts.has(localDate)) continue;
    for (const w of avail.windows) {
      if (slots.length >= 3) break;
      const start = atLocalHour(dayUtc, w.startHour, tz);
      const end = atLocalHour(dayUtc, w.endHour, tz);
      if (start.getTime() <= now.getTime()) continue;
      const overlapping = existing.filter((a) => {
        const aEnd = a.end ?? new Date(a.start.getTime() + 2 * 3_600_000);
        return a.start < end && aEnd > start;
      }).length;
      if (overlapping >= avail.maxBookingsPerWindow) continue;
      slots.push({ label: slotLabel(start, end, tz), start: start.toISOString(), end: end.toISOString() });
    }
  }
  return slots;
}
/**
 * Race-safe booking: takes a per-org/slot advisory transaction lock, re-checks
 * how many scheduled/confirmed appointments overlap the window, then inserts
 * while the org's configured per-window capacity allows it.
 * Returns null if the window is at capacity (caller should re-offer slots).
 */
export async function bookInspectionSlot(params: {
  organizationId: string;
  slot: { start: string; end: string };
  leadId?: string | null;
  contactId?: string | null;
  propertyId?: string | null;
  notes?: string;
}): Promise<{ id: string } | null> {
  const start = new Date(params.slot.start);
  const end = new Date(params.slot.end);
  const avail = await getInspectionAvailability(params.organizationId);
  const { maxBookingsPerWindow } = avail;
  // Policy check against *current* availability: a slot offered under older
  // settings must not be bookable after admins tighten day/window/blackout rules.
  const startLocal = tzParts(start, avail.timezone);
  const endLocal = tzParts(end, avail.timezone);
  if (!avail.days.includes(startLocal.weekday)) return null;
  const localDate = `${startLocal.y}-${String(startLocal.m).padStart(2, "0")}-${String(startLocal.day).padStart(2, "0")}`;
  if (avail.blackoutDates.includes(localDate)) return null;
  // Compare minutes too: in fractional-offset timezones (e.g. Asia/Kolkata
  // +5:30) a UTC instant on a whole or half hour can land on :30 local, and an
  // hour-only comparison would accept a slot 30 minutes off the configured
  // window. Offered slots are always minute-0 wall-clock (atLocalHour).
  const matchesWindow =
    startLocal.minute === 0 &&
    endLocal.minute === 0 &&
    avail.windows.some(
      (w) => w.startHour === startLocal.hour && (w.endHour % 24) === endLocal.hour,
    );
  if (!matchesWindow) return null;
  return insertInspectionIfAvailable({
    organizationId: params.organizationId,
    leadId: params.leadId ?? null,
    contactId: params.contactId ?? null,
    propertyId: params.propertyId ?? null,
    type: "inspection",
    status: "scheduled",
    scheduledStart: start,
    scheduledEnd: end,
    notes: params.notes ?? null,
  });
}

function matchSlot(text: string, slots: OfferedSlot[]): OfferedSlot | undefined {
  const t = text.trim().toLowerCase();
  const byLabel = slots.find((s) => s.label.toLowerCase() === t);
  if (byLabel) return byLabel;
  const idx = t.match(/^(?:option\s*|#\s*)?([1-3])\b/);
  if (idx) return slots[Number(idx[1]) - 1];
  return slots.find((s) => t.includes(s.label.toLowerCase().split(",")[0]));
}
