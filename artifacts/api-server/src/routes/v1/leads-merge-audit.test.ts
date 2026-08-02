import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import {
  auditEventsTable,
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

import app from "../../app";
import { createSession } from "../../lib/auth";

/**
 * Route-level audit-trail tests for POST /v1/leads/:id/merge.
 *
 * The merge logic itself is covered by service-level tests in
 * services/lead-merge.test.ts. These tests prove that the *HTTP route* emits
 * the `lead.merged` audit event with the correct actor, entity, and metadata
 * so that if the `recordAudit` call is ever dropped in a route refactor,
 * admins won't silently lose their merge history.
 *
 * Authorization (viewer → 403) is already locked in by
 * leads-merge-authz.test.ts, so only the audit-payload shape is asserted here.
 */

let server: Server;
let baseUrl: string;

let org: { id: string };
let adminUserId: string;
let adminSid: string;

const stamp = Date.now();

async function makeLeadWithContact(firstName: string) {
  const [contact] = await db
    .insert(contactsTable)
    .values({ organizationId: org.id, firstName, lastName: "MergeAudit" })
    .returning();
  const [lead] = await db
    .insert(leadsTable)
    .values({ organizationId: org.id, contactId: contact.id })
    .returning();
  return lead;
}

async function mergeRequest(survivorId: string, sourceLeadId: string) {
  return fetch(
    `${baseUrl}/v1/leads/${encodeURIComponent(survivorId)}/merge`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminSid}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sourceLeadId }),
    },
  );
}

beforeAll(async () => {
  const [orgRow] = await db
    .insert(organizationsTable)
    .values({ name: "Merge Audit Org", slug: `merge-audit-${stamp}` })
    .returning();
  org = orgRow;

  const [user] = await db
    .insert(usersTable)
    .values({
      email: `merge-audit-admin-${stamp}@example.com`,
      organizationId: org.id,
      role: "admin",
    })
    .returning();
  adminUserId = user.id;

  adminSid = await createSession({
    user: {
      id: user.id,
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

describe("POST /v1/leads/:id/merge — audit trail", () => {
  it("records a lead.merged audit event on the surviving lead", async () => {
    const survivor = await makeLeadWithContact("AuditSurvivor");
    const source = await makeLeadWithContact("AuditSource");

    const res = await mergeRequest(survivor.id, source.id);
    expect(res.status).toBe(200);

    const [event] = await db
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.organizationId, org.id),
          eq(auditEventsTable.action, "lead.merged"),
          eq(auditEventsTable.entityId, survivor.id),
        ),
      )
      .orderBy(desc(auditEventsTable.createdAt))
      .limit(1);

    expect(event).toBeTruthy();
    expect(event!.entityType).toBe("lead");
    expect(event!.actorUserId).toBe(adminUserId);
  });

  it("includes all seven moved-record counts in the audit metadata", async () => {
    const survivor = await makeLeadWithContact("MetaSurvivor");
    const source = await makeLeadWithContact("MetaSource");

    const res = await mergeRequest(survivor.id, source.id);
    expect(res.status).toBe(200);

    const [event] = await db
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.organizationId, org.id),
          eq(auditEventsTable.action, "lead.merged"),
          eq(auditEventsTable.entityId, survivor.id),
        ),
      )
      .orderBy(desc(auditEventsTable.createdAt))
      .limit(1);

    expect(event).toBeTruthy();
    const meta = event!.metadata as Record<string, unknown>;
    expect(meta.sourceLeadId).toBe(source.id);
    expect(typeof meta.movedActivities).toBe("number");
    expect(typeof meta.movedTags).toBe("number");
    expect(typeof meta.movedAppointments).toBe("number");
    expect(typeof meta.movedTasks).toBe("number");
    expect(typeof meta.movedEstimates).toBe("number");
    expect(typeof meta.movedProjects).toBe("number");
    expect(typeof meta.movedConversations).toBe("number");
  });

  it("does not write an audit event when the merge is rejected (same-lead)", async () => {
    const lead = await makeLeadWithContact("SameLeadAudit");

    const beforeCount = await db
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.organizationId, org.id),
          eq(auditEventsTable.action, "lead.merged"),
          eq(auditEventsTable.entityId, lead.id),
        ),
      );

    const res = await mergeRequest(lead.id, lead.id);
    expect(res.status).toBe(400);

    const afterCount = await db
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.organizationId, org.id),
          eq(auditEventsTable.action, "lead.merged"),
          eq(auditEventsTable.entityId, lead.id),
        ),
      );

    expect(afterCount.length).toBe(beforeCount.length);
  });
});
