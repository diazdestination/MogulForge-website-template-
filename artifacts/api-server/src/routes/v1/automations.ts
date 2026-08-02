import { CreateAutomationBody, UpdateAutomationBody } from "@workspace/api-zod";
import type { AutomationAction } from "@workspace/db";
import { Router, type IRouter, type Request, type Response } from "express";

import { requireMember } from "../../middlewares/requireMember";
import { recordAudit } from "../../services/audit";
import * as automation from "../../services/automation";

const router: IRouter = Router();

router.get(
  "/automations",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(await automation.listAutomations(req.member!.organizationId));
  },
);

router.post(
  "/automations",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateAutomationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid automation" });
      return;
    }
    const rule = await automation.createAutomation(req.member!.organizationId, {
      ...parsed.data,
      actions: parsed.data.actions as AutomationAction[] | undefined,
    });
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "automation.created",
      entityType: "automation",
      entityId: rule.id,
    });
    res.status(201).json(rule);
  },
);

router.patch(
  "/automations/:id",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdateAutomationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid automation update" });
      return;
    }
    const rule = await automation.updateAutomation(
      req.member!.organizationId,
      String(req.params.id),
      {
        ...parsed.data,
        actions: parsed.data.actions as AutomationAction[] | undefined,
      },
    );
    if (!rule) {
      res.status(404).json({ error: "Automation not found" });
      return;
    }
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "automation.updated",
      entityType: "automation",
      entityId: rule.id,
    });
    res.json(rule);
  },
);

router.delete(
  "/automations/:id",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const ok = await automation.deleteAutomation(
      req.member!.organizationId,
      String(req.params.id),
    );
    if (!ok) {
      res.status(404).json({ error: "Automation not found" });
      return;
    }
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "automation.deleted",
      entityType: "automation",
      entityId: String(req.params.id),
    });
    res.status(204).end();
  },
);

router.get(
  "/automation-runs",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(
      await automation.listAutomationRuns(
        req.member!.organizationId,
        typeof req.query.automationId === "string"
          ? req.query.automationId
          : undefined,
      ),
    );
  },
);

export default router;
