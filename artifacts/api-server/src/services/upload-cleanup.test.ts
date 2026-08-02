import { activitiesTable, db, organizationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

import {
  cleanupOrphanedUploads,
  isUploadReferenced,
  type UploadObject,
} from "./upload-cleanup";

let org: { id: string };

beforeAll(async () => {
  const slug = `upload-clean-${Date.now()}`;
  await db.delete(organizationsTable).where(eq(organizationsTable.slug, slug));
  const [row] = await db
    .insert(organizationsTable)
    .values({ name: "Upload Cleanup Test Org", slug })
    .returning();
  org = row;
});

afterAll(async () => {
  await deleteTestOrgs(org.id);
});

function makeObject(
  objectPath: string,
  ageMs: number,
  now: Date,
): UploadObject & { deleted: boolean } {
  const obj = {
    objectPath,
    createdAt: new Date(now.getTime() - ageMs),
    deleted: false,
    remove: async () => {
      obj.deleted = true;
    },
  };
  return obj;
}

const DAY = 24 * 60 * 60 * 1000;

describe("cleanupOrphanedUploads", () => {
  it("deletes old unreferenced uploads, keeps fresh and referenced ones", async () => {
    const now = new Date();
    const referencedPath = `/objects/uploads/ref-${Date.now()}`;

    await db.insert(activitiesTable).values({
      organizationId: org.id,
      type: "photos_attached",
      title: "test photos",
      metadata: { photoPaths: [referencedPath] },
    });

    const orphanOld = makeObject(`/objects/uploads/orphan-old`, 2 * DAY, now);
    const orphanFresh = makeObject(`/objects/uploads/orphan-fresh`, DAY / 2, now);
    const referencedOld = makeObject(referencedPath, 3 * DAY, now);

    const result = await cleanupOrphanedUploads({
      now,
      listObjects: async () => [orphanOld, orphanFresh, referencedOld],
    });

    expect(result).toEqual({ scanned: 3, deleted: 1, kept: 2, errors: 0 });
    expect(orphanOld.deleted).toBe(true);
    expect(orphanFresh.deleted).toBe(false);
    expect(referencedOld.deleted).toBe(false);
  });

  it("counts delete failures as errors without aborting the run", async () => {
    const now = new Date();
    const failing = makeObject(`/objects/uploads/failing`, 2 * DAY, now);
    failing.remove = async () => {
      throw new Error("boom");
    };
    const ok = makeObject(`/objects/uploads/ok-orphan`, 2 * DAY, now);

    const result = await cleanupOrphanedUploads({
      now,
      listObjects: async () => [failing, ok],
    });

    expect(result.errors).toBe(1);
    expect(result.deleted).toBe(1);
    expect(ok.deleted).toBe(true);
  });
});

describe("isUploadReferenced", () => {
  it("finds paths referenced across any organization", async () => {
    const path = `/objects/uploads/xorg-${Date.now()}`;
    await db.insert(activitiesTable).values({
      organizationId: org.id,
      type: "photos_attached",
      title: "test",
      metadata: { photoPaths: [path] },
    });
    expect(await isUploadReferenced(path)).toBe(true);
    expect(await isUploadReferenced(`${path}-missing`)).toBe(false);
  });
});
