import {
  CreateWebhookBody,
  RotateWebhookSecretBody,
  UpdateWebhookBody,
} from "@workspace/api-zod";
import type { WebhookEndpoint } from "@workspace/db";
import { Router, type IRouter, type Request, type Response } from "express";

import { requireMember } from "../../middlewares/requireMember";
import { recordAudit } from "../../services/audit";
import * as webhooks from "../../services/webhooks";

const router: IRouter = Router();

/** Never expose the signing secret except at creation time. */
function redact(endpoint: WebhookEndpoint) {
  const { secret: _secret, previousSecret: _prev, ...rest } = endpoint;
  return rest;
}

router.get(
  "/webhooks",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const rows = await webhooks.listEndpoints(req.member!.organizationId);
    res.json(rows.map(redact));
  },
);

router.post(
  "/webhooks",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateWebhookBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid webhook endpoint" });
      return;
    }
    if (!webhooks.isWebhookUrlAllowed(parsed.data.url)) {
      res.status(400).json({ error: "Webhook URL not allowed" });
      return;
    }
    const endpoint = await webhooks.createEndpoint(
      req.member!.organizationId,
      parsed.data,
    );
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "webhook.created",
      entityType: "webhook_endpoint",
      entityId: endpoint.id,
      metadata: { url: endpoint.url },
    });
    // Secret returned once, at creation only.
    res.status(201).json(endpoint);
  },
);

router.patch(
  "/webhooks/:id",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdateWebhookBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid webhook update" });
      return;
    }
    if (parsed.data.url && !webhooks.isWebhookUrlAllowed(parsed.data.url)) {
      res.status(400).json({ error: "Webhook URL not allowed" });
      return;
    }
    const endpoint = await webhooks.updateEndpoint(
      req.member!.organizationId,
      String(req.params.id),
      parsed.data,
    );
    if (!endpoint) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "webhook.updated",
      entityType: "webhook_endpoint",
      entityId: endpoint.id,
      metadata: { url: endpoint.url },
    });
    res.json(redact(endpoint));
  },
);

router.post(
  "/webhooks/:id/rotate-secret",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = RotateWebhookSecretBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid rotation request" });
      return;
    }
    // Default 24h grace window, capped at 7 days.
    const gracePeriodHours = Math.min(parsed.data.gracePeriodHours ?? 24, 168);
    const endpoint = await webhooks.rotateEndpointSecret(
      req.member!.organizationId,
      String(req.params.id),
      gracePeriodHours,
    );
    if (!endpoint) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "webhook.secret_rotated",
      entityType: "webhook_endpoint",
      entityId: endpoint.id,
      metadata: { url: endpoint.url, gracePeriodHours },
    });
    // New secret returned once, at rotation only.
    const { previousSecret: _prev, ...rest } = endpoint;
    res.json(rest);
  },
);

router.delete(
  "/webhooks/:id/previous-secret",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const endpoint = await webhooks.expirePreviousSecret(
      req.member!.organizationId,
      String(req.params.id),
    );
    if (!endpoint) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "webhook.previous_secret_expired",
      entityType: "webhook_endpoint",
      entityId: endpoint.id,
      metadata: { url: endpoint.url },
    });
    res.json(redact(endpoint));
  },
);

router.delete(
  "/webhooks/:id",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const ok = await webhooks.deleteEndpoint(
      req.member!.organizationId,
      String(req.params.id),
    );
    if (!ok) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "webhook.deleted",
      entityType: "webhook_endpoint",
      entityId: String(req.params.id),
    });
    res.status(204).end();
  },
);

router.get(
  "/webhook-deliveries",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(
      await webhooks.listDeliveries(
        req.member!.organizationId,
        typeof req.query.endpointId === "string"
          ? req.query.endpointId
          : undefined,
      ),
    );
  },
);

export default router;
