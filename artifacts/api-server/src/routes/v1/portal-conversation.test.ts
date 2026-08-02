import { createHash } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  activitiesTable,
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  portalSessionsTable,
} from "@workspace/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

import app from "../../app";

/**
 * Route-level tests for GET /v1/portal/claims/:id/conversation — the full
 * homeowner/team message thread. Unlike the overview's capped updates list,
 * this endpoint must return EVERY message, oldest to newest, and never leak
 * another homeowner's claim.
 */

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

let server: Server;
let baseUrl: string;
let org: { id: string };
let token: string;
let leadId: string;
let otherLeadId: string;

const EMAIL = `portal-convo-${Date.now()}@example.com`;
const EMAIL_OTHER = `portal-convo-other-${Date.now()}@example.com`;
const MESSAGE_COUNT = 30; // well past the overview's 20-item updates cap

beforeAll(async () => {
  const [o] = await db
    .insert(organizationsTable)
    .values({ name: "Portal Convo Org", slug: `portal-convo-${Date.now()}` })
    .returning();
  org = o;

  const [contact] = await db
    .insert(contactsTable)
    .values({ organizationId: org.id, firstName: "Pat", email: EMAIL })
    .returning();
  const [otherContact] = await db
    .insert(contactsTable)
    .values({ organizationId: org.id, firstName: "Sam", email: EMAIL_OTHER })
    .returning();
  const [lead] = await db
    .insert(leadsTable)
    .values({ organizationId: org.id, contactId: contact.id })
    .returning();
  leadId = lead.id;
  const [otherLead] = await db
    .insert(leadsTable)
    .values({ organizationId: org.id, contactId: otherContact.id })
    .returning();
  otherLeadId = otherLead.id;

  const base = Date.now() - MESSAGE_COUNT * 60_000;
  await db.insert(activitiesTable).values(
    Array.from({ length: MESSAGE_COUNT }, (_, i) => ({
      organizationId: org.id,
      leadId: lead.id,
      contactId: contact.id,
      type: i % 2 === 0 ? "portal_message" : "team_message",
      title: i % 2 === 0 ? "Message from homeowner (portal)" : "Reply from team",
      body: `message ${i}`,
      occurredAt: new Date(base + i * 60_000),
    })),
  );
  // A status update must NOT appear in the conversation.
  await db.insert(activitiesTable).values({
    organizationId: org.id,
    leadId: lead.id,
    contactId: contact.id,
    type: "status_changed",
    title: "Status changed",
    occurredAt: new Date(),
  });

  token = `portal-convo-token-${Date.now()}`;
  await db.insert(portalSessionsTable).values({
    organizationId: org.id,
    tokenHash: sha256(token),
    identifier: EMAIL,
    channel: "email",
    expiresAt: new Date(Date.now() + 60_000),
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteTestOrgs(org.id);
});

function convoUrl(id: string): string {
  return `${baseUrl}/v1/portal/claims/${id}/conversation`;
}

describe("GET /v1/portal/claims/:id/conversation", () => {
  it("returns the FULL message history, oldest to newest, messages only", async () => {
    const res = await fetch(convoUrl(leadId), {
      headers: { "x-portal-token": token },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      messages: { sender: string; body: string; occurredAt: string }[];
    };
    expect(data.messages).toHaveLength(MESSAGE_COUNT);
    expect(data.messages[0].body).toBe("message 0");
    expect(data.messages[0].sender).toBe("homeowner");
    expect(data.messages[1].sender).toBe("team");
    expect(data.messages[MESSAGE_COUNT - 1].body).toBe(
      `message ${MESSAGE_COUNT - 1}`,
    );
    const times = data.messages.map((m) => new Date(m.occurredAt).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("rejects a missing session", async () => {
    const res = await fetch(convoUrl(leadId));
    expect(res.status).toBe(401);
  });

  it("404s on another homeowner's claim", async () => {
    const res = await fetch(convoUrl(otherLeadId), {
      headers: { "x-portal-token": token },
    });
    expect(res.status).toBe(404);
  });

  it("404s on a non-uuid id", async () => {
    const res = await fetch(convoUrl("not-a-uuid"), {
      headers: { "x-portal-token": token },
    });
    expect(res.status).toBe(404);
  });
});
