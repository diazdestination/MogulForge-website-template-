import { Router, type IRouter, type Request, type Response } from "express";

import { requireMember } from "../../middlewares/requireMember";
import * as crm from "../../services/crm";

const router: IRouter = Router();

router.get(
  "/dashboard/summary",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(await crm.getDashboardSummary(req.member!.organizationId));
  },
);

router.get(
  "/dashboard/marketing",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const parsedDays = Number(req.query.days);
    const days =
      Number.isInteger(parsedDays) && parsedDays >= 1 && parsedDays <= 365 ? parsedDays : 30;
    res.json(await crm.getMarketingSummary(req.member!.organizationId, days));
  },
);

router.get(
  "/audit-events",
  requireMember("audit.read"),
  async (req: Request, res: Response): Promise<void> => {
    const action =
      typeof req.query.action === "string" && req.query.action.trim()
        ? req.query.action.trim()
        : undefined;
    let since: Date | undefined;
    if (typeof req.query.since === "string" && req.query.since.trim()) {
      const parsed = new Date(req.query.since);
      if (Number.isNaN(parsed.getTime())) {
        res.status(400).json({ error: "Invalid 'since' timestamp" });
        return;
      }
      since = parsed;
    }
    res.json(await crm.listAuditEvents(req.member!.organizationId, { action, since }));
  },
);

export default router;
