/**
 * Regression tests for org-configurable inspection availability:
 * generateInspectionSlots must never offer times outside admin-set hours,
 * and getInspectionAvailability must sanitize bad config back to defaults.
 */
import {
  appointmentsTable,
  db,
  organizationsTable,
  orgSettingsTable,
  DEFAULT_INSPECTION_AVAILABILITY,
  type InspectionAvailabilitySettings,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

import { bookInspectionSlot, generateInspectionSlots } from "./concierge";
import { getInspectionAvailability } from "./settings";

/** Every org this suite creates, cleaned up in afterAll. */
const createdOrgIds: string[] = [];

afterAll(async () => {
  await deleteTestOrgs(...createdOrgIds);
});

/** Create an org, optionally with inspectionAvailability settings. */
async function makeOrg(
  availability?: Partial<InspectionAvailabilitySettings> | null,
): Promise<string> {
  const [org] = await db
    .insert(organizationsTable)
    .values({ name: "Slots Test Org", slug: `test-slots-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` })
    .returning();
  createdOrgIds.push(org.id);
  if (availability !== undefined) {
    await db.insert(orgSettingsTable).values({
      organizationId: org.id,
      inspectionAvailability: availability as InspectionAvailabilitySettings | null,
    });
  }
  return org.id;
}

/** Local calendar parts of a Date in the given timezone. */
function localParts(d: Date, tz: string): { date: string; hour: number; minute: number; weekday: string } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    weekday: "short",
  });
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour === "24" ? "0" : p.hour),
    minute: Number(p.minute),
    weekday: p.weekday,
  };
}

/** Assert every offered slot falls inside the given availability policy. */
function expectSlotsWithinPolicy(
  slots: { start: string; end: string }[],
  avail: InspectionAvailabilitySettings,
) {
  for (const slot of slots) {
    const start = localParts(new Date(slot.start), avail.timezone);
    const end = localParts(new Date(slot.end), avail.timezone);
    expect(avail.days).toContain(start.weekday);
    expect(avail.blackoutDates).not.toContain(start.date);
    const matches = avail.windows.some(
      (w) => w.startHour === start.hour && (w.endHour % 24) === end.hour,
    );
    expect(matches).toBe(true);
  }
}

describe("generateInspectionSlots", () => {
  it("uses the default availability when nothing is configured", async () => {
    const orgId = await makeOrg(); // no settings row at all
    const slots = await generateInspectionSlots(orgId);
    expect(slots.length).toBe(3);
    expectSlotsWithinPolicy(slots, DEFAULT_INSPECTION_AVAILABILITY);
    // Defaults are weekdays only.
    for (const slot of slots) {
      const { weekday } = localParts(new Date(slot.start), "America/New_York");
      expect(["Sat", "Sun"]).not.toContain(weekday);
    }
  });

  it("uses the default availability when the settings row has no override", async () => {
    const orgId = await makeOrg(null);
    const slots = await generateInspectionSlots(orgId);
    expect(slots.length).toBe(3);
    expectSlotsWithinPolicy(slots, DEFAULT_INSPECTION_AVAILABILITY);
  });

  it("respects custom days, windows, and timezone", async () => {
    const custom: InspectionAvailabilitySettings = {
      timezone: "America/Los_Angeles",
      days: ["Sat", "Sun"],
      windows: [{ startHour: 7, endHour: 9 }],
      maxBookingsPerWindow: 1,
      blackoutDates: [],
    };
    const orgId = await makeOrg(custom);
    const slots = await generateInspectionSlots(orgId);
    expect(slots.length).toBeGreaterThan(0);
    expectSlotsWithinPolicy(slots, custom);
    for (const slot of slots) {
      const start = localParts(new Date(slot.start), "America/Los_Angeles");
      expect(["Sat", "Sun"]).toContain(start.weekday);
      expect(start.hour).toBe(7);
    }
  });

  it("never offers slots on blackout dates", async () => {
    // Every day available, then black out the next 4 local dates — no slot may
    // land on any of them.
    const tz = "America/Chicago";
    const blackoutDates: string[] = [];
    for (let i = 1; i <= 4; i++) {
      blackoutDates.push(localParts(new Date(Date.now() + i * 86_400_000), tz).date);
    }
    const custom: InspectionAvailabilitySettings = {
      timezone: tz,
      days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      windows: [{ startHour: 9, endHour: 11 }],
      maxBookingsPerWindow: 1,
      blackoutDates,
    };
    const orgId = await makeOrg(custom);
    const slots = await generateInspectionSlots(orgId);
    expect(slots.length).toBeGreaterThan(0);
    expectSlotsWithinPolicy(slots, custom);
    for (const slot of slots) {
      expect(blackoutDates).not.toContain(localParts(new Date(slot.start), tz).date);
    }
  });

  it("stops offering a window once it reaches maxBookingsPerWindow", async () => {
    const custom: InspectionAvailabilitySettings = {
      timezone: "UTC",
      days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      windows: [{ startHour: 9, endHour: 11 }],
      maxBookingsPerWindow: 2,
      blackoutDates: [],
    };
    const orgId = await makeOrg(custom);
    const before = await generateInspectionSlots(orgId);
    expect(before.length).toBeGreaterThan(0);
    const target = before[0];

    // Fill the first offered window to capacity.
    await db.insert(appointmentsTable).values(
      [0, 1].map(() => ({
        organizationId: orgId,
        type: "inspection" as const,
        status: "scheduled" as const,
        scheduledStart: new Date(target.start),
        scheduledEnd: new Date(target.end),
      })),
    );

    const after = await generateInspectionSlots(orgId);
    expect(after.map((s) => s.start)).not.toContain(target.start);
    expectSlotsWithinPolicy(after, custom);
  });

  it("still offers a window with bookings below capacity", async () => {
    const custom: InspectionAvailabilitySettings = {
      timezone: "UTC",
      days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      windows: [{ startHour: 9, endHour: 11 }],
      maxBookingsPerWindow: 2,
      blackoutDates: [],
    };
    const orgId = await makeOrg(custom);
    const before = await generateInspectionSlots(orgId);
    const target = before[0];
    await db.insert(appointmentsTable).values({
      organizationId: orgId,
      type: "inspection",
      status: "scheduled",
      scheduledStart: new Date(target.start),
      scheduledEnd: new Date(target.end),
    });
    const after = await generateInspectionSlots(orgId);
    expect(after.map((s) => s.start)).toContain(target.start);
  });
});

describe("generateInspectionSlots across DST transitions", () => {
  const ALL_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const NY = "America/New_York";

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Org with a 9–11 AM window every day in a DST-observing timezone. */
  async function makeDstOrg(): Promise<string> {
    return makeOrg({
      timezone: NY,
      days: ALL_DAYS,
      windows: [{ startHour: 9, endHour: 11 }],
      maxBookingsPerWindow: 10,
      blackoutDates: [],
    });
  }

  /** Generate slots with "now" pinned to the given instant (Date only). */
  async function slotsAt(orgId: string, nowIso: string) {
    vi.useFakeTimers({ now: new Date(nowIso), toFake: ["Date"] });
    try {
      return await generateInspectionSlots(orgId);
    } finally {
      vi.useRealTimers();
    }
  }

  function expectWallClock(slots: { start: string; end: string }[], dates: string[]) {
    expect(slots.length).toBe(dates.length);
    slots.forEach((slot, i) => {
      const start = localParts(new Date(slot.start), NY);
      const end = localParts(new Date(slot.end), NY);
      expect(start.date).toBe(dates[i]);
      expect(start.hour).toBe(9);
      expect(end.hour).toBe(11);
    });
  }

  it("keeps 9 AM at 9 AM local before, during, and after spring-forward (2026-03-08)", async () => {
    const orgId = await makeDstOrg();
    // Offsets 1..3 from Mar 6 → Mar 7 (EST), Mar 8 (transition day), Mar 9 (EDT).
    const slots = await slotsAt(orgId, "2026-03-06T12:00:00Z");
    expectWallClock(slots, ["2026-03-07", "2026-03-08", "2026-03-09"]);
    // The UTC instant must shift with the offset change: EST 9 AM = 14:00Z,
    // EDT 9 AM = 13:00Z. On the transition day the clocks have already sprung
    // forward by 9 AM, so it must be 13:00Z — not 14:00Z (10 AM local).
    expect(new Date(slots[0].start).getUTCHours()).toBe(14);
    expect(new Date(slots[1].start).getUTCHours()).toBe(13);
    expect(new Date(slots[2].start).getUTCHours()).toBe(13);
  });

  it("keeps 9 AM at 9 AM local before, during, and after fall-back (2026-11-01)", async () => {
    const orgId = await makeDstOrg();
    // Offsets 1..3 from Oct 30 → Oct 31 (EDT), Nov 1 (transition day), Nov 2 (EST).
    const slots = await slotsAt(orgId, "2026-10-30T12:00:00Z");
    expectWallClock(slots, ["2026-10-31", "2026-11-01", "2026-11-02"]);
    // EDT 9 AM = 13:00Z; after fall-back EST 9 AM = 14:00Z. On the transition
    // day the extra hour has already elapsed by 9 AM, so it must be 14:00Z.
    expect(new Date(slots[0].start).getUTCHours()).toBe(13);
    expect(new Date(slots[1].start).getUTCHours()).toBe(14);
    expect(new Date(slots[2].start).getUTCHours()).toBe(14);
  });

  it("keeps window duration at the configured wall-clock length on transition days", async () => {
    const orgId = await makeDstOrg();
    for (const nowIso of ["2026-03-06T12:00:00Z", "2026-10-30T12:00:00Z"]) {
      const slots = await slotsAt(orgId, nowIso);
      for (const slot of slots) {
        // 9–11 AM never spans the 2 AM switch, so real elapsed time is 2h.
        expect(new Date(slot.end).getTime() - new Date(slot.start).getTime()).toBe(2 * 3_600_000);
      }
    }
  });
});

describe("half-hour-offset timezones", () => {
  const HALF_HOUR_ZONES = [
    { tz: "Asia/Kolkata", offsetMinutes: 330 }, // UTC+5:30, no DST
    { tz: "Australia/Adelaide" }, // UTC+9:30 / +10:30 (DST)
  ] as const;

  async function makeHalfHourOrg(tz: string): Promise<string> {
    return makeOrg({
      timezone: tz,
      days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      windows: [{ startHour: 9, endHour: 11 }],
      maxBookingsPerWindow: 10,
      blackoutDates: [],
    });
  }

  for (const { tz } of HALF_HOUR_ZONES) {
    it(`offers slots landing exactly on the configured local hours in ${tz}`, async () => {
      const orgId = await makeHalfHourOrg(tz);
      const slots = await generateInspectionSlots(orgId);
      expect(slots.length).toBe(3);
      for (const slot of slots) {
        const start = localParts(new Date(slot.start), tz);
        const end = localParts(new Date(slot.end), tz);
        // Exactly 9:00–11:00 wall-clock — minute 0, not :30.
        expect({ hour: start.hour, minute: start.minute }).toEqual({ hour: 9, minute: 0 });
        expect({ hour: end.hour, minute: end.minute }).toEqual({ hour: 11, minute: 0 });
        // In a fractional-offset zone a minute-0 local time is NOT on a whole
        // UTC hour; if it were, the wall-clock correction didn't apply.
        expect(new Date(slot.start).getUTCMinutes()).toBe(30);
        expect(new Date(slot.end).getUTCMinutes()).toBe(30);
      }
    });

    it(`books an offered slot in ${tz}`, async () => {
      const orgId = await makeHalfHourOrg(tz);
      const slots = await generateInspectionSlots(orgId);
      const booked = await bookInspectionSlot({
        organizationId: orgId,
        slot: { start: slots[0].start, end: slots[0].end },
      });
      expect(booked).not.toBeNull();
    });
  }

  it("rejects a slot 30 minutes off the configured window (hour-only match would pass)", async () => {
    const orgId = await makeHalfHourOrg("Asia/Kolkata");
    const slots = await generateInspectionSlots(orgId);
    // Shift the offered slot by +30 min: local wall-clock becomes 9:30–11:30,
    // which still has local hours 9 and 11 — an hour-only check would accept it.
    const shift = 30 * 60_000;
    const start = new Date(new Date(slots[0].start).getTime() + shift);
    const end = new Date(new Date(slots[0].end).getTime() + shift);
    expect(localParts(start, "Asia/Kolkata")).toMatchObject({ hour: 9, minute: 30 });
    const booked = await bookInspectionSlot({
      organizationId: orgId,
      slot: { start: start.toISOString(), end: end.toISOString() },
    });
    expect(booked).toBeNull();
  });
});

describe("getInspectionAvailability sanitization", () => {
  it("returns the defaults when no override exists", async () => {
    const orgId = await makeOrg(null);
    const avail = await getInspectionAvailability(orgId);
    expect(avail).toEqual(DEFAULT_INSPECTION_AVAILABILITY);
  });

  it("falls back to the default timezone when the configured one is invalid", async () => {
    const orgId = await makeOrg({
      ...DEFAULT_INSPECTION_AVAILABILITY,
      timezone: "Not/A_Zone",
    });
    const avail = await getInspectionAvailability(orgId);
    expect(avail.timezone).toBe(DEFAULT_INSPECTION_AVAILABILITY.timezone);
  });

  it("drops inverted or out-of-range windows and falls back to defaults when none survive", async () => {
    const orgId = await makeOrg({
      ...DEFAULT_INSPECTION_AVAILABILITY,
      windows: [
        { startHour: 15, endHour: 9 }, // inverted
        { startHour: -2, endHour: 4 }, // negative start
        { startHour: 20, endHour: 30 }, // end past 24
      ],
    });
    const avail = await getInspectionAvailability(orgId);
    expect(avail.windows).toEqual(DEFAULT_INSPECTION_AVAILABILITY.windows);
  });

  it("keeps valid windows, sorted, while dropping invalid ones", async () => {
    const orgId = await makeOrg({
      ...DEFAULT_INSPECTION_AVAILABILITY,
      windows: [
        { startHour: 14, endHour: 16 },
        { startHour: 16, endHour: 10 }, // inverted — dropped
        { startHour: 8, endHour: 10 },
      ],
    });
    const avail = await getInspectionAvailability(orgId);
    expect(avail.windows).toEqual([
      { startHour: 8, endHour: 10 },
      { startHour: 14, endHour: 16 },
    ]);
  });

  it("falls back to default days when configured days are empty or invalid", async () => {
    const orgId = await makeOrg({
      ...DEFAULT_INSPECTION_AVAILABILITY,
      days: ["Funday", "Blursday"],
    });
    const avail = await getInspectionAvailability(orgId);
    expect(avail.days).toEqual(DEFAULT_INSPECTION_AVAILABILITY.days);

    const orgId2 = await makeOrg({ ...DEFAULT_INSPECTION_AVAILABILITY, days: [] });
    const avail2 = await getInspectionAvailability(orgId2);
    expect(avail2.days).toEqual(DEFAULT_INSPECTION_AVAILABILITY.days);
  });

  it("filters invalid day names but keeps valid ones", async () => {
    const orgId = await makeOrg({
      ...DEFAULT_INSPECTION_AVAILABILITY,
      days: ["Mon", "Funday", "Sat"],
    });
    const avail = await getInspectionAvailability(orgId);
    expect(avail.days).toEqual(["Mon", "Sat"]);
  });

  it("clamps maxBookingsPerWindow to at least 1", async () => {
    for (const bad of [0, -3, NaN]) {
      const orgId = await makeOrg({
        ...DEFAULT_INSPECTION_AVAILABILITY,
        maxBookingsPerWindow: bad,
      });
      const avail = await getInspectionAvailability(orgId);
      expect(avail.maxBookingsPerWindow).toBe(1);
    }
  });

  it("drops malformed blackout dates", async () => {
    const orgId = await makeOrg({
      ...DEFAULT_INSPECTION_AVAILABILITY,
      blackoutDates: ["2026-12-25", "next tuesday", "12/25/2026", ""],
    });
    const avail = await getInspectionAvailability(orgId);
    expect(avail.blackoutDates).toEqual(["2026-12-25"]);
  });
});
