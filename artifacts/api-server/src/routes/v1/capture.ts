import { Router, type IRouter, type Request, type Response } from "express";

import { requireMember } from "../../middlewares/requireMember";
import { recordAudit } from "../../services/audit";
import {
  applyMapping,
  createCaptureEndpoint,
  deleteCaptureEndpoint,
  listCaptureEndpoints,
  listRecentDeliveries,
  sanitizeMapping,
  updateCaptureEndpoint,
} from "../../services/capture";

const router: IRouter = Router();

/** Base URL derives from the request host so dev and prod both produce working links. */
function requestBase(req: Request): string {
  const host =
    (req.headers["x-forwarded-host"] as string)?.split(",")[0]?.trim() ||
    req.headers.host ||
    "";
  const proto =
    (req.headers["x-forwarded-proto"] as string)?.split(",")[0]?.trim() ||
    req.protocol ||
    "https";
  return `${proto}://${host}`;
}

function withShareAssets<T extends { token: string }>(req: Request, endpoint: T) {
  const base = requestBase(req);
  const url = `${base}/api/v1/public/capture/${encodeURIComponent(endpoint.token)}`;
  return {
    ...endpoint,
    url,
    embedSnippet: `<script async src="${base}/api/v1/public/capture.js" data-capture-token="${endpoint.token}" data-form-selector="form"></script>`,
  };
}

router.get(
  "/capture-endpoints",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const endpoints = await listCaptureEndpoints(req.member!.organizationId);
    res.json(endpoints.map((e) => withShareAssets(req, e)));
  },
);

router.post(
  "/capture-endpoints",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const mapping = sanitizeMapping(body.mapping ?? {});
    if (!mapping) {
      res.status(400).json({ error: "mapping must map external fields to known lead fields" });
      return;
    }
    const endpoint = await createCaptureEndpoint(req.member!.organizationId, {
      name,
      mapping,
      defaultSource: typeof body.defaultSource === "string" ? body.defaultSource : undefined,
    });
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "capture_endpoint.created",
      entityType: "capture_endpoint",
      entityId: endpoint.id,
    });
    res.status(201).json(withShareAssets(req, endpoint));
  },
);

router.patch(
  "/capture-endpoints/:id",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    let mapping;
    if (body.mapping !== undefined) {
      mapping = sanitizeMapping(body.mapping);
      if (!mapping) {
        res.status(400).json({ error: "mapping must map external fields to known lead fields" });
        return;
      }
    }
    const endpoint = await updateCaptureEndpoint(
      req.member!.organizationId,
      String(req.params.id),
      {
        name: typeof body.name === "string" ? body.name : undefined,
        mapping,
        defaultSource:
          typeof body.defaultSource === "string" ? body.defaultSource : undefined,
        isActive: typeof body.isActive === "boolean" ? body.isActive : undefined,
      },
    );
    if (!endpoint) {
      res.status(404).json({ error: "Capture endpoint not found" });
      return;
    }
    res.json(withShareAssets(req, endpoint));
  },
);

router.delete(
  "/capture-endpoints/:id",
  requireMember("crm.delete"),
  async (req: Request, res: Response): Promise<void> => {
    const deleted = await deleteCaptureEndpoint(
      req.member!.organizationId,
      String(req.params.id),
    );
    if (!deleted) {
      res.status(404).json({ error: "Capture endpoint not found" });
      return;
    }
    res.status(204).end();
  },
);

/** Test-payload preview: apply a mapping to a sample payload without writing anything. */
router.post(
  "/capture-endpoints/preview",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const mapping = sanitizeMapping(body.mapping ?? {});
    if (!mapping) {
      res.status(400).json({ error: "mapping must map external fields to known lead fields" });
      return;
    }
    const payload =
      body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
        ? (body.payload as Record<string, unknown>)
        : {};
    res.json(applyMapping(mapping, payload));
  },
);

router.get(
  "/capture-deliveries",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(
      await listRecentDeliveries(
        req.member!.organizationId,
        typeof req.query.endpointId === "string" ? req.query.endpointId : undefined,
      ),
    );
  },
);

export default router;
