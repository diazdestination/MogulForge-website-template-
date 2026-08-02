import { CreateTaskBody, UpdateTaskBody } from "@workspace/api-zod";
import { Router, type IRouter, type Request, type Response } from "express";

import { requireMember } from "../../middlewares/requireMember";
import * as crm from "../../services/crm";

const router: IRouter = Router();

router.get(
  "/tasks",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(
      await crm.listTasks(req.member!.organizationId, {
        status:
          typeof req.query.status === "string" ? req.query.status : undefined,
        assignedUserId:
          typeof req.query.assignedUserId === "string"
            ? req.query.assignedUserId
            : undefined,
      }),
    );
  },
);

router.post(
  "/tasks",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateTaskBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid task" });
      return;
    }
    const task = await crm.createTask(req.member!.organizationId, parsed.data);
    if (!task) {
      res.status(400).json({ error: "Related record not found in your organization" });
      return;
    }
    res.status(201).json(task);
  },
);

router.patch(
  "/tasks/:id",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdateTaskBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid task update" });
      return;
    }
    const task = await crm.updateTask(
      req.member!.organizationId,
      String(req.params.id),
      parsed.data as Record<string, never>,
    );
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json(task);
  },
);

router.delete(
  "/tasks/:id",
  requireMember("crm.delete"),
  async (req: Request, res: Response): Promise<void> => {
    const deleted = await crm.deleteTask(
      req.member!.organizationId,
      String(req.params.id),
    );
    if (!deleted) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.status(204).end();
  },
);

export default router;
