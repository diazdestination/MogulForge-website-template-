import { CreateApiKeyBody, UpdateApiKeyBody } from "@workspace/api-zod";
import { Router, type IRouter, type Request, type Response } from "express";

import { requireMember } from "../../middlewares/requireMember";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  toApiKeyDto,
  updateApiKey,
} from "../../services/api-keys";
import { recordAudit } from "../../services/audit";

const router: IRouter = Router();

router.get(
  "/api-keys",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const keys = await listApiKeys(req.member!.organizationId);
    res.json(keys.map(toApiKeyDto));
  },
);

router.post(
  "/api-keys",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateApiKeyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid API key request" });
      return;
    }
    const role = parsed.data.role ?? "office";
    if (role === "owner" || role === "admin") {
      res.status(400).json({ error: "API keys cannot have owner or admin access" });
      return;
    }
    let expiresAt: Date | null = null;
    if (parsed.data.expiresAt !== undefined) {
      expiresAt = new Date(parsed.data.expiresAt);
      if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
        res.status(400).json({ error: "Expiration must be a valid future date" });
        return;
      }
    }
    const { record, key } = await createApiKey({
      organizationId: req.member!.organizationId,
      name: parsed.data.name,
      role,
      createdByUserId: req.member!.user.id,
      expiresAt,
    });
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "api_key.created",
      entityType: "api_key",
      entityId: record.id,
      metadata: { name: record.name, role: record.role, prefix: record.prefix },
    });
    res.status(201).json({ ...toApiKeyDto(record), key });
  },
);

router.patch(
  "/api-keys/:id",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdateApiKeyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid API key update" });
      return;
    }
    const changes: { name?: string; expiresAt?: Date | null } = {};
    if (parsed.data.name !== undefined) {
      const name = parsed.data.name.trim();
      if (!name) {
        res.status(400).json({ error: "Name cannot be empty" });
        return;
      }
      changes.name = name;
    }
    if (parsed.data.expiresAt !== undefined) {
      if (parsed.data.expiresAt === null) {
        changes.expiresAt = null;
      } else {
        const expiresAt = new Date(parsed.data.expiresAt);
        if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
          res.status(400).json({ error: "Expiration must be a valid future date" });
          return;
        }
        changes.expiresAt = expiresAt;
      }
    }
    if (changes.name === undefined && changes.expiresAt === undefined) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    const result = await updateApiKey(req.member!.organizationId, String(req.params.id), changes);
    if (!result) {
      res.status(404).json({ error: "API key not found" });
      return;
    }
    const { before, after } = result;
    if (changes.name !== undefined && before.name !== after.name) {
      await recordAudit({
        organizationId: req.member!.organizationId,
        actorUserId: req.member!.user.id,
        action: "api_key.renamed",
        entityType: "api_key",
        entityId: after.id,
        metadata: { oldName: before.name, newName: after.name, prefix: after.prefix },
      });
    }
    if (changes.expiresAt !== undefined) {
      await recordAudit({
        organizationId: req.member!.organizationId,
        actorUserId: req.member!.user.id,
        action: "api_key.expiry_updated",
        entityType: "api_key",
        entityId: after.id,
        metadata: {
          name: after.name,
          prefix: after.prefix,
          expiresAt: after.expiresAt ? after.expiresAt.toISOString() : null,
        },
      });
    }
    res.json(toApiKeyDto(after));
  },
);

router.delete(
  "/api-keys/:id",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const revoked = await revokeApiKey(req.member!.organizationId, String(req.params.id));
    if (!revoked) {
      res.status(404).json({ error: "API key not found" });
      return;
    }
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "api_key.revoked",
      entityType: "api_key",
      entityId: revoked.id,
      metadata: { name: revoked.name, prefix: revoked.prefix },
    });
    res.status(204).end();
  },
);

export default router;
