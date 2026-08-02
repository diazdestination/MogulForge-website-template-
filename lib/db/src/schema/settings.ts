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
