import { Readable } from "stream";
import { Router, type IRouter, type Request, type Response } from "express";

import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../../lib/objectStorage";
import { requireMember } from "../../middlewares/requireMember";
import { isLeadPhotoInOrganization } from "../../services/assessment";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

/**
 * GET /v1/storage/objects/*
 *
 * Serves homeowner damage photos to active CRM members with crm.read.
 * Objects are only streamed when they are linked to a lead in the member's
 * organization (via a photos_attached activity), so uploads that were never
 * attached — or that belong to another tenant — are not retrievable.
 */
router.get(
  "/storage/objects/*path",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const raw = req.params.path as string | string[];
      const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
      const objectPath = `/objects/${wildcardPath}`;

      const linked = await isLeadPhotoInOrganization(
        req.member!.organizationId,
        objectPath,
      );
      if (!linked) {
        res.status(404).json({ error: "Object not found" });
        return;
      }

      const objectFile =
        await objectStorageService.getObjectEntityFile(objectPath);

      const response = await objectStorageService.downloadObject(objectFile);

      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));

      if (response.body) {
        const nodeStream = Readable.fromWeb(
          response.body as import("stream/web").ReadableStream<Uint8Array>,
        );
        nodeStream.on("error", (streamError) => {
          req.log.error(
            { err: streamError },
            "Object stream errored mid-response",
          );
          // Headers are already sent, so we cannot signal an HTTP error
          // status. Destroy the connection so the client sees a broken
          // transfer immediately instead of hanging.
          res.destroy(streamError);
        });
        nodeStream.pipe(res);
      } else {
        res.end();
      }
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "Object not found" });
        return;
      }
      req.log.error({ err: error }, "Error serving object");
      res.status(500).json({ error: "Failed to serve object" });
    }
  },
);

export default router;
