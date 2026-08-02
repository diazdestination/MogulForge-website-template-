import { RequestPublicUploadUrlBody } from "@workspace/api-zod";
import { activitiesTable, db, organizationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

import {
  captureAssessment,
  isLeadPhotoInOrganization,
  scoreSubmission,
} from "./assessment";

let orgA: { id: string };
let orgB: { id: string };

async function makeOrg(slug: string) {
  await db.delete(organizationsTable).where(eq(organizationsTable.slug, slug));
  const [org] = await db
    .insert(organizationsTable)
    .values({ name: `Test Org ${slug}`, slug })
    .returning();
  return org;
}

const baseSubmission = {
  firstName: "Photo",
  phone: "5550001111",
  addressLine1: "1 Test St",
  city: "Canton",
  state: "GA",
  postalCode: "30114",
  intent: "storm" as const,
  consent: { smsGranted: true, emailGranted: true, disclosureVersion: "t" },
};

beforeAll(async () => {
  orgA = await makeOrg(`photo-a-${Date.now()}`);
  orgB = await makeOrg(`photo-b-${Date.now()}`);
});

afterAll(async () => {
  await deleteTestOrgs(orgA.id, orgB.id);
});

describe("public upload request validation", () => {
  it("rejects non-image content types", () => {
    const parsed = RequestPublicUploadUrlBody.safeParse({
      name: "malware.pdf",
      size: 1000,
      contentType: "application/pdf",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects oversized uploads (>10MB)", () => {
    const parsed = RequestPublicUploadUrlBody.safeParse({
      name: "huge.jpg",
      size: 10 * 1024 * 1024 + 1,
      contentType: "image/jpeg",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a valid image request", () => {
    const parsed = RequestPublicUploadUrlBody.safeParse({
      name: "roof.jpg",
      size: 5_000_000,
      contentType: "image/jpeg",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("photo attachment on assessment", () => {
  it("boosts the lead score when photos are attached", () => {
    const withPhotos = scoreSubmission({
      ...baseSubmission,
      photoPaths: ["/objects/uploads/abc"],
    });
    const without = scoreSubmission(baseSubmission);
    expect(withPhotos.score).toBeGreaterThan(without.score);
    expect(withPhotos.scoreReasons.join(" ")).toContain("photo");
  });

  it("creates a photos_attached activity linked to the lead", async () => {
    const photoPath = `/objects/uploads/test-${Date.now()}`;
    const result = await captureAssessment({
      organizationId: orgA.id,
      submission: { ...baseSubmission, photoPaths: [photoPath] },
    });

    const activities = await db
      .select()
      .from(activitiesTable)
      .where(eq(activitiesTable.leadId, result.leadId));
    const photoActivity = activities.find((a) => a.type === "photos_attached");
    expect(photoActivity).toBeDefined();
    expect(photoActivity!.organizationId).toBe(orgA.id);
    expect(
      (photoActivity!.metadata as { photoPaths: string[] }).photoPaths,
    ).toEqual([photoPath]);
  });

  it("ignores photo paths outside the /objects/ prefix", async () => {
    const result = await captureAssessment({
      organizationId: orgA.id,
      submission: {
        ...baseSubmission,
        photoPaths: ["../../etc/passwd" as string],
      },
    });
    const activities = await db
      .select()
      .from(activitiesTable)
      .where(eq(activitiesTable.leadId, result.leadId));
    expect(activities.find((a) => a.type === "photos_attached")).toBeUndefined();
  });
});

describe("tenant scoping for photo serving", () => {
  it("only resolves photos for the organization they belong to", async () => {
    const photoPath = `/objects/uploads/tenant-${Date.now()}`;
    await captureAssessment({
      organizationId: orgA.id,
      submission: { ...baseSubmission, photoPaths: [photoPath] },
    });

    expect(await isLeadPhotoInOrganization(orgA.id, photoPath)).toBe(true);
    expect(await isLeadPhotoInOrganization(orgB.id, photoPath)).toBe(false);
    expect(
      await isLeadPhotoInOrganization(orgA.id, "/objects/uploads/nonexistent"),
    ).toBe(false);
  });
});
