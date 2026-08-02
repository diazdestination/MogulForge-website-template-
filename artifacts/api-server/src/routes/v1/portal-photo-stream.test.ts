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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Mid-stream failure test for GET /v1/portal/photos/objects/* — mirrors the
 * "terminates the request promptly" test in storage-serving.test.ts. The
 * storage layer is stubbed with a stream that errors after emitting a first
 * chunk; the route must destroy the response so the homeowner's download
 * fails fast instead of hanging.
 */

const PHOTO_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);

const BROKEN_PATH = "/objects/uploads/portal-broken-photo";

vi.mock("../../lib/objectStorage", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/objectStorage")>();
  class StubObjectStorageService {
    async getObjectEntityFile(objectPath: string) {
      if (objectPath !== BROKEN_PATH) {
        throw new actual.ObjectNotFoundError();
      }
      return { name: "broken-file" };
    }
    async downloadObject(_file: { name: string }) {
      // Emit a first chunk, then error mid-body — simulating a bucket read
      // that dies after headers/partial data were already sent.
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
  }
  return { ...actual, ObjectStorageService: StubObjectStorageService };
});

// Import after the mock so the portal route picks up the stubbed service.
const { default: app } = await import("../../app");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

let server: Server;
let baseUrl: string;
let token: string;

const EMAIL = `portal-photo-stream-${Date.now()}@example.com`;

beforeAll(async () => {
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Portal Photo Stream Org",
      slug: `portal-photo-stream-${Date.now()}`,
    })
    .returning();
  const [contact] = await db
    .insert(contactsTable)
    .values({ organizationId: org.id, firstName: "Pat", email: EMAIL })
    .returning();
  const [lead] = await db
    .insert(leadsTable)
    .values({ organizationId: org.id, contactId: contact.id })
    .returning();
  await db.insert(activitiesTable).values({
    organizationId: org.id,
    leadId: lead.id,
    contactId: contact.id,
    type: "photos_attached",
    title: "Photos attached",
    metadata: { photoPaths: [BROKEN_PATH] },
  });

  token = `portal-photo-stream-token-${Date.now()}`;
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
});

describe("GET /v1/portal/photos/objects/* mid-stream failure", () => {
  it("terminates the request promptly when the storage stream errors mid-body", async () => {
    // If the route lacks a stream error handler, this fetch hangs waiting
    // for the rest of Content-Length bytes; the 5s timeout guards that.
    const res = await fetch(`${baseUrl}/v1/portal/photos${BROKEN_PATH}`, {
      headers: { "x-portal-token": token },
    });
    expect(res.status).toBe(200); // headers already sent before the error
    await expect(res.arrayBuffer()).rejects.toThrow();
  }, 5000);
});
