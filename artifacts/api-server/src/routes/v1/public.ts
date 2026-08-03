import {
  CheckStormActivityBody,
  RequestPublicUploadUrlBody,
  RequestPublicUploadUrlResponse,
  SendConciergeMessageBody,
  StartConciergeConversationBody,
  SubmitAssessmentBody,
  TrackAnalyticsEventBody,
  TranscribeConciergeAudioBody,
  SubmitWidgetLeadBody,
} from "@workspace/api-zod";
import { analyticsEventsTable, db } from "@workspace/db";
import { Router, type IRouter, type Request, type Response } from "express";

import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../../lib/objectStorage";
import { validatePhotoObjects } from "../../lib/photoValidation";
import { rateLimit } from "../../lib/rateLimit";
import { resolvePublicOrg } from "../../middlewares/publicOrg";
import { captureAssessment } from "../../services/assessment";
import { emitAutomationEvent } from "../../services/automation";
import { handleMessage, startConversation } from "../../services/concierge";
import { renderAreaShareCard } from "../../services/ogCard";
import { getDefaultOrganization } from "../../services/org";
import { getBusinessName, getOrgSettings } from "../../services/settings";
import { providers, transcribeAudio } from "../../services/providers";
import { recordHeartbeat } from "../../services/installation";
import { captureWidgetLead, getPublicWidgetConfig } from "../../services/widget";
import {
  captureFormSubmission,
  getPublicForm,
  getPublicFormRow,
} from "../../services/forms";
import { CLOSER_JS, CLOSER_JS_VERSION } from "../../widget/closerScript";
import { FORMS_JS, FORMS_JS_VERSION } from "../../widget/formsScript";
import { CAPTURE_JS, CAPTURE_JS_VERSION } from "../../widget/captureScript";
import { captureExternalLead, getEndpointByToken } from "../../services/capture";
import {
  findEngagementLink,
  recordReferralSubmission,
  recordReviewClick,
} from "../../services/engagement-links";
import { SubmitReferralBody } from "@workspace/api-zod";

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
  resolvePublicOrg(),
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
    const org = req.publicOrg!;
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
  resolvePublicOrg(),
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
  resolvePublicOrg(),
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
  resolvePublicOrg(),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = StartConciergeConversationBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid conversation request" });
      return;
    }
    const org = req.publicOrg!;
    const result = await startConversation({
      organizationId: org.id,
      source: parsed.data.source,
      intentHint: parsed.data.intent,
      attribution: parsed.data.attribution,
      anonymousId: parsed.data.anonymousId,
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
  resolvePublicOrg(),
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
  resolvePublicOrg(),
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
    const org = req.publicOrg!;
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
  resolvePublicOrg(),
  async (req: Request, res: Response): Promise<void> => {
    const org = req.publicOrg!;
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
  resolvePublicOrg(),
  async (req: Request, res: Response): Promise<void> => {
    const slug = String(req.params.slug).replace(/\.png$/i, "");
    const org = req.publicOrg!;
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
      businessName: profile.businessName?.trim() || (await getBusinessName(req.publicOrg!.id)),
      phone: profile.phone?.trim() || "",
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
  resolvePublicOrg(),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = TrackAnalyticsEventBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid analytics event" });
      return;
    }
    const org = req.publicOrg!;
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

// ---------- embeddable website widget (closer.js) ----------

// The loader script itself carries no org data (the key lives in the host
// page's script tag), so it is served without tenant resolution and cached
// aggressively. Version the URL (?v=N) to bust caches on script changes.
router.get(
  "/public/closer.js",
  rateLimit({ windowMs: 60_000, max: 120, key: "closer-js" }),
  (_req: Request, res: Response): void => {
    res
      .status(200)
      .setHeader("Content-Type", "application/javascript; charset=utf-8")
      .setHeader("Cache-Control", "public, max-age=3600")
      .setHeader("ETag", `"closer-v${CLOSER_JS_VERSION}"`)
      .send(CLOSER_JS);
  },
);

router.get(
  "/public/widget-config",
  rateLimit({ windowMs: 60_000, max: 120, key: "widget-config" }),
  resolvePublicOrg({ requireKey: true }),
  async (req: Request, res: Response): Promise<void> => {
    const org = req.publicOrg!;
    // Tenant-specific response — must never land in a shared cache keyed
    // only by URL, so cache privately in the visitor's browser.
    res
      .setHeader("Cache-Control", "private, max-age=300")
      .json(
        await getPublicWidgetConfig(org.id, {
          preview: req.query.preview === "1",
        }),
      );
  },
);

router.post(
  "/public/widget-leads",
  rateLimit({ windowMs: 60_000, max: 10, key: "widget-leads" }),
  resolvePublicOrg({ requireKey: true }),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = SubmitWidgetLeadBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid lead submission" });
      return;
    }
    const org = req.publicOrg!;
    // Gate on the module toggle only (preview:true): test mode hides the
    // widget from visitors but must not block the admin's preview submits.
    const config = await getPublicWidgetConfig(org.id, { preview: true });
    if (!config.modules.leadCapture) {
      res.status(403).json({ error: "Lead capture is disabled" });
      return;
    }
    const result = await captureWidgetLead({
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
        "lead.source": "widget",
      },
    });
    res.status(201).json({ leadId: result.leadId });
  },
);

// Heartbeat: closer.js pings once per successful init so the admin panel can
// show "last session / version / health" without crawling the site.
router.post(
  "/public/widget-heartbeat",
  rateLimit({ windowMs: 60_000, max: 60, key: "widget-heartbeat" }),
  resolvePublicOrg({ requireKey: true }),
  async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as { version?: unknown };
    // Derive the host from the validated Origin/Referer (already checked
    // against the authorized-domain list) rather than trusting the body.
    let host: string | undefined;
    try {
      const raw = req.headers.origin || req.headers.referer;
      if (typeof raw === "string") host = new URL(raw).hostname;
    } catch {
      /* ignore */
    }
    await recordHeartbeat(req.publicOrgKey!.id, {
      version: typeof body.version === "string" ? body.version : undefined,
      host,
    });
    res.status(204).end();
  },
);

// ---------- smart forms (embed runtime + hosted pages) ----------

// The runtime script carries no org data (key + slug live in the host page's
// script tag or hosted-page URL), so it is served without tenant resolution.
router.get(
  "/public/forms.js",
  rateLimit({ windowMs: 60_000, max: 120, key: "forms-js" }),
  (_req: Request, res: Response): void => {
    res
      .status(200)
      .setHeader("Content-Type", "application/javascript; charset=utf-8")
      .setHeader("Cache-Control", "public, max-age=3600")
      .setHeader("ETag", `"forms-v${FORMS_JS_VERSION}"`)
      .send(FORMS_JS);
  },
);

router.get(
  "/public/forms/:slug",
  rateLimit({ windowMs: 60_000, max: 120, key: "public-form-def" }),
  resolvePublicOrg(),
  async (req: Request, res: Response): Promise<void> => {
    const form = await getPublicForm(req.publicOrg!.id, String(req.params.slug));
    if (!form) {
      res.status(404).json({ error: "Form not found" });
      return;
    }
    // Tenant-specific — cache privately only.
    res.setHeader("Cache-Control", "private, max-age=120").json(form);
  },
);

router.post(
  "/public/forms/:slug/submissions",
  rateLimit({ windowMs: 60_000, max: 5, key: "public-form-submit" }),
  resolvePublicOrg(),
  async (req: Request, res: Response): Promise<void> => {
    const org = req.publicOrg!;
    const form = await getPublicFormRow(org.id, String(req.params.slug));
    if (!form) {
      res.status(404).json({ error: "Form not found" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const photoPaths = Object.values(
      (body.answers && typeof body.answers === "object" ? body.answers : {}) as Record<string, unknown>,
    )
      .filter((v): v is string[] => Array.isArray(v) && v.length > 0 && v.every((p) => typeof p === "string" && p.startsWith("/objects/")))
      .flat();
    if (photoPaths.length > 0) {
      const validation = await validatePhotoObjects(objectStorageService, photoPaths);
      if (!validation.ok) {
        res.status(400).json({ error: validation.reason });
        return;
      }
    }
    const result = await captureFormSubmission({
      organizationId: org.id,
      form,
      answers: body.answers,
      attribution: body.attribution,
      anonymousId: typeof body.anonymousId === "string" ? body.anonymousId : undefined,
      source: typeof body.source === "string" ? body.source : undefined,
      sourceIp: clientIp(req),
      userAgent: req.headers["user-agent"],
    });
    if ("error" in result) {
      res.status(400).json({ error: result.error });
      return;
    }
    if (!result.deduped) {
      emitAutomationEvent(org.id, "lead.created", {
        leadId: result.leadId,
        fields: {
          "lead.status": "new",
          "lead.urgency": result.urgency,
          "lead.source": typeof body.source === "string" ? body.source : `form:${form.slug}`,
        },
      });
    }
    res.status(201).json(result);
  },
);

// ---------- external form capture (capture.js + inbound endpoints) ----------

// Opt-in listener for a client's existing site forms. Like the other embed
// loaders it carries no org data (the token lives in the script tag).
router.get(
  "/public/capture.js",
  rateLimit({ windowMs: 60_000, max: 120, key: "capture-js" }),
  (_req: Request, res: Response): void => {
    res
      .status(200)
      .setHeader("Content-Type", "application/javascript; charset=utf-8")
      .setHeader("Cache-Control", "public, max-age=3600")
      .setHeader("ETag", `"capture-v${CAPTURE_JS_VERSION}"`)
      .send(CAPTURE_JS);
  },
);

/**
 * Inbound capture endpoint: accepts JSON (Zapier/Make/n8n webhooks, the
 * capture.js listener) and form-encoded posts (a form's action pointed
 * directly at us). The endpoint token identifies the org — no session.
 * Idempotency: `x-idempotency-key` header or `_idempotencyKey` body field.
 */
router.post(
  "/public/capture/:token",
  rateLimit({ windowMs: 60_000, max: 30, key: "public-capture" }),
  async (req: Request, res: Response): Promise<void> => {
    const endpoint = await getEndpointByToken(String(req.params.token));
    if (!endpoint) {
      res.status(404).json({ error: "Unknown capture endpoint" });
      return;
    }
    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    const headerKey = req.headers["x-idempotency-key"];
    const idempotencyKey =
      (typeof headerKey === "string" && headerKey) ||
      (typeof body._idempotencyKey === "string" ? body._idempotencyKey : null);
    const result = await captureExternalLead(endpoint, body, { idempotencyKey });
    if (!result.ok) {
      res.status(422).json({ error: result.error });
      return;
    }
    res.status(result.duplicateDelivery ? 200 : 201).json({
      ok: true,
      leadId: result.leadId,
      outcome: result.outcome,
      duplicate: result.duplicateDelivery,
    });
  },
);

// Hosted MogulForge form page: a minimal shell that loads the same forms.js
// runtime used by third-party embeds. The key is public by design; the
// runtime's fetches are same-origin here, which resolvePublicOrg accepts.
router.get(
  "/public/form-page/:slug",
  rateLimit({ windowMs: 60_000, max: 60, key: "form-page" }),
  (req: Request, res: Response): void => {
    const slug = String(req.params.slug);
    const rawKey = String(req.query.key ?? "");
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug) || !/^[A-Za-z0-9_]{0,100}$/.test(rawKey)) {
      res.status(400).send("Invalid link");
      return;
    }
    const attrs =
      `data-form="${slug}"` + (rawKey ? ` data-org-id="${rawKey}"` : "");
    res
      .status(200)
      .setHeader("Content-Type", "text/html; charset=utf-8")
      .setHeader("Cache-Control", "no-store")
      .send(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Request form</title>
<meta name="robots" content="noindex">
<style>body{margin:0;background:#f3f4f6;min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:32px 16px;font-family:system-ui,sans-serif}#mf-form{width:100%;max-width:560px}</style></head>
<body>
<div id="mf-form"></div>
<script async src="/api/v1/public/forms.js" ${attrs} data-target="#mf-form"></script>
</body>
</html>`);
  },
);

// Local demo page simulating a third-party site with the snippet installed.
// Everything on it is public information (the key is public by design).
// ---------- post-sale engagement links (review clicks + referrals) ----------
// The token alone identifies the org/contact — a capability URL sent only to
// the customer it belongs to. Clicks and submissions are tracked honestly;
// completed third-party reviews are never claimed.

router.get(
  "/public/el/:token",
  rateLimit({ windowMs: 60_000, max: 30, key: "engagement-link" }),
  async (req: Request, res: Response): Promise<void> => {
    const link = await findEngagementLink(String(req.params.token));
    if (!link || link.kind !== "review") {
      res.status(404).send("Link not found");
      return;
    }
    const destination = await recordReviewClick(link);
    res.redirect(302, destination);
  },
);

router.get(
  "/public/referrals/:token",
  rateLimit({ windowMs: 60_000, max: 30, key: "referral-info" }),
  async (req: Request, res: Response): Promise<void> => {
    const link = await findEngagementLink(String(req.params.token));
    if (!link || link.kind !== "referral") {
      res.status(404).json({ error: "Link not found" });
      return;
    }
    res.json({ businessName: await getBusinessName(link.organizationId) });
  },
);

router.post(
  "/public/referrals/:token",
  rateLimit({ windowMs: 60_000, max: 10, key: "referral-submit" }),
  async (req: Request, res: Response): Promise<void> => {
    const link = await findEngagementLink(String(req.params.token));
    if (!link || link.kind !== "referral") {
      res.status(404).json({ error: "Link not found" });
      return;
    }
    const parsed = SubmitReferralBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid referral" });
      return;
    }
    const { name, email, phone, notes } = parsed.data;
    if (!email && !phone) {
      res.status(400).json({ error: "An email or phone number is required" });
      return;
    }
    const result = await recordReferralSubmission(link, {
      name,
      email: email ?? undefined,
      phone: phone ?? undefined,
      notes: notes ?? undefined,
    });
    res.status(201).json({ ok: true, leadId: result.leadId });
  },
);

router.get(
  "/public/widget-demo",
  rateLimit({ windowMs: 60_000, max: 30, key: "widget-demo" }),
  (req: Request, res: Response): void => {
    const rawKey = String(req.query.key ?? "");
    if (!/^[A-Za-z0-9_]{0,80}$/.test(rawKey)) {
      res.status(400).send("Invalid key");
      return;
    }
    const snippet = rawKey
      ? `<script async src="/api/v1/public/closer.js" data-org-id="${rawKey}"></script>`
      : "<!-- pass ?key=mfi_... to load the widget -->";
    res
      .status(200)
      .setHeader("Content-Type", "text/html; charset=utf-8")
      .setHeader("Cache-Control", "no-store")
      .send(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Widget demo — third-party site</title>
<style>body{font-family:Georgia,serif;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.6}</style></head>
<body>
<h1>Acme Home Services</h1>
<p>This page simulates a customer's existing website with the Closer snippet pasted in. The launcher should appear in the corner if the key is valid and this host is authorized.</p>
${snippet}
</body>
</html>`);
  },
);

export default router;
