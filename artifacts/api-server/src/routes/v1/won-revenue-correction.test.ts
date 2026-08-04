/**
 * Route-level tests for PATCH /v1/leads/:id/won-revenue.
 *
 * Verifies:
 * - Admin can correct won revenue; audit event is recorded; ROI report
 *   immediately reflects the corrected figure.
 * - Non-admin (sales_rep) is rejected with 403.
 * - Correcting a lead that hasn't been won yet returns 409.
 * - Unknown lead returns 404.
 * - Revenue can be cleared (null) as well as updated.
 * - Attribution category is untouched after correction.
 */

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import {
  auditEventsTable,
  contactsTable,
  db,
  DEFAULT_SENDING_HOURS,
  leadsTable,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";
import app from "../../app";
import { createSession } from "../../lib/auth";
import { classifyWonLead } from "../../services/post-sale";
import { getRoiReport } from "../../services/roi-report";
import { updateOrgSettings } from "../../services/settings";
import * as crm from "../../services/crm";

let server: Server;
let baseUrl: string;

let org: { id: string };
let adminSid: string;
let repSid: string;

const stamp = Date.now();

async function makeWonLead(estimatedValueCents = 500_000) {
  const contact = await crm.createContact(org.id, {
    firstName: "Won",
    lastName: "RevTest",
    email: `wonrev-${stamp}-${Math.random().toString(36).slice(2)}@test.example`,
  });
  const lead = await crm.createLead(org.id, { contactId: contact.id });
  await db
    .update(leadsTable)
    .set({ estimatedValueCents })
    .where(eq(leadsTable.id, lead!.id));
  await classifyWonLead(org.id, lead!.id);
  return lead!;
}

async function patchRevenue(
  leadId: string,
  body: unknown,
  sid = adminSid,
) {
  return fetch(
    `${baseUrl}/v1/leads/${encodeURIComponent(leadId)}/won-revenue`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${sid}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

beforeAll(async () => {
  const [orgRow] = await db
    .insert(organizationsTable)
    .values({ name: "WonRev Org", slug: `wonrev-${stamp}` })
    .returning();
  org = orgRow;

  await updateOrgSettings(org.id, {
    sendingHours: { ...DEFAULT_SENDING_HOURS, quietHoursEnabled: false },
  });

  const [adminUser] = await db
    .insert(usersTable)
    .values({
      email: `wonrev-admin-${stamp}@example.com`,
      organizationId: org.id,
      role: "admin",
    })
    .returning();
  adminSid = await createSession({
    user: {
      id: adminUser.id,
      email: null,
      firstName: null,
      lastName: null,
      profileImageUrl: null,
    },
    access_token: "test-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });

  const [repUser] = await db
    .insert(usersTable)
    .values({
      email: `wonrev-rep-${stamp}@example.com`,
      organizationId: org.id,
      role: "sales_rep",
    })
    .returning();
  repSid = await createSession({
    user: {
      id: repUser.id,
      email: null,
      firstName: null,
      lastName: null,
      profileImageUrl: null,
    },
    access_token: "test-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteTestOrgs(org.id);
});

describe("PATCH /v1/leads/:id/won-revenue", () => {
  it("admin corrects revenue → 204, audit recorded, ROI reflects new figure", async () => {
    const lead = await makeWonLead(300_000);

    const res = await patchRevenue(lead.id, { wonRevenueCents: 450_000 });
    expect(res.status).toBe(204);

    // Verify DB
    const [row] = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.id, lead.id));
    expect(row.wonRevenueCents).toBe(450_000);
    // Attribution must be untouched
    expect(row.wonAttribution).toBe("estimated");

    // Audit event
    const [event] = await db
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.organizationId, org.id),
          eq(auditEventsTable.entityId, lead.id),
          eq(auditEventsTable.action, "lead.won_revenue_corrected"),
        ),
      )
      .limit(1);
    expect(event).toBeDefined();
    expect(event.metadata).toMatchObject({
      previousCents: 300_000,
      newCents: 450_000,
    });

    // ROI report picks up corrected figure
    const report = await getRoiReport(org.id, 30);
    expect(report.outcomes.revenueWonCents).toBeGreaterThanOrEqual(450_000);
  });

  it("admin can clear revenue to null → 204, wonRevenueCents becomes null", async () => {
    const lead = await makeWonLead(200_000);

    const res = await patchRevenue(lead.id, { wonRevenueCents: null });
    expect(res.status).toBe(204);

    const [row] = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.id, lead.id));
    expect(row.wonRevenueCents).toBeNull();
    // Attribution still untouched
    expect(row.wonAttribution).toBe("estimated");
  });

  it("sales_rep cannot correct revenue → 403", async () => {
    const lead = await makeWonLead(100_000);
    const res = await patchRevenue(lead.id, { wonRevenueCents: 999_999 }, repSid);
    expect(res.status).toBe(403);
  });

  it("correcting a not-yet-won lead → 409", async () => {
    const contact = await crm.createContact(org.id, {
      firstName: "NotWon",
      lastName: "Rev",
      email: `notwon-${stamp}-${Math.random().toString(36).slice(2)}@test.example`,
    });
    const lead = await crm.createLead(org.id, { contactId: contact.id });
    const res = await patchRevenue(lead!.id, { wonRevenueCents: 100_000 });
    expect(res.status).toBe(409);
  });

  it("unknown lead → 404", async () => {
    const res = await patchRevenue(
      "00000000-0000-0000-0000-000000000000",
      { wonRevenueCents: 100_000 },
    );
    expect(res.status).toBe(404);
  });

  it("negative amount is rejected → 400", async () => {
    const lead = await makeWonLead(100_000);
    const res = await patchRevenue(lead.id, { wonRevenueCents: -500 });
    expect(res.status).toBe(400);
  });

  it("missing field is rejected → 400", async () => {
    const lead = await makeWonLead(100_000);
    const res = await patchRevenue(lead.id, {});
    expect(res.status).toBe(400);
  });
});
