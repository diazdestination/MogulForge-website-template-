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
import { ObjectStorageService } from "../../lib/objectStorage";

/**
 * Route-level tests for GET /v1/portal/photos/objects/* — the homeowner
 * photo streaming endpoint. Auth and ownership are enforced before any
 * object-storage access, so 401/404 paths are fully testable without a
 * real bucket.
 */

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Smallest valid PNG (1x1 transparent pixel).
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

let server: Server;
let baseUrl: string;
let org: { id: string };
let token: string;
let photoOwned: string;
let photoOther: string;

const EMAIL = `portal-photo-${Date.now()}@example.com`;
const EMAIL_OTHER = `portal-photo-other-${Date.now()}@example.com`;

beforeAll(async () => {
  const [o] = await db
    .insert(organizationsTable)
    .values({ name: "Portal Photo Org", slug: `portal-photo-${Date.now()}` })
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
  const [otherLead] = await db
    .insert(leadsTable)
    .values({ organizationId: org.id, contactId: otherContact.id })
    .returning();

  // Upload a real tiny object so the owned-photo request can stream bytes.
  const storage = new ObjectStorageService();
  const uploadUrl = await storage.getObjectEntityUploadURL();
  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": "image/png" },
    body: PNG_BYTES,
  });
  if (!put.ok) throw new Error(`test upload failed: ${put.status}`);
  photoOwned = storage.normalizeObjectEntityPath(uploadUrl);
  photoOther = `/objects/uploads/other-${Date.now()}`;
  await db.insert(activitiesTable).values([
    {
      organizationId: org.id,
      leadId: lead.id,
      contactId: contact.id,
      type: "photos_attached",
      title: "Photos attached",
      metadata: { photoPaths: [photoOwned] },
    },
    {
      organizationId: org.id,
      leadId: otherLead.id,
      contactId: otherContact.id,
      type: "photos_attached",
      title: "Photos attached",
      metadata: { photoPaths: [photoOther] },
    },
  ]);

  token = `portal-photo-token-${Date.now()}`;
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

function photoUrl(objectPath: string): string {
  return `${baseUrl}/v1/portal/photos${objectPath}`;
}

describe("GET /v1/portal/photos/objects/*", () => {
  it("rejects requests without a portal session (401)", async () => {
    const res = await fetch(photoUrl(photoOwned));
    expect(res.status).toBe(401);
  });

  it("rejects requests with a bogus token (401)", async () => {
    const res = await fetch(photoUrl(photoOwned), {
      headers: { "x-portal-token": "not-a-real-token" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for another homeowner's photo, even in the same org", async () => {
    const res = await fetch(photoUrl(photoOther), {
      headers: { "x-portal-token": token },
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for a path never attached to any claim", async () => {
    const res = await fetch(photoUrl("/objects/uploads/never-attached"), {
      headers: { "x-portal-token": token },
    });
    expect(res.status).toBe(404);
  });

  it("streams the homeowner's own photo bytes (200)", async () => {
    const res = await fetch(photoUrl(photoOwned), {
      headers: { "x-portal-token": token },
    });
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.equals(PNG_BYTES)).toBe(true);
  });
});
