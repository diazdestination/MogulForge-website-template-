import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import {
  automationRunsTable,
  automationsTable,
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

import app from "../../app";
import { createSession } from "../../lib/auth";

/**
 * CRM-booked appointments must emit the same appointment.booked match fields
 * as concierge bookings (notably "lead.urgency"), so one org rule covers both
 * booking paths.
 */

let server: Server;
let baseUrl: string;
let org: { id: string };
let sid: string;
let leadId: string;
let contactId: string;
let ruleId: string;

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  const [o] = await db
    .insert(organizationsTable)
    .values({ name: "Appt Urgency Org", slug: `appt-urgency-${Date.now()}` })
    .returning();
  org = o;
  const [u] = await db
    .insert(usersTable)
    .values({
      email: `appt-urgency-${Date.now()}@example.com`,
      organizationId: org.id,
      role: "admin",
    })
    .returning();
  sid = await createSession({
    user: { id: u.id, email: null, firstName: null, lastName: null, profileImageUrl: null },
    access_token: "test-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
  const [contact] = await db
    .insert(contactsTable)
    .values({ organizationId: org.id, firstName: "Urgent", phone: "+15550009999" })
    .returning();
  contactId = contact.id;
  const [lead] = await db
    .insert(leadsTable)
    .values({ organizationId: org.id, contactId: contact.id, urgency: "emergency" })
    .returning();
  leadId = lead.id;
  // Rule conditioned on lead.urgency — must fire for CRM bookings too.
  const [rule] = await db
    .insert(automationsTable)
    .values({
      organizationId: org.id,
      name: "Emergency booking task",
      event: "appointment.booked",
      conditions: { "lead.urgency": "emergency" },
      actions: [{ type: "create_task", params: { title: "Emergency inspection prep" } }],
      isActive: true,
    })
    .returning();
  ruleId = rule.id;

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteTestOrgs(org.id);
});

describe("CRM appointment.booked lead.urgency parity", () => {
  it("fires a lead.urgency-conditioned rule for a CRM-booked appointment", async () => {
    const res = await fetch(`${baseUrl}/v1/appointments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sid}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        leadId,
        contactId,
        type: "estimate_review",
        scheduledStart: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      }),
    });
    expect(res.status).toBe(201);

    const run = await waitFor(async () => {
      const [row] = await db
        .select()
        .from(automationRunsTable)
        .where(
          and(
            eq(automationRunsTable.organizationId, org.id),
            eq(automationRunsTable.automationId, ruleId),
          ),
        );
      return row;
    });
    expect(run.status).toBe("success");
  });
});
