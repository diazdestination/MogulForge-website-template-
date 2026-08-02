import { CreateTemplateBody, UpdateTemplateBody } from "@workspace/api-zod";
import { Router, type IRouter, type Request, type Response } from "express";

import { requireMember } from "../../middlewares/requireMember";
import { recordAudit } from "../../services/audit";
import * as automation from "../../services/automation";

const router: IRouter = Router();

router.get(
  "/templates",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(await automation.listTemplates(req.member!.organizationId));
  },
);

router.post(
  "/templates",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateTemplateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid template" });
      return;
    }
    const template = await automation.createTemplate(
      req.member!.organizationId,
      parsed.data,
    );
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "template.created",
      entityType: "message_template",
      entityId: template.id,
    });
    res.status(201).json(template);
  },
);

router.patch(
  "/templates/:id",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdateTemplateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid template update" });
      return;
    }
    const template = await automation.updateTemplate(
      req.member!.organizationId,
      String(req.params.id),
      parsed.data,
    );
    if (!template) {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "template.updated",
      entityType: "message_template",
      entityId: template.id,
    });
    res.json(template);
  },
);

router.delete(
  "/templates/:id",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const ok = await automation.deleteTemplate(
      req.member!.organizationId,
      String(req.params.id),
    );
    if (!ok) {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "template.deleted",
      entityType: "message_template",
      entityId: String(req.params.id),
    });
    res.status(204).end();
  },
);

export default router;
