import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

export interface BusinessProfile {
  businessName?: string;
  phone?: string;
  email?: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  hours?: string;
  emergencyAvailability?: boolean;
  website?: string;
  facebookUrl?: string;
  googleBusinessUrl?: string;
}

export interface ServiceEntry {
  slug: string;
  name: string;
  description?: string;
  isActive: boolean;
}

export interface ServiceAreaEntry {
  slug: string;
  name: string;
  state?: string;
  isActive: boolean;
}

/**
 * Embeddable website widget (closer.js) configuration. All values are public
 * — they are served verbatim to any site holding the org's installation key.
 */
export interface WidgetSettings {
  /** Master switch for the lead-capture launcher module. */
  leadCaptureEnabled: boolean;
  /** AI concierge chat module (uses the org knowledge base + intake flow). */
  conciergeEnabled?: boolean;
  /** CSS color for the launcher & accents (e.g. "#0f766e"). */
  primaryColor?: string;
  /** Corner the launcher docks to. */
  position?: "left" | "right";
  /** Greeting shown at the top of the open panel. */
  greeting?: string;
  /** Label on the launcher button. */
  buttonLabel?: string;
  /**
   * Test mode: the widget stays hidden for normal visitors and only renders
   * when the page URL carries the `mf_preview=1` flag (admin preview link).
   */
  testMode?: boolean;
}

export const DEFAULT_WIDGET_SETTINGS: Required<WidgetSettings> = {
  leadCaptureEnabled: true,
  conciergeEnabled: false,
  primaryColor: "#0f766e",
  position: "right",
  greeting: "Have a question? Leave your details and we'll get right back to you.",
  buttonLabel: "Get in touch",
  testMode: false,
};

/** One selectable concierge intent (what the visitor is asking about). */
export interface ConciergeIntent {
  /** Stable key stored on conversations/leads (e.g. "leak"). */
  key: string;
  /** Quick-reply label shown to visitors (e.g. "Active leak"). */
  label: string;
  /** CRM service slug recommended for this intent. */
  service: string;
  /** Base lead-score points for this intent. */
  points: number;
  /** Score-reason text shown to reps. */
  reason: string;
  urgency: "normal" | "high" | "emergency";
  /** Whether this intent runs the emergency triage question first. */
  triage: boolean;
  /** Case-insensitive substrings that detect this intent in free text (priority = array order). */
  keywords: string[];
}

/**
 * Org-configurable AI concierge behavior. Replaces the hardcoded roofing
 * intents/copy so any industry can use the concierge; the defaults preserve
 * the original Painless roofing behavior exactly.
 */
export interface ConciergeSettings {
  /** Assistant display name (widget header, transcripts). */
  assistantName?: string;
  /** Opening greeting for every chat. */
  greeting?: string;
  /** Intent catalog; order = keyword-match priority and quick-reply order. */
  intents?: ConciergeIntent[];
  /** Guardrail line sent when pricing/insurance/safety conclusions are asked. */
  intakeDisclaimer?: string;
  /** Safety guidance sent when emergency conditions are indicated. */
  emergencySafety?: string;
  /** Escalation promise sent alongside the safety guidance. */
  emergencyEscalation?: string;
  /** Reply when a visitor asks something the knowledge base can't answer. */
  unknownAnswerFallback?: string;
  /** Closing reminder appended to the wrap-up message. */
  wrapUpNote?: string;
}

export const DEFAULT_CONCIERGE_INTENTS: ConciergeIntent[] = [
  { key: "leak", label: "Active leak", service: "roof-repair", points: 40, reason: "Active leak reported", urgency: "emergency", triage: true, keywords: ["leak", "dripping", "drip"] },
  { key: "water-damage", label: "Water damage", service: "water-damage-restoration", points: 30, reason: "Water damage reported", urgency: "high", triage: true, keywords: ["water damage", "flood", "soaked", "stain", "wet ceiling", "wet wall"] },
  { key: "storm", label: "Storm damage", service: "storm-damage", points: 25, reason: "Storm damage reported", urgency: "high", triage: true, keywords: ["storm", "hail", "wind", "hurricane", "tornado"] },
  { key: "claim", label: "Insurance claim help", service: "insurance-claim-assistance", points: 25, reason: "Insurance claim assistance requested", urgency: "normal", triage: false, keywords: ["insurance", "claim", "adjuster", "deductible"] },
  { key: "metal", label: "Metal roofing", service: "metal-roofing", points: 15, reason: "Metal roofing interest", urgency: "normal", triage: false, keywords: ["metal", "standing seam"] },
  { key: "commercial", label: "Commercial roofing", service: "commercial-roofing", points: 20, reason: "Commercial roofing inquiry", urgency: "normal", triage: false, keywords: ["commercial", "business", "warehouse", "flat roof", "tpo", "epdm"] },
  { key: "replacement", label: "Roof replacement", service: "roof-replacement", points: 20, reason: "Full replacement interest", urgency: "normal", triage: false, keywords: ["replac", "new roof", "re-roof", "reroof"] },
  { key: "repair", label: "Roof repair", service: "roof-repair", points: 15, reason: "Repair requested", urgency: "normal", triage: false, keywords: ["repair", "fix", "shingle", "patch"] },
  { key: "inspection", label: "Inspection / maintenance", service: "roof-inspection", points: 10, reason: "Inspection or maintenance request", urgency: "normal", triage: false, keywords: ["inspect", "maintenance", "checkup", "check-up", "check up", "tune-up", "tuneup", "tune up"] },
];

export const DEFAULT_CONCIERGE_SETTINGS: Required<ConciergeSettings> = {
  assistantName: "AI Roof Concierge",
  greeting:
    "Hi, I'm the Painless AI Roof Concierge. I'll get you the right help in about a minute — and if anything looks dangerous I'll tell you what to do right away.",
  intents: DEFAULT_CONCIERGE_INTENTS,
  intakeDisclaimer:
    "Just so you know — I can't diagnose damage, quote pricing, or predict insurance outcomes from chat. A professional on-site inspection is required for that, and that's exactly what I'll help you set up.",
  emergencySafety: [
    "⚠️ Safety first, before anything else:",
    "• Stay out of rooms with sagging or bulging ceilings — they can give way.",
    "• Do not touch standing water near outlets, fixtures, or appliances. If it's safe to reach your panel, shut off power to affected areas.",
    "• Place containers under active drips and move valuables clear.",
    "• If you suspect structural collapse or electrical danger, leave the area and call 911.",
  ].join("\n"),
  emergencyEscalation:
    "I'm flagging this as an emergency — our team treats active leaks and hazards as same-day priorities. If you'd rather talk to a person right now, call our emergency line from the top of the page. Otherwise, give me about 60 seconds of questions and I'll get a priority callback dispatched.",
  unknownAnswerFallback:
    "Good question — I don't have that in my notes, so I won't guess. I'll flag it for our team so a real person follows up with the answer.",
  wrapUpNote:
    "Remember: only a professional on-site inspection can confirm your roof's condition — nothing in this chat is a damage, pricing, or insurance determination.",
};

/** Admin-tunable lead-scoring weights (0–100 total is clamped at read time). */
export interface LeadScoringSettings {
  /** Points per submitted intent slug (e.g. "active-leak": 40). */
  intentPoints: Record<string, number>;
  emergencyUrgencyBonus: number;
  highUrgencyBonus: number;
  emailProvidedBonus: number;
  smsConsentBonus: number;
  detailedDescriptionBonus: number;
  completeAddressBonus: number;
  contactMethodBonus: number;
  /** Bonus when the visitor returned on 2+ separate days before converting. */
  returnVisitBonus: number;
  /** Bonus when the visitor viewed a high-intent page (financing, services…). */
  engagedPagesBonus: number;
  /** Bonus when the visitor started an on-site tool (assessment, forms…). */
  toolUsageBonus: number;
}

export const DEFAULT_LEAD_SCORING: LeadScoringSettings = {
  intentPoints: {
    "active-leak": 40,
    emergency: 40,
    "water-damage": 30,
    storm: 25,
    replacement: 20,
    repair: 15,
    general: 10,
  },
  emergencyUrgencyBonus: 20,
  highUrgencyBonus: 10,
  emailProvidedBonus: 5,
  smsConsentBonus: 10,
  detailedDescriptionBonus: 5,
  completeAddressBonus: 10,
  contactMethodBonus: 5,
  returnVisitBonus: 10,
  engagedPagesBonus: 8,
  toolUsageBonus: 8,
};

/** One daily inspection window in local wall-clock hours (24h, end exclusive). */
export interface InspectionWindow {
  /** Local start hour, 0–23. */
  startHour: number;
  /** Local end hour, 1–24 (must be > startHour). */
  endHour: number;
}

/** Admin-tunable inspection booking availability for the concierge scheduler. */
export interface InspectionAvailabilitySettings {
  /** IANA timezone the windows are expressed in (e.g. "America/New_York"). */
  timezone: string;
  /** Bookable weekdays, as short English names ("Mon".."Sun"). */
  days: string[];
  /** Daily bookable windows in local hours. */
  windows: InspectionWindow[];
  /** Max scheduled/confirmed appointments allowed per window before it stops being offered. */
  maxBookingsPerWindow: number;
  /** Blackout dates (YYYY-MM-DD in the scheduling timezone) that are never offered. */
  blackoutDates: string[];
}

/** Matches the historical hardcoded behavior: weekdays 9–11 / 1–3 / 4–6 ET, one booking per window. */
export const DEFAULT_INSPECTION_AVAILABILITY: InspectionAvailabilitySettings = {
  timezone: "America/New_York",
  days: ["Mon", "Tue", "Wed", "Thu", "Fri"],
  windows: [
    { startHour: 9, endHour: 11 },
    { startHour: 13, endHour: 15 },
    { startHour: 16, endHour: 18 },
  ],
  maxBookingsPerWindow: 1,
  blackoutDates: [],
};

/**
 * Admin-tunable pre-inspection homeowner reminder: message copy per channel
 * plus how many hours before the window it goes out. Bodies/subject support
 * {{contact.firstName}}, {{business.name}}, {{business.phone}},
 * {{appointment.window}} and {{reschedule.line}} placeholders.
 */
export interface AppointmentReminderSettings {
  /** Hours before the scheduled start to send the reminder (e.g. 24, 48, 3). */
  leadTimeHours: number;
  /** SMS body template. */
  smsBody: string;
  /** Email subject template. */
  emailSubject: string;
  /** Email body template. */
  emailBody: string;
}

/** Matches the historical built-in copy and ~24h timing. */
export const DEFAULT_APPOINTMENT_REMINDER: AppointmentReminderSettings = {
  leadTimeHours: 24,
  smsBody:
    "{{business.name}} reminder: your roof inspection is tomorrow, {{appointment.window}}. {{reschedule.line}}",
  emailSubject:
    "Reminder: your roof inspection is tomorrow — {{appointment.window}}",
  emailBody: [
    "Hi {{contact.firstName}},",
    "",
    "A quick reminder that your roof inspection with {{business.name}} is coming up:",
    "🗓 When: {{appointment.window}}",
    "",
    "{{reschedule.line}}",
    "",
    "— {{business.name}}",
  ].join("\n"),
};

/**
 * Org-configurable sending safeguards for AUTOMATED outreach (playbooks and
 * automation email/SMS actions). Transactional sends (login codes, booking
 * confirmations, portal replies) are not window-restricted.
 */
export interface SendingHoursSettings {
  /** Master switch. Off = historical behavior (send any time, no caps deferral). */
  quietHoursEnabled: boolean;
  /** IANA timezone the window is evaluated in (e.g. "America/New_York"). */
  timezone: string;
  /** Inclusive start hour 0-23 of the allowed sending window. */
  startHour: number;
  /** Exclusive end hour 1-24 of the allowed sending window. */
  endHour: number;
  /** Days sends are allowed ("Mon".."Sun"). */
  days: string[];
  /** Max automated touches per contact per rolling 24h (0 = unlimited). */
  maxTouchesPerDay: number;
}

/**
 * Defaults are safe-by-default: automated outreach only goes out 8am–8pm in
 * the org's local timezone, so no homeowner is ever texted or emailed in the
 * middle of the night unless an org explicitly opts out. The frequency cap
 * applies whenever > 0, independent of quiet hours.
 */
export const DEFAULT_SENDING_HOURS: SendingHoursSettings = {
  quietHoursEnabled: true,
  timezone: "America/New_York",
  startHour: 8,
  endHour: 20,
  days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  maxTouchesPerDay: 0,
};

/** Google Business Profile connection for the reviews widget. */
export interface GoogleReviewsConfig {
  placeId?: string;
  apiKey?: string;
}

/** One row per organization: configurable business settings (never hard-coded). */
export const orgSettingsTable = pgTable(
  "org_settings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    businessProfile: jsonb("business_profile")
      .$type<BusinessProfile>()
      .notNull()
      .default({}),
    services: jsonb("services").$type<ServiceEntry[]>().notNull().default([]),
    serviceAreas: jsonb("service_areas")
      .$type<ServiceAreaEntry[]>()
      .notNull()
      .default([]),
    leadScoring: jsonb("lead_scoring").$type<LeadScoringSettings | null>(),
    inspectionAvailability: jsonb("inspection_availability").$type<InspectionAvailabilitySettings | null>(),
    appointmentReminder: jsonb("appointment_reminder").$type<Partial<AppointmentReminderSettings> | null>(),
    aiInstructions: text("ai_instructions"),
    /**
     * When set, unassigned-lead portal message fallback emails go to this
     * single inbox instead of every active org admin/owner.
     */
    fallbackNotificationInbox: text("fallback_notification_inbox"),
    /** Google Place ID and API key for the public reviews widget. */
    googleReviews: jsonb("google_reviews").$type<GoogleReviewsConfig | null>(),
    /** Embeddable website widget (closer.js) modules & appearance. */
    widget: jsonb("widget").$type<WidgetSettings | null>(),
    /** AI concierge behavior (intents, copy, guardrail text). */
    concierge: jsonb("concierge").$type<Partial<ConciergeSettings> | null>(),
    /** Quiet hours + frequency caps for automated outreach. */
    sendingHours: jsonb("sending_hours").$type<Partial<SendingHoursSettings> | null>(),
    // Brute-force security alerts recorded at or before this instant have been
    // acknowledged by an admin and should no longer render as an active banner.
    securityAlertsAcknowledgedAt: timestamp("security_alerts_acknowledged_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("org_settings_org_idx").on(table.organizationId)],
);

export const insertOrgSettingsSchema = createInsertSchema(orgSettingsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertOrgSettings = z.infer<typeof insertOrgSettingsSchema>;
export type OrgSettings = typeof orgSettingsTable.$inferSelect;
