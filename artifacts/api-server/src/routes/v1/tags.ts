import { CreateTagBody } from "@workspace/api-zod";
import { Router, type IRouter, type Request, type Response } from "express";

import { requireMember } from "../../middlewares/requireMember";
import { recordAudit } from "../../services/audit";
import * as automation from "../../services/automation";

const router: IRouter = Router();

router.get(
  "/tags",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(await automation.listTags(req.member!.organizationId));
  },
);

router.post(
  "/tags",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateTagBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid tag" });
      return;
    }
    const tag = await automation.createTag(
      req.member!.organizationId,
      parsed.data,
    );
    if (!tag) {
      res.status(400).json({ error: "Tag already exists" });
      return;
    }
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "tag.created",
      entityType: "tag",
      entityId: tag.id,
      metadata: { name: tag.name },
    });
    res.status(201).json(tag);
  },
);

export default router;
