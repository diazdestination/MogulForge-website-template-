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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

/**
 * Tests that the pipeline photo-count badge and the storage-serving gate stay
 * accurate after a lead merge.
 *
 * Setup: two leads in the same org.
 *   - survivorLead: has 2 rep-uploaded photos (photos_attached activity)
 *   - sourceLead:   has 3 homeowner photos  (photos_attached activity)
 *
 * After POST /v1/leads/:id/merge:
 *   - GET /v1/leads should show photoCount === 5 on the survivor.
 *   - GET /v1/storage/objects/* should return 200 for every one of the 5
 *     paths (the photos_attached activities now all belong to the survivor,
 *     so isLeadPhotoInOrganization sees them all).
 */

// Paths embedded in the test activities — chosen to be unique per stamp so
// parallel test runs never collide.
const stamp = Date.now();
const REP_PATHS = [
  `/objects/uploads/merge-rep-${stamp}-a`,
  `/objects/uploads/merge-rep-${stamp}-b`,
];
const HO_PATHS = [
  `/objects/uploads/merge-ho-${stamp}-x`,
  `/objects/uploads/merge-ho-${stamp}-y`,
  `/objects/uploads/merge-ho-${stamp}-z`,
];
const ALL_PATHS = [...REP_PATHS, ...HO_PATHS];

// Stub the GCS-backed storage layer so the serving route can exercise the
// full auth/tenant-check path without real bucket objects.
vi.mock("../../lib/objectStorage", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/objectStorage")>();
  class StubObjectStorageService {
    async getObjectEntityFile(objectPath: string) {
      return { name: objectPath };
    }
    async downloadObject(_file: { name: string }) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
        headers: {
          "Content-Type": "image/jpeg",
          "Content-Length": "3",
        },
      });
    }
    async getObjectEntityUploadURL() {
      return "https://storage.example.com/stub-upload-url";
    }
    normalizeObjectEntityPath(url: string) {
      return url;
    }
  }
  return { ...actual, ObjectStorageService: StubObjectStorageService };
});

// Import after the vi.mock so every module picks up the stub.
const { default: app } = await import("../../app");
const { createSession } = await import("../../lib/auth");

let server: Server;
let baseUrl: string;
let orgId: string;
let adminSid: string;
let survivorLeadId: string;
let sourceLeadId: string;

beforeAll(async () => {
  // Org + admin user
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: `MergePhotoCount-${stamp}`,
      slug: `merge-photo-count-${stamp}`,
    })
    .returning();
  orgId = org.id;

  const [admin] = await db
    .insert(usersTable)
    .values({
      email: `merge-photo-count-admin-${stamp}@test.dev`,
      organizationId: orgId,
      role: "admin",
    })
    .returning();
  adminSid = await createSession({
    user: {
      id: admin.id,
      email: null,
      firstName: null,
      lastName: null,
      profileImageUrl: null,
    },
    access_token: "test",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });

  // Two leads
  const [cSurvivor] = await db
    .insert(contactsTable)
    .values({ organizationId: orgId, firstName: "MergeSurvivor", phone: "5550010001" })
    .returning();
  const [survivor] = await db
    .insert(leadsTable)
    .values({ organizationId: orgId, contactId: cSurvivor.id })
    .returning();
  survivorLeadId = survivor.id;

  const [cSource] = await db
    .insert(contactsTable)
    .values({ organizationId: orgId, firstName: "MergeSource", phone: "5550010002" })
    .returning();
  const [source] = await db
    .insert(leadsTable)
    .values({ organizationId: orgId, contactId: cSource.id })
    .returning();
  sourceLeadId = source.id;

  // Attach photos: 2 rep-uploaded paths on the survivor, 3 homeowner paths on
  // the source. Using the same activity format as the real routes so the
  // photoCount subquery and the storage access check both recognise them.
  await db.insert(activitiesTable).values({
    organizationId: orgId,
    leadId: survivorLeadId,
    type: "photos_attached",
    title: "Rep attached 2 photos",
    metadata: { photoPaths: REP_PATHS },
  });
  await db.insert(activitiesTable).values({
    organizationId: orgId,
    leadId: sourceLeadId,
    type: "photos_attached",
    title: "Homeowner attached 3 damage photos",
    metadata: { photoPaths: HO_PATHS },
  });

  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteTestOrgs(orgId);
});

function auth(sid: string) {
  return { authorization: `Bearer ${sid}` };
}

async function mergeLead(survivorId: string, srcId: string, sid: string) {
  return fetch(`${baseUrl}/v1/leads/${encodeURIComponent(survivorId)}/merge`, {
    method: "POST",
    headers: { ...auth(sid), "content-type": "application/json" },
    body: JSON.stringify({ sourceLeadId: srcId }),
  });
}

// ── Merge + photoCount ────────────────────────────────────────────────────────

describe("photo count after lead merge", () => {
  it("survivor photoCount equals the sum from both leads after merging", async () => {
    const mergeRes = await mergeLead(survivorLeadId, sourceLeadId, adminSid);
    expect(mergeRes.status).toBe(200);
    const merged = (await mergeRes.json()) as { id: string };
    expect(merged.id).toBe(survivorLeadId);

    // GET /v1/leads and find the survivor row
    const leadsRes = await fetch(`${baseUrl}/v1/leads`, {
      headers: auth(adminSid),
    });
    expect(leadsRes.status).toBe(200);
    const leads = (await leadsRes.json()) as Array<{
      id: string;
      photoCount: number;
    }>;
    const survivorRow = leads.find((l) => l.id === survivorLeadId);
    expect(survivorRow).toBeDefined();
    // 2 rep photos + 3 homeowner photos = 5
    expect(survivorRow!.photoCount).toBe(5);
  });
});

// ── Storage accessibility after merge ────────────────────────────────────────

describe("photo paths accessible via GET /v1/storage/objects/* after merge", () => {
  // The merge is already done in the previous describe block (both share the
  // same beforeAll). Iterate all five paths and confirm the serving route
  // returns 200 — showing that the migrated activities are properly visible
  // under the survivor's org.
  for (const photoPath of ALL_PATHS) {
    it(`returns 200 for ${photoPath}`, async () => {
      // Strip the leading /objects prefix — the route is mounted at
      // /v1/storage/objects/* and prepends /objects/ itself.
      const routePath = photoPath.replace(/^\/objects\//, "");
      const res = await fetch(`${baseUrl}/v1/storage/objects/${routePath}`, {
        headers: auth(adminSid),
      });
      expect(res.status).toBe(200);
    });
  }
});
