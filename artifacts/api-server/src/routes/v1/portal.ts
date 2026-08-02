import {
  AddPortalClaimPhotosBody,
  RequestPortalLoginCodeBody,
  SendPortalMessageBody,
  VerifyPortalLoginCodeBody,
} from "@workspace/api-zod";
import { Router, type IRouter, type Request, type Response } from "express";

import { Readable } from "node:stream";

import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../../lib/objectStorage";
import { rateLimit } from "../../lib/rateLimit";
import { getDefaultOrganization } from "../../services/org";
import { validatePhotoObjects } from "../../lib/photoValidation";
import {
  addPortalClaimPhotos,
  getPortalConversation,
  getPortalOverview,
  getPortalSession,
  isPortalPhotoForSession,
  postPortalMessage,
  requestLoginCode,
  revokePortalSession,
  verifyLoginCode,
} from "../../services/portal";

const router: IRouter = Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function portalToken(req: Request): string {
  return String(req.headers["x-portal-token"] ?? "");
}

router.post(
  "/portal/login/request",
  rateLimit({ windowMs: 60_000, max: 5, key: "portal-login-request" }),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = RequestPortalLoginCodeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    const org = await getDefaultOrganization();
    const result = await requestLoginCode({
      organizationId: org.id,
      rawIdentifier: parsed.data.identifier,
    });
    if (!result.ok) {
      res.status(400).json({
        error: "Enter the email address or phone number from your assessment",
      });
      return;
    }
    // Generic response — never reveals whether the identifier exists.
    res.status(202).json({ sent: true, channel: result.channel });
  },
);

router.post(
  "/portal/login/verify",
  rateLimit({ windowMs: 60_000, max: 10, key: "portal-login-verify" }),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = VerifyPortalLoginCodeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    const org = await getDefaultOrganization();
    const session = await verifyLoginCode({
      organizationId: org.id,
      rawIdentifier: parsed.data.identifier,
      code: parsed.data.code,
    });
    if (!session) {
      res.status(401).json({ error: "That code is incorrect or has expired" });
      return;
    }
    res.json({
      token: session.token,
      expiresAt: session.expiresAt.toISOString(),
    });
  },
);

router.get(
  "/portal/overview",
  rateLimit({ windowMs: 60_000, max: 60, key: "portal-overview" }),
  async (req: Request, res: Response): Promise<void> => {
    const session = await getPortalSession(portalToken(req));
    if (!session) {
      res.status(401).json({ error: "Please sign in again" });
      return;
    }
    res.json(await getPortalOverview(session));
  },
);

router.post(
  "/portal/claims/:id/messages",
  rateLimit({ windowMs: 60_000, max: 15, key: "portal-message" }),
  async (req: Request, res: Response): Promise<void> => {
    const session = await getPortalSession(portalToken(req));
    if (!session) {
      res.status(401).json({ error: "Please sign in again" });
      return;
    }
    const leadId = String(req.params.id);
    if (!UUID_RE.test(leadId)) {
      res.status(404).json({ error: "Claim not found" });
      return;
    }
    const parsed = SendPortalMessageBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid message" });
      return;
    }
    const ok = await postPortalMessage({
      session,
      leadId,
      content: parsed.data.content,
    });
    if (!ok) {
      res.status(404).json({ error: "Claim not found" });
      return;
    }
    res.status(201).json({ sent: true });
  },
);

/**
 * GET /v1/portal/claims/:id/conversation
 *
 * Full message history (homeowner + team) for one of the session's own
 * claims, oldest to newest — the overview's updates list is capped, this
 * is not, so long-running claims stay readable end to end.
 */
router.get(
  "/portal/claims/:id/conversation",
  rateLimit({ windowMs: 60_000, max: 60, key: "portal-conversation" }),
  async (req: Request, res: Response): Promise<void> => {
    const session = await getPortalSession(portalToken(req));
    if (!session) {
      res.status(401).json({ error: "Please sign in again" });
      return;
    }
    const leadId = String(req.params.id);
    if (!UUID_RE.test(leadId)) {
      res.status(404).json({ error: "Claim not found" });
      return;
    }
    const messages = await getPortalConversation(session, leadId);
    if (messages === null) {
      res.status(404).json({ error: "Claim not found" });
      return;
    }
    res.json({ messages });
  },
);

const objectStorageService = new ObjectStorageService();

/**
 * POST /v1/portal/claims/:id/photos
 *
 * Lets an OTP-verified homeowner attach additional damage photos (uploaded
 * via the public presigned-upload flow) to their own claim. Each referenced
 * object is verified to be a real image within the size limit before it is
 * linked, mirroring the public assessment flow.
 */
router.post(
  "/portal/claims/:id/photos",
  rateLimit({ windowMs: 60_000, max: 15, key: "portal-add-photos" }),
  async (req: Request, res: Response): Promise<void> => {
    const session = await getPortalSession(portalToken(req));
    if (!session) {
      res.status(401).json({ error: "Please sign in again" });
      return;
    }
    const leadId = String(req.params.id);
    if (!UUID_RE.test(leadId)) {
      res.status(404).json({ error: "Claim not found" });
      return;
    }
    const parsed = AddPortalClaimPhotosBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid photo attachments" });
      return;
    }
    const validation = await validatePhotoObjects(
      objectStorageService,
      parsed.data.photoPaths,
    );
    if (!validation.ok) {
      res.status(400).json({ error: validation.reason });
      return;
    }
    const attached = await addPortalClaimPhotos({
      session,
      leadId,
      photoPaths: parsed.data.photoPaths,
    });
    if (attached === null) {
      res.status(404).json({ error: "Claim not found" });
      return;
    }
    if (attached === "limit_exceeded") {
      res.status(400).json({
        error:
          "This claim already has the maximum number of photos. If you need to share more, send us a message and our team will help.",
      });
      return;
    }
    res.status(201).json({ attached });
  },
);

/**
 * GET /v1/portal/photos/objects/*
 *
 * Streams a homeowner's own damage photo. Only served when the object path
 * is attached (via a photos_attached activity) to a lead owned by the
 * OTP-verified portal session's contact — never another customer's photos.
 */
router.get(
  "/portal/photos/objects/*path",
  rateLimit({ windowMs: 60_000, max: 120, key: "portal-photo" }),
  async (req: Request, res: Response): Promise<void> => {
    const session = await getPortalSession(portalToken(req));
    if (!session) {
      res.status(401).json({ error: "Please sign in again" });
      return;
    }
    try {
      const raw = req.params.path as string | string[];
      const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
      const objectPath = `/objects/${wildcardPath}`;

      const owned = await isPortalPhotoForSession(session, objectPath);
      if (!owned) {
        res.status(404).json({ error: "Photo not found" });
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
            "portal: photo stream errored mid-response",
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
        res.status(404).json({ error: "Photo not found" });
        return;
      }
      req.log.error({ err: error }, "portal: error serving photo");
      res.status(500).json({ error: "Failed to serve photo" });
    }
  },
);

router.post(
  "/portal/logout",
  async (req: Request, res: Response): Promise<void> => {
    const token = portalToken(req);
    if (token) await revokePortalSession(token);
    res.json({ ok: true });
  },
);

export default router;
