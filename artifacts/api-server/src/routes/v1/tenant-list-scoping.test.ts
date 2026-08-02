import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { db, organizationsTable, usersTable } from "@workspace/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

import app from "../../app";
import { createSession } from "../../lib/auth";
import * as crm from "../../services/crm";

/**
 * Tenant scoping tests for estimate and appointment list endpoints:
 * GET /v1/estimates?leadId=X and GET /v1/appointments?leadId=X must return an
 * empty array when X belongs to another organization — the org condition in
 * the service layer must always compose with the lead filter.
 */

let server: Server;
let baseUrl: string;
let sid: string;
let orgAId: string;
let orgBId: string;

let leadA: { id: string };
let estimateA: { id: string };
let appointmentA: { id: string };
let contactAId: string;
let propertyA: { id: string };

let foreignLead: { id: string };
let foreignEstimate: { id: string };
let foreignAppointment: { id: string };
let foreignContactId: string;
let foreignProperty: { id: string };

async function get(path: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${sid}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Array<{ id: string }>;
}

beforeAll(async () => {
  const [orgA] = await db
    .insert(organizationsTable)
    .values({ name: "Tenant List Scope Org A", slug: `tenant-list-scope-a-${Date.now()}` })
    .returning();
  orgAId = orgA.id;
  const [admin] = await db
    .insert(usersTable)
    .values({
      email: `tenant-list-admin-${Date.now()}@example.com`,
      organizationId: orgA.id,
      role: "admin",
    })
    .returning();

  sid = await createSession({
    user: {
      id: admin.id,
      email: null,
      firstName: null,
      lastName: null,
      profileImageUrl: null,
    },
    access_token: "test-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });

  const contactA = await crm.createContact(orgA.id, {
    firstName: "Local",
    lastName: "Homeowner",
  });
  leadA = (await crm.createLead(orgA.id, {
    contactId: contactA.id,
    status: "new",
  }))!;
  estimateA = (await crm.createEstimate(orgA.id, {
    leadId: leadA.id,
    title: "Roof replacement",
  }))!;
  const apptA = await crm.createAppointment(orgA.id, {
    leadId: leadA.id,
    contactId: contactA.id,
    type: "other",
    scheduledStart: new Date(Date.now() + 24 * 3600 * 1000),
  });
  expect(apptA).not.toBe("conflict");
  appointmentA = apptA as { id: string };
  contactAId = contactA.id;
  propertyA = (await crm.createProperty(orgA.id, {
    contactId: contactA.id,
    addressLine1: "123 Local St", city: "Localville", state: "TX", postalCode: "75001",
  }))!;

  // Second organization with its own lead, estimate, and appointment. Querying
  // org A's endpoints with these ids must never leak org B's data.
  const [orgB] = await db
    .insert(organizationsTable)
    .values({ name: "Tenant List Scope Org B", slug: `tenant-list-scope-b-${Date.now()}` })
    .returning();
  orgBId = orgB.id;
  const contactB = await crm.createContact(orgB.id, {
    firstName: "Foreign",
    lastName: "Homeowner",
  });
  foreignLead = (await crm.createLead(orgB.id, {
    contactId: contactB.id,
    status: "new",
  }))!;
  foreignEstimate = (await crm.createEstimate(orgB.id, {
    leadId: foreignLead.id,
    title: "Foreign estimate",
  }))!;
  const apptB = await crm.createAppointment(orgB.id, {
    leadId: foreignLead.id,
    contactId: contactB.id,
    type: "other",
    scheduledStart: new Date(Date.now() + 24 * 3600 * 1000),
  });
  expect(apptB).not.toBe("conflict");
  foreignAppointment = apptB as { id: string };
  foreignContactId = contactB.id;
  foreignProperty = (await crm.createProperty(orgB.id, {
    contactId: contactB.id,
    addressLine1: "456 Foreign Ave", city: "Foreignton", state: "OK", postalCode: "73001",
  }))!;

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteTestOrgs(orgAId, orgBId);
});

describe("GET /v1/estimates?leadId", () => {
  it("returns the org's own estimates for its own lead", async () => {
    const rows = await get(`/v1/estimates?leadId=${leadA.id}`);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(estimateA.id);
    expect(ids).not.toContain(foreignEstimate.id);
  });

  it("returns an empty array when filtering by another org's lead id", async () => {
    const rows = await get(`/v1/estimates?leadId=${foreignLead.id}`);
    expect(rows).toEqual([]);
  });

  it("never includes another org's estimates in the unfiltered list", async () => {
    const rows = await get(`/v1/estimates`);
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(foreignEstimate.id);
  });
});

describe("GET /v1/appointments?leadId", () => {
  it("returns the org's own appointments for its own lead", async () => {
    const rows = await get(`/v1/appointments?leadId=${leadA.id}`);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(appointmentA.id);
    expect(ids).not.toContain(foreignAppointment.id);
  });

  it("returns an empty array when filtering by another org's lead id", async () => {
    const rows = await get(`/v1/appointments?leadId=${foreignLead.id}`);
    expect(rows).toEqual([]);
  });

  it("never includes another org's appointments in the unfiltered list", async () => {
    const rows = await get(`/v1/appointments`);
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(foreignAppointment.id);
  });
});

describe("GET /v1/properties?contactId", () => {
  it("returns the org's own properties for its own contact", async () => {
    const rows = await get(`/v1/properties?contactId=${contactAId}`);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(propertyA.id);
    expect(ids).not.toContain(foreignProperty.id);
  });

  it("returns an empty array when filtering by another org's contact id", async () => {
    const rows = await get(`/v1/properties?contactId=${foreignContactId}`);
    expect(rows).toEqual([]);
  });

  it("never includes another org's properties in the unfiltered list", async () => {
    const rows = await get(`/v1/properties`);
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain(foreignProperty.id);
  });
});
