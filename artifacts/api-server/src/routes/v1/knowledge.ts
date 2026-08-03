/**
 * Org knowledge base CRUD — the facts that ground the AI concierge and
 * outreach drafting. Admin-only (settings.manage); every mutation is audited.
 */
import { CreateKnowledgeEntryBody, UpdateKnowledgeEntryBody } from "@workspace/api-zod";
import { Router, type IRouter, type Request, type Response } from "express";

import { requireMember } from "../../middlewares/requireMember";
import { recordAudit } from "../../services/audit";
import {
  createKnowledgeEntry,
  deleteKnowledgeEntry,
  listKnowledgeEntries,
  updateKnowledgeEntry,
} from "../../services/knowledge";

const router: IRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toDto(e: {
  id: string;
  category: string;
  title: string;
  content: string;
  source: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: e.id,
    category: e.category,
    title: e.title,
    content: e.content,
    source: e.source,
    isActive: e.isActive,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

router.get(
  "/knowledge",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const entries = await listKnowledgeEntries(req.member!.organizationId);
    res.json(entries.map(toDto));
  },
);

router.post(
  "/knowledge",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateKnowledgeEntryBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid knowledge entry" });
      return;
    }
    const entry = await createKnowledgeEntry(req.member!.organizationId, parsed.data);
    if (!entry) {
      res.status(400).json({ error: "Invalid category or empty title/content" });
      return;
    }
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "knowledge.created",
      entityType: "knowledge_entry",
      entityId: entry.id,
      metadata: { category: entry.category, title: entry.title },
    });
    res.status(201).json(toDto(entry));
  },
);

router.patch(
  "/knowledge/:id",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const parsed = UpdateKnowledgeEntryBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid knowledge entry" });
      return;
    }
    const result = await updateKnowledgeEntry(req.member!.organizationId, id, parsed.data);
    if (result === "invalid") {
      res.status(400).json({ error: "Invalid category or empty title/content" });
      return;
    }
    if (!result) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "knowledge.updated",
      entityType: "knowledge_entry",
      entityId: id,
      metadata: { fields: Object.keys(parsed.data) },
    });
    res.json(toDto(result));
  },
);

router.delete(
  "/knowledge/:id",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const deleted = await deleteKnowledgeEntry(req.member!.organizationId, id);
    if (!deleted) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "knowledge.deleted",
      entityType: "knowledge_entry",
      entityId: id,
    });
    res.status(204).end();
  },
);

export default router;
