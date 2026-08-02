import {
  ObjectNotFoundError,
  type ObjectStorageService,
} from "./objectStorage";

export const ALLOWED_PHOTO_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/**
 * Presigned PUT URLs cannot bind content-type/size, so enforce the upload
 * contract after the fact: verify each referenced object actually is an
 * image within the size limit before it is linked to a lead.
 */
export async function validatePhotoObjects(
  objectStorageService: ObjectStorageService,
  photoPaths: string[],
): Promise<{ ok: true } | { ok: false; reason: string }> {
  for (const path of photoPaths) {
    try {
      const file = await objectStorageService.getObjectEntityFile(path);
      const [metadata] = await file.getMetadata();
      const contentType = String(metadata.contentType ?? "");
      const size = Number(metadata.size ?? 0);
      if (!ALLOWED_PHOTO_TYPES.has(contentType)) {
        return { ok: false, reason: `Attachment is not an accepted image type` };
      }
      if (size <= 0 || size > MAX_PHOTO_BYTES) {
        return { ok: false, reason: `Attachment exceeds the 10MB limit` };
      }
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        return { ok: false, reason: "Attachment not found" };
      }
      throw error;
    }
  }
  return { ok: true };
}
