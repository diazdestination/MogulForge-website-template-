/**
 * Smart-form admin CRUD + share assets (hosted URL, embed snippet, QR).
 * Admin-only (settings.manage); every mutation is audited.
 */
import { CreateFormBody, UpdateFormBody } from "@workspace/api-zod";
import type { FormRow, FormSubmissionRow } from "@workspace/db";
import { Router, type IRouter, type Request, type Response } from "express";
import QRCode from "qrcode";

import { requireMember } from "../../middlewares/requireMember";
import { recordAudit } from "../../services/audit";
import {
  createForm,
  deleteForm,
  getForm,
  listForms,
  listFormSubmissions,
  updateForm,
} from "../../services/forms";
import { getActiveInstallationKey } from "../../services/installation";

const router: IRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toDto(f: FormRow) {
  return {
    id: f.id,
    slug: f.slug,
    name: f.name,
    description: f.description,
    status: f.status,
    isSeeded: f.seedKey != null,
    steps: f.steps,
    settings: f.settings,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  };
}

function submissionDto(s: FormSubmissionRow) {
  return {
    id: s.id,
    formId: s.formId,
    leadId: s.leadId,
    contactId: s.contactId,
    answers: s.answers,
    attribution: s.attribution,
    dedupeOutcome: s.dedupedIntoExistingLead,
    createdAt: s.createdAt.toISOString(),
  };
}

router.get(
  "/forms",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const forms = await listForms(req.member!.organizationId);
    res.json(forms.map(toDto));
  },
);

router.post(
  "/forms",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateFormBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid form" });
      return;
    }
    const result = await createForm(req.member!.organizationId, parsed.data);
    if ("error" in result) {
      res.status(400).json({ error: result.error });
      return;
    }
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "form.created",
      entityType: "form",
      entityId: result.id,
      metadata: { slug: result.slug, name: result.name },
    });
    res.status(201).json(toDto(result));
  },
);

router.patch(
  "/forms/:id",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    if (!UUID_RE.test(String(req.params.id))) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const parsed = UpdateFormBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid form" });
      return;
    }
    const result = await updateForm(req.member!.organizationId, String(req.params.id), parsed.data);
    if (result === null) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if ("error" in result) {
      res.status(400).json({ error: result.error });
      return;
    }
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "form.updated",
      entityType: "form",
      entityId: result.id,
      metadata: { slug: result.slug, status: result.status },
    });
    res.json(toDto(result));
  },
);

router.delete(
  "/forms/:id",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    if (!UUID_RE.test(String(req.params.id))) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const outcome = await deleteForm(req.member!.organizationId, String(req.params.id));
    if (!outcome) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: outcome === "deleted" ? "form.deleted" : "form.archived",
      entityType: "form",
      entityId: String(req.params.id),
      metadata: {},
    });
    res.json({ outcome });
  },
);

router.get(
  "/forms/:id/submissions",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    if (!UUID_RE.test(String(req.params.id))) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const form = await getForm(req.member!.organizationId, String(req.params.id));
    if (!form) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const rows = await listFormSubmissions(req.member!.organizationId, form.id);
    res.json(rows.map(submissionDto));
  },
);

/**
 * Share assets: hosted page URL (key-scoped), paste-in embed snippet, and a
 * QR code (SVG) of the hosted URL. Base URL derives from the request host so
 * dev and production both produce working links.
 */
router.get(
  "/forms/:id/share",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    if (!UUID_RE.test(String(req.params.id))) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const form = await getForm(req.member!.organizationId, String(req.params.id));
    if (!form) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const key = await getActiveInstallationKey(req.member!.organizationId);
    const host =
      (req.headers["x-forwarded-host"] as string)?.split(",")[0]?.trim() ||
      req.headers.host ||
      "";
    const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0]?.trim() || req.protocol || "https";
    const base = `${proto}://${host}`;
    const keyParam = key ? `?key=${encodeURIComponent(key.publicKey)}` : "";
    const hostedUrl = `${base}/api/v1/public/form-page/${encodeURIComponent(form.slug)}${keyParam}`;
    const embedSnippet = key
      ? `<script async src="${base}/api/v1/public/forms.js" data-org-id="${key.publicKey}" data-form="${form.slug}"></script>`
      : "Generate an installation key in Settings → Website widget first.";
    const qrSvg = await QRCode.toString(hostedUrl, { type: "svg", margin: 1, width: 240 });
    res.json({ hostedUrl, embedSnippet, qrSvg });
  },
);

export default router;
