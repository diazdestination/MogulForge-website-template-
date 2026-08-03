import { CreatePlaybookBody, UpdatePlaybookBody } from "@workspace/api-zod";
import {
  db,
  playbooksTable,
  type PlaybookCategory,
  type PlaybookEnrollmentRules,
  type PlaybookStep,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";

import { requireMember } from "../../middlewares/requireMember";
import { recordAudit } from "../../services/audit";
import {
  ensureDefaultPlaybook,
  getLeadEnrollment,
  pauseEnrollmentById,
  resumeEnrollment,
  skipEnrollmentStep,
} from "../../services/playbooks";
import { getConversionInsights } from "../../services/playbook-learning";
import { getCopilotPerformance } from "../../services/next-best-action";
const router: IRouter = Router();

// ---------- Conversion Insights (learning loop) ----------

router.get(
  "/playbook-insights",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(await getConversionInsights(req.member!.organizationId));
  },
);

router.get(
  "/copilot-performance",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(await getCopilotPerformance(req.member!.organizationId));
  },
);

// ---------- admin: playbook editor ----------

router.get(
  "/playbooks",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const organizationId = req.member!.organizationId;
    await ensureDefaultPlaybook(organizationId);
    const rows = await db
      .select()
      .from(playbooksTable)
      .where(eq(playbooksTable.organizationId, organizationId))
      .orderBy(desc(playbooksTable.createdAt));
    res.json(rows);
  },
);

router.post(
  "/playbooks",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdatePlaybookBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid playbook update" });
      return;
    }
    if (parsed.data.steps && parsed.data.steps.length === 0) {
      res.status(400).json({ error: "A playbook needs at least one step" });
      return;
    }
    const [row] = await db
      .update(playbooksTable)
      .set({
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.category !== undefined
          ? { category: parsed.data.category as PlaybookCategory }
          : {}),
        ...(parsed.data.isActive !== undefined
          ? { isActive: parsed.data.isActive }
          : {}),
        ...(parsed.data.enrollmentRules !== undefined
          ? {
              enrollmentRules: parsed.data
                .enrollmentRules as PlaybookEnrollmentRules,
            }
          : {}),
        ...(parsed.data.steps !== undefined
          ? { steps: parsed.data.steps as PlaybookStep[] }
          : {}),
      })
      .where(
        and(
          eq(playbooksTable.id, String(req.params.id)),
          eq(playbooksTable.organizationId, req.member!.organizationId),
        ),
      )
      .returning();
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "playbook.created",
      entityType: "playbook",
      entityId: row.id,
    });
    res.status(201).json(row);
  },
);

router.patch(
  "/playbooks/:id",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdatePlaybookBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid playbook update" });
      return;
    }
    if (parsed.data.steps && parsed.data.steps.length === 0) {
      res.status(400).json({ error: "A playbook needs at least one step" });
      return;
    }
    const [row] = await db
      .update(playbooksTable)
      .set({
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.category !== undefined
          ? { category: parsed.data.category as PlaybookCategory }
          : {}),
        ...(parsed.data.isActive !== undefined
          ? { isActive: parsed.data.isActive }
          : {}),
        ...(parsed.data.enrollmentRules !== undefined
          ? {
              enrollmentRules: parsed.data
                .enrollmentRules as PlaybookEnrollmentRules,
            }
          : {}),
        ...(parsed.data.steps !== undefined
          ? { steps: parsed.data.steps as PlaybookStep[] }
          : {}),
      })
      .where(
        and(
          eq(playbooksTable.id, String(req.params.id)),
          eq(playbooksTable.organizationId, req.member!.organizationId),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Playbook not found" });
      return;
    }
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "playbook.updated",
      entityType: "playbook",
      entityId: row.id,
    });
    res.json(row);
  },
);

// ---------- rep: lead enrollment status + controls ----------

router.get(
  "/leads/:id/enrollment",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const enrollment = await getLeadEnrollment(
      req.member!.organizationId,
      String(req.params.id),
    );
    const organizationId = req.member!.organizationId;
    const updated = await skipEnrollmentStep(
      req.member!.organizationId,
      String(req.params.id),
    );
    if (!updated) {
      res.status(404).json({ error: "No paused enrollment to resume" });
      return;
    }
    res.json(updated);
  },
);

router.post(
  "/enrollments/:id/skip",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const updated = await skipEnrollmentStep(
      req.member!.organizationId,
      String(req.params.id),
    );
    if (!updated) {
      res.status(404).json({ error: "No live enrollment to skip" });
      return;
    }
    res.json(updated);
  },
);

export default router;
