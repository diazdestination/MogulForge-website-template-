import {
  CheckStormActivityBody,
  RequestPublicUploadUrlBody,
  RequestPublicUploadUrlResponse,
  SendConciergeMessageBody,
  StartConciergeConversationBody,
  SubmitAssessmentBody,
  TrackAnalyticsEventBody,
  TranscribeConciergeAudioBody,
} from "@workspace/api-zod";
import { analyticsEventsTable, db } from "@workspace/db";
import { Router, type IRouter, type Request, type Response } from "express";
import { CLIENT } from "../../lib/client.config";

import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../../lib/objectStorage";
import { validatePhotoObjects } from "../../lib/photoValidation";
import { rateLimit } from "../../lib/rateLimit";
import { captureAssessment } from "../../services/assessment";
import { emitAutomationEvent } from "../../services/automation";
import { handleMessage, startConversation } from "../../services/concierge";
import { renderAreaShareCard } from "../../services/ogCard";
import { getDefaultOrganization } from "../../services/org";
import { getOrgSettings } from "../../services/settings";
import { providers, transcribeAudio } from "../../services/providers";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clientIp(req: Request): string | undefined {
  return (
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    undefined
  );
}

router.post(
  "/public/assessments",
  rateLimit({ windowMs: 60_000, max: 5, key: "assessments" }),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = SubmitAssessmentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid assessment submission" });
      return;
    }
    if (parsed.data.photoPaths?.length) {
      const validation = await validatePhotoObjects(
        objectStorageService,
        parsed.data.photoPaths,
      );
      if (!validation.ok) {
        res.status(400).json({ error: validation.reason });
        return;
      }
    }
    const org = await getDefaultOrganization();
    const result = await captureAssessment({
      organizationId: org.id,
      submission: parsed.data,
      sourceIp: clientIp(req),
      userAgent: req.headers["user-agent"],
    });
    emitAutomationEvent(org.id, "lead.created", {
      leadId: result.leadId,
      fields: {
        "lead.status": "new",
        "lead.urgency": result.urgency,
        "lead.source": parsed.data.source ?? "public-site",
      },
    });
    res.status(201).json(result);
  },
);

router.post(
  "/public/uploads/request-url",
  rateLimit({ windowMs: 60_000, max: 20, key: "public-uploads" }),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = RequestPublicUploadUrlBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Missing or invalid required fields" });
      return;
    }
    try {
      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      const objectPath =
        objectStorageService.normalizeObjectEntityPath(uploadURL);
      res.json(RequestPublicUploadUrlResponse.parse({ uploadURL, objectPath }));
    } catch (error) {
      req.log.error({ err: error }, "Error generating public upload URL");
      res.status(500).json({ error: "Failed to generate upload URL" });
    }
  },
);

router.post(
  "/public/storm-check",
  rateLimit({ windowMs: 60_000, max: 10, key: "storm-check" }),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = CheckStormActivityBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid storm check request" });
      return;
    }
    const result = await providers.weather.stormEventsNear(parsed.data.address);
    res.json({
      address: parsed.data.address,
      events: result.events,
      isDemoData: result.isDemoData,
      suggestedNextAction: result.events.some((e) => e.severity !== "minor")
        ? "schedule_inspection"
        : "monitor",
    });
  },
);

router.post(
  "/public/concierge/conversations",
  rateLimit({ windowMs: 60_000, max: 10, key: "concierge-start" }),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = StartConciergeConversationBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid conversation request" });
      return;
    }
    const org = await getDefaultOrganization();
    const result = await startConversation({
      organizationId: org.id,
      source: parsed.data.source,
      intentHint: parsed.data.intent,
    });
    res.status(201).json(result);
  },
);

// ~4 minutes of compressed speech; the mobile hands-free mode records at
// most ~20 seconds, so this cap is generous while still bounding abuse.
const MAX_TRANSCRIPTION_AUDIO_BYTES = 5 * 1024 * 1024;
const ALLOWED_AUDIO_TYPES = new Set([
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/aac",
  "audio/mpeg",
  "audio/wav",
  "audio/webm",
  "audio/3gpp",
]);

router.post(
  "/public/concierge/transcriptions",
  rateLimit({ windowMs: 60_000, max: 20, key: "concierge-transcribe" }),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = TranscribeConciergeAudioBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid transcription request" });
      return;
    }
    const mimeType = parsed.data.mimeType.split(";")[0].trim().toLowerCase();
    if (!ALLOWED_AUDIO_TYPES.has(mimeType)) {
      res.status(400).json({ error: "Unsupported audio type" });
      return;
    }
    let audio: Buffer;
    try {
      audio = Buffer.from(parsed.data.audioBase64, "base64");
    } catch {
      res.status(400).json({ error: "Invalid audio payload" });
      return;
    }
    if (audio.length === 0 || audio.length > MAX_TRANSCRIPTION_AUDIO_BYTES) {
      res.status(400).json({ error: "Audio clip is empty or too large" });
      return;
    }
    if (!process.env.OPENAI_API_KEY) {
      res.status(503).json({ error: "Voice transcription is not configured" });
      return;
    }
    try {
      const text = await transcribeAudio(audio, mimeType);
      res.json({ text });
    } catch (err) {
      req.log.error({ err }, "concierge transcription failed");
      res.status(502).json({ error: "Transcription failed" });
    }
  },
);

router.post(
  "/public/concierge/conversations/:id/messages",
  rateLimit({ windowMs: 60_000, max: 30, key: "concierge-message" }),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = SendConciergeMessageBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid message" });
      return;
    }
    const conversationId = String(req.params.id);
    if (!UUID_RE.test(conversationId)) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    const org = await getDefaultOrganization();
    const reply = await handleMessage({
      organizationId: org.id,
      conversationId,
      content: parsed.data.content,
      sourceIp: clientIp(req),
      userAgent: req.headers["user-agent"],
    });
    if (!reply) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    res.json(reply);
  },
);

router.get(
  "/public/site-config",
  rateLimit({ windowMs: 60_000, max: 60, key: "site-config" }),
  async (_req: Request, res: Response): Promise<void> => {
    const org = await getDefaultOrganization();
    const settings = await getOrgSettings(org.id);
    res.json({
      businessProfile: settings.businessProfile ?? {},
      services: (settings.services ?? []).filter((s) => s.isActive),
      serviceAreas: (settings.serviceAreas ?? []).filter((a) => a.isActive),
    });
  },
);

// Share card for a configured service area. The website's static areas ship
// committed og-area-<slug>.png files; areas added only through CRM site
// settings point their og:image here instead so link previews are still
// city-specific. Any active configured area is served (static ones included),
// unknown or inactive slugs 404.
router.get(
  "/public/og/area/:slug",
  rateLimit({ windowMs: 60_000, max: 60, key: "og-area-card" }),
  async (req: Request, res: Response): Promise<void> => {
    const slug = String(req.params.slug).replace(/\.png$/i, "");
    const org = await getDefaultOrganization();
    const settings = await getOrgSettings(org.id);
    const area = (settings.serviceAreas ?? []).find(
      (a) => a.isActive && a.slug === slug,
    );
    if (!area) {
      res.status(404).json({ error: "Service area not found" });
      return;
    }
    const profile = settings.businessProfile ?? {};
    const png = renderAreaShareCard({
      city: area.name,
      state: area.state ?? "GA",
      businessName:
        profile.businessName?.trim() || CLIENT.defaultOrgName,
      phone: profile.phone?.trim() || CLIENT.phone,
    });
    res
      .status(200)
      .setHeader("Content-Type", "image/png")
      .setHeader("Cache-Control", "public, max-age=3600")
      .send(png);
  },
);

router.post(
  "/public/analytics-events",
  rateLimit({ windowMs: 60_000, max: 60, key: "analytics" }),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = TrackAnalyticsEventBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid analytics event" });
      return;
    }
    const org = await getDefaultOrganization();
    await db.insert(analyticsEventsTable).values({
      organizationId: org.id,
      eventName: parsed.data.eventName,
      anonymousId: parsed.data.anonymousId ?? null,
      sessionId: parsed.data.sessionId ?? null,
      path: parsed.data.path ?? null,
      referrer: parsed.data.referrer ?? null,
      properties: parsed.data.properties ?? {},
    });
    res.status(202).json({ accepted: true });
  },
);

export default router;
