import { CreateProjectBody, UpdateProjectBody } from "@workspace/api-zod";
import { Router, type IRouter, type Request, type Response } from "express";

import { requireMember } from "../../middlewares/requireMember";
import { recordAudit } from "../../services/audit";
import * as crm from "../../services/crm";

const router: IRouter = Router();

router.get(
  "/projects",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(
      await crm.listProjects(req.member!.organizationId, {
        leadId:
          typeof req.query.leadId === "string" ? req.query.leadId : undefined,
        status:
          typeof req.query.status === "string" ? req.query.status : undefined,
      }),
    );
  },
);

router.post(
  "/projects",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateProjectBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid project" });
      return;
    }
    const project = await crm.createProject(
      req.member!.organizationId,
      parsed.data,
    );
    if (project === crm.DUPLICATE_ESTIMATE) {
      res.status(409).json({
        error: "A project already exists for this estimate",
      });
      return;
    }
    if (!project) {
      res
        .status(400)
        .json({ error: "Lead, estimate, or crew member not found in your organization" });
      return;
    }
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "project.created",
      entityType: "project",
      entityId: project.id,
    });
    res.status(201).json(project);
  },
);

router.get(
  "/projects/:id",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const project = await crm.getProject(
      req.member!.organizationId,
      String(req.params.id),
    );
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json(project);
  },
);

router.patch(
  "/projects/:id",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdateProjectBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid project update" });
      return;
    }
    const project = await crm.updateProject(
      req.member!.organizationId,
      String(req.params.id),
      parsed.data,
    );
    if (project === crm.DUPLICATE_ESTIMATE) {
      res.status(409).json({
        error: "A project already exists for this estimate",
      });
      return;
    }
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (parsed.data.status) {
      await recordAudit({
        organizationId: req.member!.organizationId,
        actorUserId: req.member!.user.id,
        action: "project.status_changed",
        entityType: "project",
        entityId: project.id,
        metadata: { status: parsed.data.status },
      });
    }
    res.json(project);
  },
);

router.delete(
  "/projects/:id",
  requireMember("crm.delete"),
  async (req: Request, res: Response): Promise<void> => {
    const deleted = await crm.deleteProject(
      req.member!.organizationId,
      String(req.params.id),
    );
    if (!deleted) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "project.deleted",
      entityType: "project",
      entityId: String(req.params.id),
    });
    res.status(204).end();
  },
);

export default router;
