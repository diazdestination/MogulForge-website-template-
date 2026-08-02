/**
 * listAuditEvents must support action + since filters so a security event
 * (e.g. api_key.brute_force_blocked) is never crowded out of the newest-200
 * window by routine audit noise on a busy org.
 */
import { auditEventsTable, db, organizationsTable } from "@workspace/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

process.env.SESSION_SECRET ??= "test-session-secret";

const { listAuditEvents } = await import("./crm");

const stamp = Date.now();
let orgId: string;

const dayMs = 24 * 60 * 60 * 1000;
const sixDaysAgo = new Date(Date.now() - 6 * dayMs);
const tenDaysAgo = new Date(Date.now() - 10 * dayMs);

beforeAll(async () => {
  const [org] = await db
    .insert(organizationsTable)
    .values({ name: "Audit Filter Org", slug: `audit-filter-${stamp}` })
    .returning();
  orgId = org.id;

  // One week-old security event, one stale security event, and 250 routine
  // events that would push the security event out of an unfiltered top-200.
  await db.insert(auditEventsTable).values([
    {
      organizationId: orgId,
      action: "api_key.brute_force_blocked",
      entityType: "api_key",
      metadata: { ip: "203.0.113.5" },
      createdAt: sixDaysAgo,
    },
    {
      organizationId: orgId,
      action: "api_key.brute_force_blocked",
      entityType: "api_key",
      metadata: { ip: "203.0.113.6" },
      createdAt: tenDaysAgo,
    },
    ...Array.from({ length: 250 }, (_, i) => ({
      organizationId: orgId,
      action: "lead.updated",
      entityType: "lead",
      metadata: {},
      createdAt: new Date(Date.now() - i * 1000),
    })),
  ]);
});

afterAll(async () => {
  await deleteTestOrgs(orgId);
});

describe("listAuditEvents filters", () => {
  it("unfiltered top-200 crowds out the older security event (the bug being guarded against)", async () => {
    const rows = await listAuditEvents(orgId);
    expect(rows).toHaveLength(200);
    expect(rows.some((r) => r.action === "api_key.brute_force_blocked")).toBe(false);
  });

  it("action filter returns only matching events regardless of noise", async () => {
    const rows = await listAuditEvents(orgId, { action: "api_key.brute_force_blocked" });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.action === "api_key.brute_force_blocked")).toBe(true);
  });

  it("action + since keeps the 7-day window event and drops the stale one", async () => {
    const rows = await listAuditEvents(orgId, {
      action: "api_key.brute_force_blocked",
      since: new Date(Date.now() - 7 * dayMs),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ ip: "203.0.113.5" });
  });
});
