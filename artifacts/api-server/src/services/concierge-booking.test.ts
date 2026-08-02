import { appointmentsTable, db, organizationsTable, orgSettingsTable, DEFAULT_INSPECTION_AVAILABILITY } from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

import { bookInspectionSlot } from "./concierge";

let org: { id: string };
let capOrg: { id: string };
let policyOrg: { id: string };

// 24/7 availability in UTC: every day, all twelve 2-hour windows — so booking
// policy checks pass for any slot snapped to an even UTC hour.
const OPEN_AVAILABILITY = {
  ...DEFAULT_INSPECTION_AVAILABILITY,
  timezone: "UTC",
  days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  windows: Array.from({ length: 12 }, (_, i) => ({ startHour: i * 2, endHour: i * 2 + 2 })),
  blackoutDates: [],
};

beforeAll(async () => {
  const [row] = await db
    .insert(organizationsTable)
    .values({ name: "Booking Test Org", slug: `test-booking-${Date.now()}` })
    .returning();
  org = row;
  await db.insert(orgSettingsTable).values({
    organizationId: org.id,
    inspectionAvailability: OPEN_AVAILABILITY,
  });
});

afterAll(async () => {
  await deleteTestOrgs(org.id, capOrg?.id, policyOrg?.id);
});

/** Slot snapped to the next even UTC hour at least `hoursFromNow` out. */
function slotAt(hoursFromNow: number) {
  const t = Date.now() + hoursFromNow * 3_600_000;
  const snapped = Math.ceil(t / (2 * 3_600_000)) * (2 * 3_600_000);
  const start = new Date(snapped);
  const end = new Date(start.getTime() + 2 * 3_600_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

describe("bookInspectionSlot", () => {
  it("books a free window", async () => {
    const appt = await bookInspectionSlot({ organizationId: org.id, slot: slotAt(24) });
    expect(appt).not.toBeNull();
  });

  it("refuses a window that is already taken", async () => {
    const slot = slotAt(48);
    const first = await bookInspectionSlot({ organizationId: org.id, slot });
    expect(first).not.toBeNull();
    const second = await bookInspectionSlot({ organizationId: org.id, slot });
    expect(second).toBeNull();
  });

  it("refuses an overlapping (not identical) window", async () => {
    const slot = slotAt(72);
    await bookInspectionSlot({ organizationId: org.id, slot });
    const overlapping = {
      start: new Date(new Date(slot.start).getTime() + 3_600_000).toISOString(),
      end: new Date(new Date(slot.end).getTime() + 3_600_000).toISOString(),
    };
    const result = await bookInspectionSlot({ organizationId: org.id, slot: overlapping });
    expect(result).toBeNull();
  });

  it("allows a back-to-back window (shared boundary is not an overlap)", async () => {
    const slot = slotAt(96);
    await bookInspectionSlot({ organizationId: org.id, slot });
    const next = {
      start: slot.end,
      end: new Date(new Date(slot.end).getTime() + 2 * 3_600_000).toISOString(),
    };
    const result = await bookInspectionSlot({ organizationId: org.id, slot: next });
    expect(result).not.toBeNull();
  });

  it("only lets one of two simultaneous bookings of the same window succeed", async () => {
    const slot = slotAt(120);
    const results = await Promise.all([
      bookInspectionSlot({ organizationId: org.id, slot }),
      bookInspectionSlot({ organizationId: org.id, slot }),
    ]);
    const booked = results.filter((r) => r !== null);
    expect(booked.length).toBe(1);

    const rows = await db
      .select()
      .from(appointmentsTable)
      .where(eq(appointmentsTable.organizationId, org.id));
    const inWindow = rows.filter(
      (r) => r.scheduledStart.toISOString() === slot.start,
    );
    expect(inWindow.length).toBe(1);
  });

  describe("with maxBookingsPerWindow = 2", () => {
    beforeAll(async () => {
      const [row] = await db
        .insert(organizationsTable)
        .values({ name: "Capacity Test Org", slug: `test-capacity-${Date.now()}` })
        .returning();
      capOrg = row;
      await db.insert(orgSettingsTable).values({
        organizationId: capOrg.id,
        inspectionAvailability: { ...OPEN_AVAILABILITY, maxBookingsPerWindow: 2 },
      });
    });

    it("allows bookings up to capacity, then refuses", async () => {
      const slot = slotAt(144);
      const first = await bookInspectionSlot({ organizationId: capOrg.id, slot });
      const second = await bookInspectionSlot({ organizationId: capOrg.id, slot });
      const third = await bookInspectionSlot({ organizationId: capOrg.id, slot });
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(third).toBeNull();
    });

    it("never exceeds capacity under simultaneous bookings", async () => {
      const slot = slotAt(168);
      const results = await Promise.all([
        bookInspectionSlot({ organizationId: capOrg.id, slot }),
        bookInspectionSlot({ organizationId: capOrg.id, slot }),
        bookInspectionSlot({ organizationId: capOrg.id, slot }),
        bookInspectionSlot({ organizationId: capOrg.id, slot }),
      ]);
      expect(results.filter((r) => r !== null).length).toBe(2);

      const rows = await db
        .select()
        .from(appointmentsTable)
        .where(eq(appointmentsTable.organizationId, capOrg.id));
      const inWindow = rows.filter((r) => r.scheduledStart.toISOString() === slot.start);
      expect(inWindow.length).toBe(2);
    });
  });

  describe("policy enforcement against current availability", () => {
    beforeAll(async () => {
      const [row] = await db
        .insert(organizationsTable)
        .values({ name: "Policy Test Org", slug: `test-policy-${Date.now()}` })
        .returning();
      policyOrg = row;
      // Only Mondays 9–11 UTC bookable.
      await db.insert(orgSettingsTable).values({
        organizationId: policyOrg.id,
        inspectionAvailability: {
          ...OPEN_AVAILABILITY,
          days: ["Mon"],
          windows: [{ startHour: 9, endHour: 11 }],
        },
      });
    });

    /** Next Monday at the given UTC hour. */
    function nextMondayAt(hourUtc: number, weeksOut = 1) {
      const d = new Date();
      const daysToMon = ((8 - d.getUTCDay()) % 7) + 7 * weeksOut;
      const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysToMon, hourUtc));
      return start;
    }

    it("books a slot matching the configured day and window", async () => {
      const start = nextMondayAt(9);
      const end = new Date(start.getTime() + 2 * 3_600_000);
      const appt = await bookInspectionSlot({
        organizationId: policyOrg.id,
        slot: { start: start.toISOString(), end: end.toISOString() },
      });
      expect(appt).not.toBeNull();
    });

    it("rejects a slot on a non-configured day", async () => {
      const start = new Date(nextMondayAt(9).getTime() + 86_400_000); // Tuesday
      const end = new Date(start.getTime() + 2 * 3_600_000);
      const appt = await bookInspectionSlot({
        organizationId: policyOrg.id,
        slot: { start: start.toISOString(), end: end.toISOString() },
      });
      expect(appt).toBeNull();
    });

    it("rejects a slot outside the configured hours", async () => {
      const start = nextMondayAt(13, 2);
      const end = new Date(start.getTime() + 2 * 3_600_000);
      const appt = await bookInspectionSlot({
        organizationId: policyOrg.id,
        slot: { start: start.toISOString(), end: end.toISOString() },
      });
      expect(appt).toBeNull();
    });

    it("rejects a slot on a blackout date even when day/window match", async () => {
      const start = nextMondayAt(9, 3);
      const localDate = start.toISOString().slice(0, 10);
      await db
        .update(orgSettingsTable)
        .set({
          inspectionAvailability: {
            ...OPEN_AVAILABILITY,
            days: ["Mon"],
            windows: [{ startHour: 9, endHour: 11 }],
            blackoutDates: [localDate],
          },
        })
        .where(eq(orgSettingsTable.organizationId, policyOrg.id));
      const end = new Date(start.getTime() + 2 * 3_600_000);
      const appt = await bookInspectionSlot({
        organizationId: policyOrg.id,
        slot: { start: start.toISOString(), end: end.toISOString() },
      });
      expect(appt).toBeNull();
    });

    it("rejects a previously offered slot after admins tighten availability", async () => {
      const start = nextMondayAt(9, 4);
      const end = new Date(start.getTime() + 2 * 3_600_000);
      // Settings change: Mondays no longer bookable.
      await db
        .update(orgSettingsTable)
        .set({
          inspectionAvailability: {
            ...OPEN_AVAILABILITY,
            days: ["Tue"],
            windows: [{ startHour: 9, endHour: 11 }],
          },
        })
        .where(eq(orgSettingsTable.organizationId, policyOrg.id));
      const appt = await bookInspectionSlot({
        organizationId: policyOrg.id,
        slot: { start: start.toISOString(), end: end.toISOString() },
      });
      expect(appt).toBeNull();
    });
  });
});
