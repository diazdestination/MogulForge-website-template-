import type { Server } from "http";
import type { AddressInfo } from "net";

import {
  activitiesTable,
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createSession } from "../../lib/auth";
import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

// Stub the GCS-backed storage layer so the HTTP flow can be exercised
// end-to-end without real bucket objects.
vi.mock("../../lib/objectStorage", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/objectStorage")>();
  class StubObjectStorageService {
    async getObjectEntityFile(_path: string) {
      return {
        getMetadata: async () => [
          { contentType: "image/jpeg", size: 1_234_567 },
        ],
      };
    }
    async getObjectEntityUploadURL() {
      return "https://storage.example.com/bucket/.private/uploads/stub-rep-id";
    }
    normalizeObjectEntityPath(_url: string) {
      return "/objects/uploads/stub-rep-id";
    }
    async downloadObject() {
      throw new Error("not used in this test");
    }
  }
  return { ...actual, ObjectStorageService: StubObjectStorageService };
});

// Import after the mock so route modules pick up the stubbed service.
const { default: app } = await import("../../app");

let server: Server;
let baseUrl: string;
let testOrgId: string;
let otherOrgId: string;
let testLeadId: string;
let otherLeadId: string;
let writerSid: string;
let readerSid: string;

const stamp = Date.now();

beforeAll(async () => {
  // Create two orgs — one the writer belongs to, one they shouldn't access
  const [testOrg] = await db
    .insert(organizationsTable)
    .values({ name: `RepPhotoTest-${stamp}`, slug: `rep-photo-test-${stamp}` })
    .returning();
  testOrgId = testOrg.id;

  const [otherOrg] = await db
    .insert(organizationsTable)
    .values({ name: `RepPhotoOther-${stamp}`, slug: `rep-photo-other-${stamp}` })
    .returning();
  otherOrgId = otherOrg.id;

  // Writer (admin) in testOrg
  const [writer] = await db
    .insert(usersTable)
    .values({
      email: `rep-photo-writer-${stamp}@test.dev`,
      organizationId: testOrgId,
      role: "admin",
    })
    .returning();
  writerSid = await createSession({
    user: { id: writer.id, email: null, firstName: null, lastName: null, profileImageUrl: null },
    access_token: "test",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });

  // Viewer (read-only) in testOrg
  const [reader] = await db
    .insert(usersTable)
    .values({
      email: `rep-photo-reader-${stamp}@test.dev`,
      organizationId: testOrgId,
      role: "viewer",
    })
    .returning();
  readerSid = await createSession({
    user: { id: reader.id, email: null, firstName: null, lastName: null, profileImageUrl: null },
    access_token: "test",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });

  // Leads for each org
  const [contact] = await db
    .insert(contactsTable)
    .values({ organizationId: testOrgId, firstName: "RepPhoto", phone: "5550001111" })
    .returning();
  const [lead] = await db
    .insert(leadsTable)
    .values({ organizationId: testOrgId, contactId: contact.id })
    .returning();
  testLeadId = lead.id;

  const [otherContact] = await db
    .insert(contactsTable)
    .values({ organizationId: otherOrgId, firstName: "OtherOrg", phone: "5550002222" })
    .returning();
  const [otherLead] = await db
    .insert(leadsTable)
    .values({ organizationId: otherOrgId, contactId: otherContact.id })
    .returning();
  otherLeadId = otherLead.id;

  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteTestOrgs(testOrgId, otherOrgId);
});

async function jsonPost(path: string, body: unknown, sid?: string) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(sid ? { authorization: `Bearer ${sid}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

// ── POST /v1/leads/:id/photos/request-url ────────────────────────────────────

describe("POST /v1/leads/:id/photos/request-url", () => {
  it("returns a signed upload URL for a valid image (writer)", async () => {
    const res = await jsonPost(
      `/v1/leads/${testLeadId}/photos/request-url`,
      { name: "roof.jpg", size: 500_000, contentType: "image/jpeg" },
      writerSid,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { uploadURL: string; objectPath: string };
    expect(body.uploadURL).toContain("https://");
    expect(body.objectPath).toMatch(/^\/objects\//);
  });

  it("rejects invalid content type (PDF)", async () => {
    const res = await jsonPost(
      `/v1/leads/${testLeadId}/photos/request-url`,
      { name: "doc.pdf", size: 500_000, contentType: "application/pdf" },
      writerSid,
    );
    expect(res.status).toBe(400);
  });

  it("rejects oversized file (>10 MB)", async () => {
    const res = await jsonPost(
      `/v1/leads/${testLeadId}/photos/request-url`,
      { name: "huge.jpg", size: 10 * 1024 * 1024 + 1, contentType: "image/jpeg" },
      writerSid,
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 for a lead in another org", async () => {
    const res = await jsonPost(
      `/v1/leads/${otherLeadId}/photos/request-url`,
      { name: "roof.jpg", size: 500_000, contentType: "image/jpeg" },
      writerSid,
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 for a crm.read-only viewer", async () => {
    const res = await jsonPost(
      `/v1/leads/${testLeadId}/photos/request-url`,
      { name: "roof.jpg", size: 500_000, contentType: "image/jpeg" },
      readerSid,
    );
    expect(res.status).toBe(403);
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await jsonPost(
      `/v1/leads/${testLeadId}/photos/request-url`,
      { name: "roof.jpg", size: 500_000, contentType: "image/jpeg" },
    );
    expect(res.status).toBe(401);
  });
});

// ── POST /v1/leads/:id/photos ─────────────────────────────────────────────────

describe("POST /v1/leads/:id/photos", () => {
  it("creates a photos_attached activity for valid photoPaths (writer)", async () => {
    const path = `/objects/uploads/rep-test-${stamp}`;
    const res = await jsonPost(
      `/v1/leads/${testLeadId}/photos`,
      { photoPaths: [path] },
      writerSid,
    );
    expect(res.status).toBe(201);
    const activity = (await res.json()) as {
      type: string;
      title: string;
      metadata: { photoPaths: string[] };
    };
    expect(activity.type).toBe("photos_attached");
    expect(activity.title).toMatch(/Rep attached 1 photo/);
    expect(activity.metadata.photoPaths).toEqual([path]);

    // Confirm it was persisted in the DB
    const rows = await db
      .select()
      .from(activitiesTable)
      .where(eq(activitiesTable.leadId, testLeadId));
    const photoAct = rows.find(
      (a) =>
        a.type === "photos_attached" &&
        (a.metadata as { photoPaths?: string[] })?.photoPaths?.includes(path),
    );
    expect(photoAct).toBeDefined();
  });

  it("uses plural form when multiple photos are attached", async () => {
    const paths = [
      `/objects/uploads/rep-multi-${stamp}-a`,
      `/objects/uploads/rep-multi-${stamp}-b`,
    ];
    const res = await jsonPost(
      `/v1/leads/${testLeadId}/photos`,
      { photoPaths: paths },
      writerSid,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { title: string };
    expect(body.title).toMatch(/Rep attached 2 photos/);
  });

  it("rejects photoPaths that don't start with /objects/", async () => {
    const res = await jsonPost(
      `/v1/leads/${testLeadId}/photos`,
      { photoPaths: ["../evil/path"] },
      writerSid,
    );
    expect(res.status).toBe(400);
  });

  it("rejects an empty photoPaths array", async () => {
    const res = await jsonPost(
      `/v1/leads/${testLeadId}/photos`,
      { photoPaths: [] },
      writerSid,
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 for a lead in another org", async () => {
    const res = await jsonPost(
      `/v1/leads/${otherLeadId}/photos`,
      { photoPaths: ["/objects/uploads/stub-rep-id"] },
      writerSid,
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 for a crm.read-only viewer", async () => {
    const res = await jsonPost(
      `/v1/leads/${testLeadId}/photos`,
      { photoPaths: ["/objects/uploads/stub-rep-id"] },
      readerSid,
    );
    expect(res.status).toBe(403);
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await jsonPost(
      `/v1/leads/${testLeadId}/photos`,
      { photoPaths: ["/objects/uploads/stub-rep-id"] },
    );
    expect(res.status).toBe(401);
  });
});
