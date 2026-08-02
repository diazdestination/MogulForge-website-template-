import {
  appointmentsTable,
  db,
  organizationsTable,
  orgSettingsTable,
  scheduledActionsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAppointment, updateAppointment } from "./crm";

let org: { id: string };

beforeAll(async () => {
  const [row] = await db
    .insert(organizationsTable)
    .values({ name: "Past Start Test Org", slug: `test-past-start-${Date.now()}` })
    .returning();
  org = row;
});

afterAll(async () => {
  await db
    .delete(scheduledActionsTable)
    .where(eq(scheduledActionsTable.organizationId, org.id));
  await db.delete(appointmentsTable).where(eq(appointmentsTable.organizationId, org.id));
  await db.delete(orgSettingsTable).where(eq(orgSettingsTable.organizationId, org.id));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, org.id));
});

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000);

describe("createAppointment past-start guard", () => {
  it("rejects an active appointment materially in the past", async () => {
    const result = await createAppointment(org.id, {
      type: "other",
      status: "scheduled",
      scheduledStart: hoursFromNow(-2),
    });
    expect(result).toBe("past_start");
  });

  it("rejects when status defaults to scheduled", async () => {
    const result = await createAppointment(org.id, {
      type: "other",
      scheduledStart: hoursFromNow(-2),
    });
    expect(result).toBe("past_start");
  });

  it("allows a start within the 60-second grace window", async () => {
    const result = await createAppointment(org.id, {
      type: "other",
      status: "scheduled",
      scheduledStart: new Date(Date.now() - 30_000),
    });
    expect(result).not.toBe("past_start");
    expect(result).not.toBeNull();
  });

  it("allows back-dating a completed appointment for history", async () => {
    const result = await createAppointment(org.id, {
      type: "other",
      status: "completed",
      scheduledStart: hoursFromNow(-24),
    });
    expect(result).not.toBe("past_start");
    expect(result).not.toBeNull();
  });

  it("allows a future start", async () => {
    const result = await createAppointment(org.id, {
      type: "other",
      status: "scheduled",
      scheduledStart: hoursFromNow(24),
    });
    expect(result).not.toBe("past_start");
    expect(result).not.toBeNull();
  });
});

describe("updateAppointment past-start guard", () => {
  it("rejects rescheduling an active appointment into the past", async () => {
    const appt = await createAppointment(org.id, {
      type: "other",
      status: "scheduled",
      scheduledStart: hoursFromNow(24),
    });
    expect(appt).not.toBe("past_start");
    expect(appt).not.toBe("conflict");
    expect(appt).not.toBeNull();
    const id = (appt as { id: string }).id;
    const result = await updateAppointment(org.id, id, {
      scheduledStart: hoursFromNow(-2),
    });
    expect(result).toBe("past_start");
  });

  it("allows a status-only update on a past appointment", async () => {
    // Create as completed (allowed in the past), then flip status.
    const appt = await createAppointment(org.id, {
      type: "other",
      status: "completed",
      scheduledStart: hoursFromNow(-48),
    });
    const id = (appt as { id: string }).id;
    const result = await updateAppointment(org.id, id, { status: "no_show" });
    expect(result).not.toBe("past_start");
    expect(result).not.toBeNull();
  });

  it("allows moving a start when the update also cancels the appointment", async () => {
    const appt = await createAppointment(org.id, {
      type: "other",
      status: "scheduled",
      scheduledStart: hoursFromNow(24),
    });
    const id = (appt as { id: string }).id;
    const result = await updateAppointment(org.id, id, {
      status: "cancelled",
      scheduledStart: hoursFromNow(-2),
    });
    expect(result).not.toBe("past_start");
    expect(result).not.toBeNull();
  });

  it("rejects reactivating a past appointment via a status-only update", async () => {
    const appt = await createAppointment(org.id, {
      type: "other",
      status: "completed",
      scheduledStart: hoursFromNow(-24),
    });
    const id = (appt as { id: string }).id;
    const result = await updateAppointment(org.id, id, { status: "scheduled" });
    expect(result).toBe("past_start");
    const confirmed = await updateAppointment(org.id, id, { status: "confirmed" });
    expect(confirmed).toBe("past_start");
  });

  it("allows reactivating a past appointment when the update also moves it to the future", async () => {
    const appt = await createAppointment(org.id, {
      type: "other",
      status: "cancelled",
      scheduledStart: hoursFromNow(-24),
    });
    const id = (appt as { id: string }).id;
    const result = await updateAppointment(org.id, id, {
      status: "scheduled",
      scheduledStart: hoursFromNow(24),
    });
    expect(result).not.toBe("past_start");
    expect(result).not.toBeNull();
  });

  it("allows confirming an active appointment whose start just passed", async () => {
    // Insert directly: an appointment booked in the future that has since
    // started — confirming it is routine status churn, not a past booking.
    const [row] = await db
      .insert(appointmentsTable)
      .values({
        organizationId: org.id,
        type: "other",
        status: "scheduled",
        scheduledStart: hoursFromNow(-1),
      })
      .returning();
    const result = await updateAppointment(org.id, row.id, { status: "confirmed" });
    expect(result).not.toBe("past_start");
    expect(result).not.toBeNull();
  });

  it("allows rescheduling to a future time", async () => {
    const appt = await createAppointment(org.id, {
      type: "other",
      status: "scheduled",
      scheduledStart: hoursFromNow(24),
    });
    const id = (appt as { id: string }).id;
    const result = await updateAppointment(org.id, id, {
      scheduledStart: hoursFromNow(48),
    });
    expect(result).not.toBe("past_start");
    expect(result).not.toBeNull();
  });
});
