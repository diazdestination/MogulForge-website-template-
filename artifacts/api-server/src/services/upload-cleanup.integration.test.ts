/**
 * Integration check for listUploadObjects() against the REAL bucket.
 *
 * The unit tests inject fake object lists, so a regression in how
 * PRIVATE_OBJECT_DIR is parsed into bucket + prefix (or how bucket files are
 * mapped back to /objects/... paths) would go unnoticed. This test uploads a
 * temp object under the private uploads/ prefix, verifies it shows up with
 * the expected /objects/uploads/<id> path and a fresh createdAt, runs the
 * real cleanup (real bucket listing) and asserts the fresh upload survives,
 * then deletes the temp object.
 */
import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { objectStorageClient } from "../lib/objectStorage";
import { cleanupOrphanedUploads, listUploadObjects } from "./upload-cleanup";

const privateDir = process.env.PRIVATE_OBJECT_DIR ?? "";

function parsePrivateDir(dir: string): { bucketName: string; basePrefix: string } {
  const trimmed = dir.replace(/\/$/, "").replace(/^\//, "");
  const parts = trimmed.split("/");
  return { bucketName: parts[0], basePrefix: parts.slice(1).join("/") };
}

const describeIf = privateDir ? describe : describe.skip;

describeIf("listUploadObjects (real bucket)", () => {
  const objectId = `smoke-upload-cleanup-${randomUUID()}`;
  const { bucketName, basePrefix } = parsePrivateDir(privateDir);
  const objectName = basePrefix
    ? `${basePrefix}/uploads/${objectId}`
    : `uploads/${objectId}`;
  const file = () => objectStorageClient.bucket(bucketName).file(objectName);

  afterAll(async () => {
    await file().delete({ ignoreNotFound: true });
  });

  it("lists a freshly uploaded object with the expected /objects path, and cleanup leaves it untouched", async () => {
    await file().save(Buffer.from("upload-cleanup integration probe"), {
      contentType: "text/plain",
      resumable: false,
    });

    const expectedPath = `/objects/uploads/${objectId}`;

    // 1. The real listing must include our object with the mapped path.
    const objects = await listUploadObjects();
    const mine = objects.find((o) => o.objectPath === expectedPath);
    expect(
      mine,
      `listUploadObjects() did not return ${expectedPath}; prefix parsing of PRIVATE_OBJECT_DIR may have regressed`,
    ).toBeDefined();

    // createdAt must be recent (mis-parsed metadata would break the grace period).
    const ageMs = Date.now() - mine!.createdAt.getTime();
    expect(ageMs).toBeGreaterThanOrEqual(0);
    expect(ageMs).toBeLessThan(10 * 60 * 1000);

    // 2. A real cleanup run (real bucket listing, default grace period) must
    //    keep the fresh upload.
    const result = await cleanupOrphanedUploads();
    expect(result.scanned).toBeGreaterThanOrEqual(1);

    const [stillExists] = await file().exists();
    expect(
      stillExists,
      "cleanup deleted a freshly uploaded object — grace period is broken",
    ).toBe(true);

    // 3. The remove() handle returned by the listing must delete the right object.
    await mine!.remove();
    const [existsAfterRemove] = await file().exists();
    expect(existsAfterRemove).toBe(false);
  }, 60_000);
});
