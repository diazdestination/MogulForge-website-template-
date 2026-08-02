import type { InspectionAvailabilitySettings } from '@workspace/api-client-react';

/**
 * Client-side helpers to warn (not block) when a manually booked inspection
 * falls outside the availability admins configured (same source as concierge
 * chat bookings: GET /v1/settings/inspection-availability).
 *
 * Shared by the command-center (web) and mobile-crm (Expo) apps so the
 * out-of-hours warning stays identical everywhere.
 */

export function formatHour(hour: number): string {
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** Human summary of the configured bookable windows, e.g. "Mon, Tue · 8:00 AM–11:00 AM or 1:00 PM–4:00 PM (America/Chicago)". */
export function describeAvailability(a: InspectionAvailabilitySettings): string {
  const windows = a.windows
    .map((w) => `${formatHour(w.startHour)}–${formatHour(w.endHour)}`)
    .join(' or ');
  return `${a.days.join(', ')} · ${windows} (${a.timezone})`;
}

interface ZonedParts {
  weekday: string; // "Mon"
  date: string; // "YYYY-MM-DD"
  hourDecimal: number; // e.g. 13.5 for 1:30 PM
}

/** Break an instant into weekday/date/hour in the org's configured timezone. */
function partsInZone(instant: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(instant)) map[p.type] = p.value;
  const hour = Number(map.hour) % 24; // "24" can appear for midnight
  return {
    weekday: map.weekday,
    date: `${map.year}-${map.month}-${map.day}`,
    hourDecimal: hour + Number(map.minute) / 60,
  };
}

/**
 * Returns a warning message when the given start time is outside the
 * configured inspection availability, or null when it fits.
 */
export function getInspectionAvailabilityWarning(
  start: Date,
  a: InspectionAvailabilitySettings,
): string | null {
  if (Number.isNaN(start.getTime())) return null;
  let parts: ZonedParts;
  try {
    parts = partsInZone(start, a.timezone);
  } catch {
    return null; // invalid timezone config — don't block the form with noise
  }
  if (a.blackoutDates.includes(parts.date)) {
    return `${parts.date} is a blackout date — the crew isn't available that day. Configured hours: ${describeAvailability(a)}.`;
  }
  if (!(a.days as string[]).includes(parts.weekday)) {
    return `This time falls on a ${parts.weekday}, which isn't a bookable inspection day. Configured hours: ${describeAvailability(a)}.`;
  }
  const inWindow = a.windows.some(
    (w) => parts.hourDecimal >= w.startHour && parts.hourDecimal < w.endHour,
  );
  if (!inWindow) {
    return `This time is outside the configured inspection hours. Configured hours: ${describeAvailability(a)}.`;
  }
  return null;
}
