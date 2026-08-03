import { Router, type IRouter, type Request, type Response } from "express";

import { requireMember } from "../../middlewares/requireMember";
import {
  createCampaign,
  drainReactivationCampaigns,
  getCampaignReport,
  importLeads,
  listCampaigns,
  listImports,
  launchCampaign,
  previewOutreach,
  previewSegment,
  recommendedSegments,
  setCampaignStatus,
} from "../../services/reactivation";

const router: IRouter = Router();

// ---------- CSV lead import ----------

router.post(
  "/lead-imports",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const { csv, mapping, fileName, hasHeader, defaultStatus, defaultSource } =
      req.body ?? {};
    if (typeof csv !== "string" || csv.length === 0 || csv.length > 5_000_000) {
      res.status(400).json({ error: "A CSV file (under 5MB) is required" });
      return;
    }
    if (!mapping || typeof mapping !== "object") {
      res.status(400).json({ error: "A column mapping is required" });
      return;
    }
    const result = await importLeads(req.member!.organizationId, {
      csv,
      mapping,
      fileName: typeof fileName === "string" ? fileName : undefined,
      hasHeader: hasHeader !== false,
      defaultStatus: typeof defaultStatus === "string" ? defaultStatus : undefined,
      defaultSource: typeof defaultSource === "string" ? defaultSource : undefined,
      createdByUserId: req.member!.user.id,
    });
    if ("error" in result) {
      res.status(400).json(result);
      return;
    }
    res.status(201).json(result);
  },
);

router.get(
  "/lead-imports",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(await listImports(req.member!.organizationId));
  },
);

// ---------- segments ----------

router.get(
  "/reactivation/segments",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(await recommendedSegments(req.member!.organizationId));
  },
);

router.post(
  "/reactivation/segments/preview",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(await previewSegment(req.member!.organizationId, req.body?.segment));
  },
);

// ---------- campaigns ----------

router.get(
  "/reactivation/campaigns",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(await listCampaigns(req.member!.organizationId));
  },
);

router.post(
  "/reactivation/campaigns",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const { name, playbookId, segment, ratePerHour } = req.body ?? {};
    if (typeof name !== "string" || typeof playbookId !== "string") {
      res.status(400).json({ error: "name and playbookId are required" });
      return;
    }
    const result = await createCampaign(req.member!.organizationId, {
      name,
      playbookId,
      segment,
      ratePerHour: typeof ratePerHour === "number" ? ratePerHour : undefined,
      createdByUserId: req.member!.user.id,
    });
    if ("error" in result) {
      res.status(400).json(result);
      return;
    }
    res.status(201).json(result);
  },
);

router.post(
  "/reactivation/campaigns/preview-outreach",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const { playbookId, segment } = req.body ?? {};
    if (typeof playbookId !== "string") {
      res.status(400).json({ error: "playbookId is required" });
      return;
    }
    const result = await previewOutreach(req.member!.organizationId, {
      playbookId,
      segment,
    });
    if ("error" in result) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  },
);

router.get(
  "/reactivation/campaigns/:id",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const report = await getCampaignReport(req.member!.organizationId, String(req.params.id));
    if (!report) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    res.json(report);
  },
);

router.post(
  "/reactivation/campaigns/:id/launch",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const result = await launchCampaign(req.member!.organizationId, String(req.params.id));
    if ("error" in result) {
      res.status(400).json(result);
      return;
    }
    // Kick the drainer so the first batch goes out without waiting a tick.
    await drainReactivationCampaigns(req.member!.organizationId);
    res.json(result);
  },
);

for (const action of ["pause", "resume", "cancel"] as const) {
  router.post(
    `/reactivation/campaigns/:id/${action}`,
    requireMember("crm.write"),
    async (req: Request, res: Response): Promise<void> => {
      const result = await setCampaignStatus(
        req.member!.organizationId,
        String(req.params.id),
        action,
      );
      if ("error" in result) {
        res.status(400).json(result);
        return;
      }
      res.json(result);
    },
  );
}

export default router;
