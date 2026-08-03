import { AddAuthorizedDomainBody, CheckInstallationBody } from "@workspace/api-zod";
import { Router, type IRouter, type Request, type Response } from "express";

import { rateLimit } from "../../lib/rateLimit";
import { requireMember } from "../../middlewares/requireMember";
import { recordAudit } from "../../services/audit";
import {
  addAuthorizedDomain,
  getActiveInstallationKey,
  listAuthorizedDomains,
  removeAuthorizedDomain,
  rotateInstallationKey,
} from "../../services/installation";
import {
  listInstallationChecks,
  verifyInstallation,
} from "../../services/installationCheck";

const router: IRouter = Router();

function toCheckDto(c: {
  domain: string;
  status: string;
  detail: string;
  checkedAt: Date;
}) {
  return {
    domain: c.domain,
    status: c.status,
    detail: c.detail,
    checkedAt: c.checkedAt.toISOString(),
  };
}

function toDomainDto(d: { id: string; domain: string; createdAt: Date }) {
  return { id: d.id, domain: d.domain, createdAt: d.createdAt.toISOString() };
}

router.get(
  "/installation",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const orgId = req.member!.organizationId;
    const [key, domains, checks] = await Promise.all([
      getActiveInstallationKey(orgId),
      listAuthorizedDomains(orgId),
      listInstallationChecks(orgId),
    ]);
    res.json({
      publicKey: key.publicKey,
      createdAt: key.createdAt.toISOString(),
      domains: domains.map(toDomainDto),
      heartbeat: key.lastSeenAt
        ? {
            lastSeenAt: key.lastSeenAt.toISOString(),
            version: key.lastSeenVersion,
            host: key.lastSeenHost,
          }
        : undefined,
      checks: checks.map(toCheckDto),
    });
  },
);

router.post(
  "/installation/checks",
  requireMember("settings.manage"),
  // Server-side page fetches are comparatively expensive — keep the rate low.
  rateLimit({ windowMs: 60_000, max: 6, key: "installation-check" }),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = CheckInstallationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid domain" });
      return;
    }
    const orgId = req.member!.organizationId;
    const check = await verifyInstallation(orgId, parsed.data.domain);
    if (!check) {
      res.status(400).json({
        error:
          "Enter a specific domain like example.com or shop.example.com (wildcards can't be checked)",
      });
      return;
    }
    await recordAudit({
      organizationId: orgId,
      actorUserId: req.member!.user.id,
      action: "installation.checked",
      entityType: "installation_check",
      entityId: check.id,
      metadata: { domain: check.domain, status: check.status },
    });
    res.json(toCheckDto(check));
  },
);

router.post(
  "/installation/rotate",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const orgId = req.member!.organizationId;
    const key = await rotateInstallationKey(orgId);
    await recordAudit({
      organizationId: orgId,
      actorUserId: req.member!.user.id,
      action: "installation_key.rotated",
      entityType: "installation_key",
      entityId: key.id,
      metadata: {},
    });
    res
      .status(201)
      .json({ publicKey: key.publicKey, createdAt: key.createdAt.toISOString() });
  },
);

router.post(
  "/installation/domains",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = AddAuthorizedDomainBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid domain" });
      return;
    }
    const orgId = req.member!.organizationId;
    const domain = await addAuthorizedDomain(orgId, parsed.data.domain);
    if (!domain) {
      res.status(400).json({
        error:
          "Enter a valid domain like example.com, sub.example.com, *.example.com, or localhost",
      });
      return;
    }
    await recordAudit({
      organizationId: orgId,
      actorUserId: req.member!.user.id,
      action: "installation_domain.added",
      entityType: "authorized_domain",
      entityId: domain.id,
      metadata: { domain: domain.domain },
    });
    res.status(201).json(toDomainDto(domain));
  },
);

router.delete(
  "/installation/domains/:id",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const orgId = req.member!.organizationId;
    const removed = await removeAuthorizedDomain(orgId, String(req.params.id));
    if (!removed) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }
    await recordAudit({
      organizationId: orgId,
      actorUserId: req.member!.user.id,
      action: "installation_domain.removed",
      entityType: "authorized_domain",
      entityId: removed.id,
      metadata: { domain: removed.domain },
    });
    res.status(204).end();
  },
);

export default router;
