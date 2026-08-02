import { appointmentsTable, db, organizationsTable, orgSettingsTable, DEFAULT_INSPECTION_AVAILABILITY } from "@workspace/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

import { bookInspectionSlot } from "./concierge";
import { createAppointment, updateAppointment } from "./crm";

let org: { id: string };

// 24/7 availability in UTC so concierge policy checks pass for any slot
// snapped to an even UTC hour.
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
    .values({ name: "CRM Booking Conflict Org", slug: `test-crm-booking-${Date.now()}` })
    .returning();
  org = row;
  await db.insert(orgSettingsTable).values({
    organizationId: org.id,
    inspectionAvailability: OPEN_AVAILABILITY,
  });
});

afterAll(async () => {
  await deleteTestOrgs(org.id);
});

/** Slot snapped to the next even UTC hour at least `hoursFromNow` out. */
function slotAt(hoursFromNow: number) {
  const t = Date.now() + hoursFromNow * 3_600_000;
  const snapped = Math.ceil(t / (2 * 3_600_000)) * (2 * 3_600_000);
  const start = new Date(snapped);
  const end = new Date(start.getTime() + 2 * 3_600_000);
  return { start, end };
}

describe("staff CRM inspection booking vs concierge chat booking", () => {
  it("books a free inspection window from the CRM", async () => {
    const { start, end } = slotAt(24);
    const appt = await createAppointment(org.id, {
      type: "inspection",
      scheduledStart: start,
      scheduledEnd: end,
    });
    expect(appt).not.toBe("conflict");
    expect(appt).not.toBeNull();
  });

  it("refuses a staff booking colliding with a chat booking", async () => {
    const { start, end } = slotAt(48);
    const chat = await bookInspectionSlot({
      organizationId: org.id,
      slot: { start: start.toISOString(), end: end.toISOString() },
    });
    expect(chat).not.toBeNull();

    const staff = await createAppointment(org.id, {
      type: "inspection",
      scheduledStart: start,
      scheduledEnd: end,
    });
    expect(staff).toBe("conflict");
  });

  it("refuses a staff booking overlapping (not identical to) a chat booking", async () => {
    const { start, end } = slotAt(72);
    await bookInspectionSlot({
      organizationId: org.id,
      slot: { start: start.toISOString(), end: end.toISOString() },
    });
    const staff = await createAppointment(org.id, {
      type: "inspection",
      scheduledStart: new Date(start.getTime() + 3_600_000),
      scheduledEnd: new Date(end.getTime() + 3_600_000),
    });
    expect(staff).toBe("conflict");
  });

  it("refuses an end-less staff booking that overlaps a chat booking (2h window assumed)", async () => {
    const { start, end } = slotAt(192);
    await bookInspectionSlot({
      organizationId: org.id,
      slot: { start: start.toISOString(), end: end.toISOString() },
    });
    const staff = await createAppointment(org.id, {
      type: "inspection",
      scheduledStart: new Date(start.getTime() + 3_600_000),
    });
    expect(staff).toBe("conflict");
  });

  it("persists an inferred end for end-less staff bookings so they block later bookings", async () => {
    const { start, end } = slotAt(216);
    const first = await createAppointment(org.id, {
      type: "inspection",
      scheduledStart: start,
    });
    expect(first).not.toBe("conflict");
    expect((first as { scheduledEnd: Date | null }).scheduledEnd).not.toBeNull();

    const second = await createAppointment(org.id, {
      type: "inspection",
      scheduledStart: start,
      scheduledEnd: end,
    });
    expect(second).toBe("conflict");
    const chat = await bookInspectionSlot({
      organizationId: org.id,
      slot: { start: start.toISOString(), end: end.toISOString() },
    });
    expect(chat).toBeNull();
  });

  it("treats legacy rows with null end as 2-hour windows in conflict checks", async () => {
    const { start, end } = slotAt(240);
    await db.insert(appointmentsTable).values({
      organizationId: org.id,
      type: "inspection",
      status: "scheduled",
      scheduledStart: start,
      scheduledEnd: null,
    });
    const staff = await createAppointment(org.id, {
      type: "inspection",
      scheduledStart: start,
      scheduledEnd: end,
    });
    expect(staff).toBe("conflict");
    const chat = await bookInspectionSlot({
      organizationId: org.id,
      slot: { start: start.toISOString(), end: end.toISOString() },
    });
    expect(chat).toBeNull();
  });

  it("refuses a chat booking colliding with a staff booking", async () => {
    const { start, end } = slotAt(96);
    const staff = await createAppointment(org.id, {
      type: "inspection",
      scheduledStart: start,
      scheduledEnd: end,
    });
    expect(staff).not.toBe("conflict");
    const chat = await bookInspectionSlot({
      organizationId: org.id,
      slot: { start: start.toISOString(), end: end.toISOString() },
    });
    expect(chat).toBeNull();
  });

  it("lets only one of two simultaneous overlapping bookings with different starts succeed", async () => {
    const { start, end } = slotAt(264);
    const shifted = {
      start: new Date(start.getTime() + 3_600_000),
      end: new Date(end.getTime() + 3_600_000),
    };
    const [a, b] = await Promise.all([
      createAppointment(org.id, {
        type: "inspection",
        scheduledStart: start,
        scheduledEnd: end,
      }),
      createAppointment(org.id, {
        type: "inspection",
        scheduledStart: shifted.start,
        scheduledEnd: shifted.end,
      }),
    ]);
    const succeeded = [a, b].filter((r) => r !== "conflict" && r !== null);
    expect(succeeded.length).toBe(1);
    expect([a, b].filter((r) => r === "conflict").length).toBe(1);
  });

  it("does not block non-inspection appointments in the same window", async () => {
    const { start, end } = slotAt(120);
    await bookInspectionSlot({
      organizationId: org.id,
      slot: { start: start.toISOString(), end: end.toISOString() },
    });
    const other = await createAppointment(org.id, {
      type: "estimate_review",
      scheduledStart: start,
      scheduledEnd: end,
    });
    expect(other).not.toBe("conflict");
    expect(other).not.toBeNull();
  });

  it("does not let a non-inspection appointment consume inspection capacity", async () => {
    const { start, end } = slotAt(288);
    const other = await createAppointment(org.id, {
      type: "production",
      scheduledStart: start,
      scheduledEnd: end,
    });
    expect(other).not.toBe("conflict");
    expect(other).not.toBeNull();

    const staff = await createAppointment(org.id, {
      type: "inspection",
      scheduledStart: start,
      scheduledEnd: end,
    });
    expect(staff).not.toBe("conflict");
    expect(staff).not.toBeNull();

    // ...and the window is now genuinely full for the chat path.
    const chat = await bookInspectionSlot({
      organizationId: org.id,
      slot: { start: start.toISOString(), end: end.toISOString() },
    });
    expect(chat).toBeNull();
  });

  it("lets the concierge book over a non-inspection appointment", async () => {
    const { start, end } = slotAt(312);
    await createAppointment(org.id, {
      type: "estimate_review",
      scheduledStart: start,
      scheduledEnd: end,
    });
    const chat = await bookInspectionSlot({
      organizationId: org.id,
      slot: { start: start.toISOString(), end: end.toISOString() },
    });
    expect(chat).not.toBeNull();
  });

  it("refuses rescheduling an inspection into an already-full window", async () => {
    const full = slotAt(336);
    const free = slotAt(360);
    const blocker = await createAppointment(org.id, {
      type: "inspection",
      scheduledStart: full.start,
      scheduledEnd: full.end,
    });
    expect(blocker).not.toBe("conflict");
    const victim = await createAppointment(org.id, {
      type: "inspection",
      scheduledStart: free.start,
      scheduledEnd: free.end,
    });
    expect(victim).not.toBe("conflict");
    const id = (victim as { id: string }).id;

    const moved = await updateAppointment(org.id, id, {
      scheduledStart: full.start,
      scheduledEnd: full.end,
    });
    expect(moved).toBe("conflict");

    // The appointment must be untouched by the refused reschedule.
    const same = await updateAppointment(org.id, id, { notes: "still here" });
    expect(same).not.toBe("conflict");
    expect((same as { scheduledStart: Date }).scheduledStart.getTime()).toBe(
      free.start.getTime(),
    );
  });

  it("does not let an inspection's own booking block its reschedule within the same window", async () => {
    const { start, end } = slotAt(384);
    const appt = await createAppointment(org.id, {
      type: "inspection",
      scheduledStart: start,
      scheduledEnd: end,
    });
    expect(appt).not.toBe("conflict");
    const moved = await updateAppointment(org.id, (appt as { id: string }).id, {
      scheduledStart: new Date(start.getTime() + 1_800_000),
      scheduledEnd: new Date(end.getTime() + 1_800_000),
    });
    expect(moved).not.toBe("conflict");
    expect(moved).not.toBeNull();
  });

  it("refuses reactivating a cancelled inspection when its window has since filled", async () => {
    const { start, end } = slotAt(408);
    const cancelled = await createAppointment(org.id, {
      type: "inspection",
      status: "cancelled",
      scheduledStart: start,
      scheduledEnd: end,
    });
    const filler = await createAppointment(org.id, {
      type: "inspection",
      scheduledStart: start,
      scheduledEnd: end,
    });
    expect(filler).not.toBe("conflict");

    const revived = await updateAppointment(
      org.id,
      (cancelled as { id: string }).id,
      { status: "scheduled" },
    );
    expect(revived).toBe("conflict");
  });

  it("refuses an end-less reschedule overlapping a full window (2h window assumed)", async () => {
    const full = slotAt(432);
    const free = slotAt(456);
    await createAppointment(org.id, {
      type: "inspection",
      scheduledStart: full.start,
      scheduledEnd: full.end,
    });
    const victim = await createAppointment(org.id, {
      type: "inspection",
      scheduledStart: free.start,
      scheduledEnd: free.end,
    });
    const moved = await updateAppointment(org.id, (victim as { id: string }).id, {
      scheduledStart: new Date(full.start.getTime() + 3_600_000),
      scheduledEnd: null,
    });
    expect(moved).toBe("conflict");
  });

  it("does not block a cancelled inspection's window", async () => {
    const { start, end } = slotAt(144);
    const cancelled = await createAppointment(org.id, {
      type: "inspection",
      status: "cancelled",
      scheduledStart: start,
      scheduledEnd: end,
    });
    expect(cancelled).not.toBe("conflict");
    const staff = await createAppointment(org.id, {
      type: "inspection",
      scheduledStart: start,
      scheduledEnd: end,
    });
    expect(staff).not.toBe("conflict");
    expect(staff).not.toBeNull();
  });
});
