import type { Server } from "http";
import type { AddressInfo } from "net";

import { activitiesTable, db } from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Stub the GCS-backed storage layer so the HTTP flow can be exercised
// end-to-end without real bucket objects. The stub reports every referenced
// object as a small JPEG, so the post-upload validation in
// POST /public/assessments passes and the flow reaches activity creation.
vi.mock("../../lib/objectStorage", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/objectStorage")>();
  class StubObjectStorageService {
    async getObjectEntityFile(_path: string) {
      return {
        getMetadata: async () => [
          { contentType: "image/jpeg", size: 123_456 },
        ],
      };
    }
    async getObjectEntityUploadURL() {
      return "https://storage.example.com/bucket/.private/uploads/stub-id";
    }
    normalizeObjectEntityPath(_url: string) {
      return "/objects/uploads/stub-id";
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

beforeAll(async () => {
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
});

async function postJson(path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const baseSubmission = {
  firstName: "PhotoFlow",
  phone: "5550002222",
  addressLine1: "2 Flow St",
  city: "Canton",
  state: "GA",
  postalCode: "30114",
  intent: "storm" as const,
  consent: { smsGranted: true, emailGranted: true, disclosureVersion: "t" },
};

describe("POST /v1/public/uploads/request-url validation", () => {
  it("rejects non-image content types", async () => {
    const res = await postJson("/api/v1/public/uploads/request-url", {
      name: "malware.pdf",
      size: 1000,
      contentType: "application/pdf",
    });
    expect(res.status).toBe(400);
  });

  it("rejects oversized uploads (>10MB)", async () => {
    const res = await postJson("/api/v1/public/uploads/request-url", {
      name: "huge.jpg",
      size: 10 * 1024 * 1024 + 1,
      contentType: "image/jpeg",
    });
    expect(res.status).toBe(400);
  });

  it("returns an upload URL and object path for a valid image", async () => {
    const res = await postJson("/api/v1/public/uploads/request-url", {
      name: "roof.jpg",
      size: 5_000_000,
      contentType: "image/jpeg",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      uploadURL: string;
      objectPath: string;
    };
    expect(body.uploadURL).toContain("https://");
    expect(body.objectPath).toMatch(/^\/objects\//);
  });
});

describe("POST /v1/public/assessments with photoPaths", () => {
  it("creates a photos_attached activity carrying the same paths", async () => {
    const photoPath = `/objects/uploads/http-flow-${Date.now()}`;
    const res = await postJson("/api/v1/public/assessments", {
      ...baseSubmission,
      photoPaths: [photoPath],
    });
    expect(res.status).toBe(201);
    const { leadId } = (await res.json()) as { leadId: string };
    expect(leadId).toBeTruthy();

    const activities = await db
      .select()
      .from(activitiesTable)
      .where(eq(activitiesTable.leadId, leadId));
    const photoActivity = activities.find((a) => a.type === "photos_attached");
    expect(photoActivity).toBeDefined();
    expect(
      (photoActivity!.metadata as { photoPaths: string[] }).photoPaths,
    ).toEqual([photoPath]);
  });

  it("rejects a submission whose photoPaths fail schema validation", async () => {
    const res = await postJson("/api/v1/public/assessments", {
      ...baseSubmission,
      photoPaths: "not-an-array",
    });
    expect(res.status).toBe(400);
  });
});
