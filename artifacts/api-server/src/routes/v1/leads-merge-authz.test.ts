import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { contactsTable, db, leadsTable, organizationsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

import app from "../../app";
import { createSession } from "../../lib/auth";

/**
 * Route-level authorization tests for POST /v1/leads/:id/merge.
 *
 * The pipeline UI hides the merge dialog from read-only users, but UI gating
 * is not a security boundary. These tests lock in that the route middleware
 * (requireMember("crm.write")) rejects viewer-role sessions with 403 and
 * leaves lead data untouched, while a write-capable role (sales_rep) can
 * merge successfully.
 */

let server: Server;
let baseUrl: string;

let org: { id: string };
let viewerSid: string;
let repSid: string;

const stamp = Date.now();

async function makeUserWithSession(role: "viewer" | "sales_rep") {
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `merge-authz-${role}-${stamp}@example.com`,
      organizationId: org.id,
      role,
    })
    .returning();
  const sid = await createSession({
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
  return sid;
}

async function makeLead(firstName: string) {
  const [contact] = await db
    .insert(contactsTable)
    .values({ organizationId: org.id, firstName, lastName: "MergeAuthz" })
    .returning();
  const [lead] = await db
    .insert(leadsTable)
    .values({ organizationId: org.id, contactId: contact.id })
    .returning();
  return lead;
}

async function mergeRequest(survivorId: string, sourceLeadId: string, sid: string) {
  return fetch(`${baseUrl}/v1/leads/${encodeURIComponent(survivorId)}/merge`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${sid}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ sourceLeadId }),
  });
}

beforeAll(async () => {
  const [orgRow] = await db
    .insert(organizationsTable)
    .values({ name: "Merge Authz Org", slug: `merge-authz-${stamp}` })
    .returning();
  org = orgRow;

  viewerSid = await makeUserWithSession("viewer");
  repSid = await makeUserWithSession("sales_rep");

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteTestOrgs(org.id);
});

describe("POST /v1/leads/:id/merge authorization", () => {
  it("returns 403 for a viewer and leaves both leads unchanged", async () => {
    const survivor = await makeLead("ViewerSurvivor");
    const source = await makeLead("ViewerSource");

    const res = await mergeRequest(survivor.id, source.id, viewerSid);
    expect(res.status).toBe(403);

    const [survivorAfter] = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.id, survivor.id));
    const [sourceAfter] = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.id, source.id));

    // No merge side effects: statuses and timestamps are untouched.
    expect(survivorAfter.status).toBe(survivor.status);
    expect(sourceAfter.status).toBe(source.status);
    expect(sourceAfter.updatedAt).toEqual(source.updatedAt);
    expect(survivorAfter.updatedAt).toEqual(survivor.updatedAt);
  });

  it("allows a write-capable role (sales_rep) to merge", async () => {
    const survivor = await makeLead("RepSurvivor");
    const source = await makeLead("RepSource");

    const res = await mergeRequest(survivor.id, source.id, repSid);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(survivor.id);

    const [sourceAfter] = await db
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.id, source.id));
    // The merge marks the source lead lost rather than deleting it.
    expect(sourceAfter.status).not.toBe(source.status);
  });
});
