import type { Server } from "http";
import type { AddressInfo } from "net";

import {
  activitiesTable,
  db,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { deleteTestOrgs } from "../../test-helpers/delete-test-orgs";

// Fake image bytes the stubbed storage layer streams back. Using a
// recognizable payload lets the test assert the exact bytes arrive intact.
const PHOTO_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);

const LINKED_PATH = "/objects/uploads/linked-photo";
const BROKEN_PATH = "/objects/uploads/broken-photo";

// Stub the GCS-backed storage layer so the serving route's happy path can be
// exercised without real bucket objects. getObjectEntityFile only recognizes
// the linked path; downloadObject returns a web Response whose body/headers
// the route must faithfully stream to the HTTP client.
vi.mock("../../lib/objectStorage", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/objectStorage")>();
  class StubObjectStorageService {
    async getObjectEntityFile(objectPath: string) {
      if (objectPath !== LINKED_PATH && objectPath !== BROKEN_PATH) {
        throw new actual.ObjectNotFoundError();
      }
      return { name: objectPath === BROKEN_PATH ? "broken-file" : "stub-file" };
    }
    async downloadObject(file: { name: string }) {
      if (file.name === "broken-file") {
        // Emit a first chunk, then error mid-body — simulating a bucket
        // read that dies after headers/partial data were already sent.
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(PHOTO_BYTES.slice(0, 4));
            setTimeout(
              () => controller.error(new Error("bucket read failed")),
              10,
            );
          },
        });
        return new Response(body, {
          headers: {
            "Content-Type": "image/jpeg",
            "Content-Length": String(PHOTO_BYTES.length),
          },
        });
      }
      return new Response(PHOTO_BYTES, {
        headers: {
          "Content-Type": "image/jpeg",
          "Content-Length": String(PHOTO_BYTES.length),
          "Cache-Control": "private, max-age=3600",
        },
      });
    }
  }
  return { ...actual, ObjectStorageService: StubObjectStorageService };
});

// Import after the mock so the storage route picks up the stubbed service.
const { default: app } = await import("../../app");
const { createSession } = await import("../../lib/auth");

let server: Server;
let baseUrl: string;
let sid: string;
let orgId: string;

beforeAll(async () => {
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Photo Serving Test Org",
      slug: `photo-serving-${Date.now()}`,
    })
    .returning();
  orgId = org.id;
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `photo-serving-${Date.now()}@example.com`,
      organizationId: org.id,
      role: "admin",
    })
    .returning();
  sid = await createSession({
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

  // Link the photo to the org via a photos_attached activity, the same way
  // the public assessment flow records attached damage photos.
  await db.insert(activitiesTable).values({
    organizationId: org.id,
    type: "photos_attached",
    title: "Homeowner attached 1 damage photo",
    metadata: { photoPaths: [LINKED_PATH, BROKEN_PATH] },
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await deleteTestOrgs(orgId);
});

function get(path: string) {
  return fetch(`${baseUrl}/api/v1/storage${path}`, {
    headers: { authorization: `Bearer ${sid}` },
  });
}

describe("GET /v1/storage/objects/* serving", () => {
  it("streams the object bytes with content headers for a linked photo", async () => {
    const res = await get("/objects/uploads/linked-photo");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("content-length")).toBe(
      String(PHOTO_BYTES.length),
    );
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(PHOTO_BYTES);
  });

  it("terminates the request promptly when the storage stream errors mid-body", async () => {
    // If the route lacks a stream error handler, this fetch hangs waiting
    // for the rest of Content-Length bytes; the 5s timeout guards that.
    const res = await get("/objects/uploads/broken-photo");
    expect(res.status).toBe(200); // headers already sent before the error
    await expect(res.arrayBuffer()).rejects.toThrow();
  }, 5000);

  it("returns 404 for an upload never linked to a lead", async () => {
    const res = await get("/objects/uploads/never-linked");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "Object not found" });
  });
});
