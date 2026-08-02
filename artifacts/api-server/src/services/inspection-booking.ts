/**
 * Shared capacity-guarded insert for inspection appointments.
 *
 * Both the concierge chat booking and staff CRM/API booking go through this
 * helper so neither path can double-book an inspection window the other just
 * filled. The transaction takes a per-org+start advisory lock and re-counts
 * overlapping active inspections against the org's configured capacity.
 */
import { appointmentsTable, db } from "@workspace/db";
import { and, eq, gt, inArray, lt, ne, sql } from "drizzle-orm";

import { getInspectionAvailability } from "./settings";

type AppointmentInsert = typeof appointmentsTable.$inferInsert;
export type AppointmentRow = typeof appointmentsTable.$inferSelect;

/**
 * Insert an inspection appointment only if its window still has capacity.
 * When no scheduledEnd is provided, a standard 2-hour window is assumed for
 * the conflict check (same convention the concierge slot offering uses for
 * end-less appointments). Returns the inserted row, or null when full.
 */
export async function insertInspectionIfAvailable(
  values: AppointmentInsert & { scheduledStart: Date },
): Promise<AppointmentRow | null> {
  const { maxBookingsPerWindow } = await getInspectionAvailability(values.organizationId);
  const start = values.scheduledStart;
  const end = values.scheduledEnd ?? new Date(start.getTime() + 2 * 3_600_000);
  return db.transaction(async (tx) => {
    // Serialize all inspection bookings for the org for this transaction.
    // A per-window lock key would miss overlapping windows with different
    // start times, so we take one org-wide lock; inspection bookings are
    // infrequent enough that this coarse lock is not a throughput concern.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${values.organizationId}:inspection-booking`}))`,
    );
    const conflicts = await tx
      .select({ id: appointmentsTable.id })
      .from(appointmentsTable)
      .where(
        and(
          eq(appointmentsTable.organizationId, values.organizationId),
          // Only inspections consume inspection-window capacity; other
          // appointment types (production, estimate review, …) may overlap.
          eq(appointmentsTable.type, "inspection"),
          inArray(appointmentsTable.status, ["scheduled", "confirmed"]),
          lt(appointmentsTable.scheduledStart, end),
          // Legacy rows may lack an end; treat them as 2-hour windows so they
          // still consume capacity instead of vanishing from conflict checks.
          gt(
            sql`coalesce(${appointmentsTable.scheduledEnd}, ${appointmentsTable.scheduledStart} + interval '2 hours')`,
            start,
          ),
        ),
      )
      .limit(maxBookingsPerWindow);
    if (conflicts.length >= maxBookingsPerWindow) return null;
    // Persist the (possibly inferred) end so future overlap checks see the
    // full window this booking occupies.
    const [row] = await tx
      .insert(appointmentsTable)
      .values({ ...values, scheduledEnd: end })
      .returning();
    return row;
  });
}

/**
 * Apply an update to an existing appointment only if the (new) inspection
 * window still has capacity — the appointment being edited is excluded from
 * the conflict count so it never blocks itself. Same lock + counting rules as
 * insertInspectionIfAvailable. Returns the updated row, "conflict" when the
 * window is full, or null when the appointment no longer exists.
 */
export async function updateInspectionIfAvailable(
  organizationId: string,
  appointmentId: string,
  set: Partial<AppointmentInsert>,
  window: { start: Date; end?: Date | null },
): Promise<AppointmentRow | null | "conflict"> {
  const { maxBookingsPerWindow } = await getInspectionAvailability(organizationId);
  const start = window.start;
  const end = window.end ?? new Date(start.getTime() + 2 * 3_600_000);
  return db.transaction(async (tx) => {
    // Same org-wide lock as the insert path so inserts and reschedules
    // serialize against each other.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`${organizationId}:inspection-booking`}))`,
    );
    const conflicts = await tx
      .select({ id: appointmentsTable.id })
      .from(appointmentsTable)
      .where(
        and(
          eq(appointmentsTable.organizationId, organizationId),
          ne(appointmentsTable.id, appointmentId),
          eq(appointmentsTable.type, "inspection"),
          inArray(appointmentsTable.status, ["scheduled", "confirmed"]),
          lt(appointmentsTable.scheduledStart, end),
          gt(
            sql`coalesce(${appointmentsTable.scheduledEnd}, ${appointmentsTable.scheduledStart} + interval '2 hours')`,
            start,
          ),
        ),
      )
      .limit(maxBookingsPerWindow);
    if (conflicts.length >= maxBookingsPerWindow) return "conflict";
    // Persist the (possibly inferred) end so future overlap checks see the
    // full window this booking occupies.
    const [row] = await tx
      .update(appointmentsTable)
      .set({ ...set, scheduledEnd: end })
      .where(
        and(
          eq(appointmentsTable.id, appointmentId),
          eq(appointmentsTable.organizationId, organizationId),
        ),
      )
      .returning();
    return row ?? null;
  });
}
