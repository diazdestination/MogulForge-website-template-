import { Router, type Request, type Response } from "express";
import { requireMember } from "../../middlewares/requireMember";
import { getRoiReport, roiReportToCsv } from "../../services/roi-report";

const router = Router();

function windowDays(req: Request): number {
  const days = Number(req.query.days ?? 30);
  if (!Number.isFinite(days)) return 30;
  return Math.min(365, Math.max(1, Math.floor(days)));
}

/** Organization ROI report with honest revenue attribution. */
router.get(
  "/reports/roi",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const report = await getRoiReport(
      req.member!.organizationId,
      windowDays(req),
    );
    res.json(report);
  },
);

/** Same report, flattened to CSV for download. */
router.get(
  "/reports/roi/export",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const report = await getRoiReport(
      req.member!.organizationId,
      windowDays(req),
    );
    res
      .status(200)
      .set({
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="roi-report-${report.windowDays}d.csv"`,
      })
      .send(roiReportToCsv(report));
  },
);

export default router;
