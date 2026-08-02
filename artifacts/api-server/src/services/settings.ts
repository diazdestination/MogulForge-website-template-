import {
  DEFAULT_APPOINTMENT_REMINDER,
  DEFAULT_INSPECTION_AVAILABILITY,
  DEFAULT_LEAD_SCORING,
  db,
  orgSettingsTable,
  type AppointmentReminderSettings,
  type InspectionAvailabilitySettings,
  type LeadScoringSettings,
  type OrgSettings,
  type ServiceAreaEntry,
  type ServiceEntry,
} from "@workspace/db";
import { eq } from "drizzle-orm";

/**
 * Legacy service slugs migrated to their canonical form. The website's rich
 * page copy is keyed by slug, so a legacy slug renders a generic fallback
 * card instead of the hand-written page (e.g. water restoration).
 */
export const LEGACY_SERVICE_SLUGS: Record<string, string> = {
  "water-restoration": "water-damage-restoration",
  "emergency-tarping": "emergency-roofing",
};

/**
 * All service areas seeded into a new org's settings row and lazily appended
 * to existing orgs that predate a newly added area. Every slug here must have
 * matching rich page copy in the website's AREAS content list.
 */
export const DEFAULT_SERVICE_AREAS: ServiceAreaEntry[] = [
  { slug: "canton-ga",       name: "Canton",       state: "GA", isActive: true },
  { slug: "alpharetta-ga",   name: "Alpharetta",   state: "GA", isActive: true },
  { slug: "cumming-ga",      name: "Cumming",      state: "GA", isActive: true },
  { slug: "gainesville-ga",  name: "Gainesville",  state: "GA", isActive: true },
  { slug: "dawsonville-ga",  name: "Dawsonville",  state: "GA", isActive: true },
  { slug: "atlanta-ga",      name: "Atlanta",      state: "GA", isActive: true },
  { slug: "woodstock-ga",    name: "Woodstock",    state: "GA", isActive: true },
  { slug: "marietta-ga",     name: "Marietta",     state: "GA", isActive: true },
  { slug: "roswell-ga",      name: "Roswell",      state: "GA", isActive: true },
  { slug: "acworth-ga",      name: "Acworth",      state: "GA", isActive: true },
  { slug: "kennesaw-ga",     name: "Kennesaw",     state: "GA", isActive: true },
  { slug: "cartersville-ga", name: "Cartersville", state: "GA", isActive: true },
  { slug: "ball-ground-ga",  name: "Ball Ground",  state: "GA", isActive: true },
  { slug: "jasper-ga",       name: "Jasper",       state: "GA", isActive: true },
  { slug: "blue-ridge-ga",   name: "Blue Ridge",   state: "GA", isActive: true },
  { slug: "rome-ga",         name: "Rome",         state: "GA", isActive: true },
];

/**
 * Default services seeded into a new org's settings row. Every slug here must
 * have matching rich page copy in the website's SERVICES content list — see
 * settings-service-slugs.test.ts, which guards that contract.
 */
export const DEFAULT_SERVICES: ServiceEntry[] = [
  { slug: "roof-replacement", name: "Roof Replacement", isActive: true },
  { slug: "roof-repair", name: "Roof Repair", isActive: true },
  { slug: "storm-damage", name: "Storm Damage Restoration", isActive: true },
  { slug: "water-damage-restoration", name: "Water Damage Restoration", isActive: true },
  { slug: "emergency-roofing", name: "Emergency Tarping", isActive: true },
];

/**
 * Append any DEFAULT_SERVICE_AREAS entries missing from the stored list so
 * existing orgs automatically pick up newly added service areas. Returns null
 * when nothing changed (no DB write needed).
 */
function normalizeAreas(areas: ServiceAreaEntry[]): ServiceAreaEntry[] | null {
  const existing = new Set(areas.map((a) => a.slug));
  const missing = DEFAULT_SERVICE_AREAS.filter((a) => !existing.has(a.slug));
  if (missing.length === 0) return null;
  return [...areas, ...missing];
}

/** Canonicalize legacy slugs; returns null when nothing changed. */
function normalizeServices(services: ServiceEntry[]): ServiceEntry[] | null {
  let changed = false;
  const seen = new Set<string>();
  const normalized: ServiceEntry[] = [];
  for (const entry of services) {
    const canonical = LEGACY_SERVICE_SLUGS[entry.slug];
    const slug = canonical ?? entry.slug;
    if (canonical) changed = true;
    if (seen.has(slug)) {
      // Drop duplicates created if an org already added the canonical slug.
      changed = true;
      continue;
    }
    seen.add(slug);
    normalized.push(canonical ? { ...entry, slug } : entry);
  }
  return changed ? normalized : null;
}

/** Get (or lazily create) the settings row for an org. */
export async function getOrgSettings(organizationId: string): Promise<OrgSettings> {
  const [existing] = await db
    .select()
    .from(orgSettingsTable)
    .where(eq(orgSettingsTable.organizationId, organizationId));
  if (existing) {
    // Migrate legacy service slugs in place so live sites pick up rich copy.
    const normalized = normalizeServices(existing.services ?? []);
    if (!normalized) return existing;
    const [updated] = await db
      .update(orgSettingsTable)
      .set({ services: normalized })
      .where(eq(orgSettingsTable.id, existing.id))
      .returning();
    return updated ?? { ...existing, services: normalized };
  }
  const [created] = await db
    .insert(orgSettingsTable)
    .values({
      organizationId,
      businessProfile: {
        businessName: "Painless Roofing & Water Restoration",
        phone: "(404) 444-4476",
        city: "Canton",
        state: "GA",
        postalCode: "30115",
        hours: "24/7",
        emergencyAvailability: true,
      },
      services: DEFAULT_SERVICES,
      serviceAreas: DEFAULT_SERVICE_AREAS,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [row] = await db
    .select()
    .from(orgSettingsTable)
    .where(eq(orgSettingsTable.organizationId, organizationId));
  return row;
}

/**
 * Idempotent startup migration: append any DEFAULT_SERVICE_AREAS entries
 * missing from the org's stored list. Called once per org at server boot;
 * never called inside request handlers so tests are unaffected.
 */
export async function ensureDefaultServiceAreas(
  organizationId: string,
): Promise<void> {
  const settings = await getOrgSettings(organizationId);
  const updated = normalizeAreas(settings.serviceAreas ?? []);
  if (!updated) return;
  await db
    .update(orgSettingsTable)
    .set({ serviceAreas: updated })
    .where(eq(orgSettingsTable.organizationId, organizationId));
}

export async function updateOrgSettings(
  organizationId: string,
  patch: Partial<
    Pick<
      OrgSettings,
      | "businessProfile"
      | "services"
      | "serviceAreas"
      | "leadScoring"
      | "aiInstructions"
      | "fallbackNotificationInbox"
      | "inspectionAvailability"
      | "appointmentReminder"
      | "securityAlertsAcknowledgedAt"
      | "googleReviews"
    >
  >,
): Promise<OrgSettings> {
  await getOrgSettings(organizationId); // ensure row exists
  if (patch.services) {
    // Keep writes canonical too (e.g. a stale client re-submitting legacy slugs).
    patch = { ...patch, services: normalizeServices(patch.services) ?? patch.services };
  }
  const [row] = await db
    .update(orgSettingsTable)
    .set(patch)
    .where(eq(orgSettingsTable.organizationId, organizationId))
    .returning();
  return row;
}

/** Effective scoring weights: org override merged over defaults. */
export async function getLeadScoring(
  organizationId: string,
): Promise<LeadScoringSettings> {
  const settings = await getOrgSettings(organizationId);
  if (!settings.leadScoring) return DEFAULT_LEAD_SCORING;
  return {
    ...DEFAULT_LEAD_SCORING,
    ...settings.leadScoring,
    intentPoints: {
      ...DEFAULT_LEAD_SCORING.intentPoints,
      ...settings.leadScoring.intentPoints,
    },
  };
}

/** Whether the string is a valid IANA timezone this runtime can format in. */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Effective inspection availability: org override merged over defaults, with
 * invalid values sanitized so the scheduler always has a workable config.
 */
export async function getInspectionAvailability(
  organizationId: string,
): Promise<InspectionAvailabilitySettings> {
  const settings = await getOrgSettings(organizationId);
  const raw = settings.inspectionAvailability;
  if (!raw) return DEFAULT_INSPECTION_AVAILABILITY;
  const merged = { ...DEFAULT_INSPECTION_AVAILABILITY, ...raw };
  const validDays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const days = merged.days.filter((d) => validDays.includes(d));
  const windows = merged.windows
    .filter(
      (w) =>
        Number.isFinite(w.startHour) &&
        Number.isFinite(w.endHour) &&
        w.startHour >= 0 &&
        w.endHour <= 24 &&
        w.endHour > w.startHour,
    )
    .sort((a, b) => a.startHour - b.startHour);
  return {
    timezone: isValidTimezone(merged.timezone)
      ? merged.timezone
      : DEFAULT_INSPECTION_AVAILABILITY.timezone,
    days: days.length ? days : DEFAULT_INSPECTION_AVAILABILITY.days,
    windows: windows.length ? windows : DEFAULT_INSPECTION_AVAILABILITY.windows,
    maxBookingsPerWindow: Math.max(1, Math.floor(merged.maxBookingsPerWindow) || 1),
    blackoutDates: (merged.blackoutDates ?? []).filter((d) =>
      /^\d{4}-\d{2}-\d{2}$/.test(d),
    ),
  };
}

/** Max reminder lead time: two weeks before the appointment. */
const MAX_REMINDER_LEAD_HOURS = 336;

/**
 * Effective pre-inspection reminder settings: org override merged over the
 * built-in defaults, sanitized so the scheduler always has usable copy and a
 * sane lead time (1–336 hours; default 24).
 */
export async function getAppointmentReminderSettings(
  organizationId: string,
): Promise<AppointmentReminderSettings> {
  const settings = await getOrgSettings(organizationId);
  const raw = settings.appointmentReminder;
  if (!raw) return DEFAULT_APPOINTMENT_REMINDER;
  const merged = { ...DEFAULT_APPOINTMENT_REMINDER, ...raw };
  const leadTimeHours = Number.isFinite(merged.leadTimeHours)
    ? Math.min(MAX_REMINDER_LEAD_HOURS, Math.max(1, merged.leadTimeHours))
    : DEFAULT_APPOINTMENT_REMINDER.leadTimeHours;
  const nonEmpty = (value: string, fallback: string) =>
    typeof value === "string" && value.trim().length > 0 ? value : fallback;
  return {
    leadTimeHours,
    smsBody: nonEmpty(merged.smsBody, DEFAULT_APPOINTMENT_REMINDER.smsBody),
    emailSubject: nonEmpty(
      merged.emailSubject,
      DEFAULT_APPOINTMENT_REMINDER.emailSubject,
    ),
    emailBody: nonEmpty(merged.emailBody, DEFAULT_APPOINTMENT_REMINDER.emailBody),
  };
}

/** Org-specific extra AI instructions (empty string when unset). */
export async function getAiInstructions(organizationId: string): Promise<string> {
  const settings = await getOrgSettings(organizationId);
  return settings.aiInstructions?.trim() ?? "";
}
