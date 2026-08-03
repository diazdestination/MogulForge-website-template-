import { db, organizationsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";

import { requireMember } from "../../middlewares/requireMember";
import { recordAudit } from "../../services/audit";
import { createOrganization, listAllOrganizations } from "../../services/org";

const router: IRouter = Router();

/**
 * Session-authenticated (but possibly org-less) user. Org creation must be
 * reachable BEFORE the user belongs to an org, so it cannot use
 * requireMember. API keys are deliberately rejected — only humans create
 * organizations.
 */
async function requireSessionUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (req.header("x-api-key")) {
    res.status(403).json({ error: "API keys cannot manage organizations" });
    return;
  }
  if (!req.isAuthenticated() || !req.user?.id) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, req.user.id));
  if (!user || !user.isActive) {
    res.status(403).json({ error: "Account is not active" });
    return;
  }
  req.sessionUser = user;
  next();
}

/** Platform super-admin gate (MogulForge operators), distinct from org owner. */
async function requirePlatformAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  await requireSessionUser(req, res, () => {
    if (!req.sessionUser?.isPlatformAdmin) {
      res.status(403).json({ error: "Platform admin access required" });
      return;
    }
    next();
  });
}

declare global {
  namespace Express {
    interface Request {
      sessionUser?: typeof usersTable.$inferSelect;
    }
  }
}

/**
 * Session probe that works BEFORE the user belongs to an organization —
 * the command-center uses it to decide between the create-organization
 * screen and the normal app shell. `/me` requires membership, so it can't
 * serve this purpose.
 */
router.get(
  "/session",
  requireSessionUser,
  async (req: Request, res: Response): Promise<void> => {
    const user = req.sessionUser!;
    const organization = user.organizationId
      ? (
          await db
            .select()
            .from(organizationsTable)
            .where(eq(organizationsTable.id, user.organizationId))
        )[0] ?? null
      : null;
    res.json({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      isPlatformAdmin: user.isPlatformAdmin,
      organization: organization
        ? {
            id: organization.id,
            name: organization.name,
            slug: organization.slug,
            timezone: organization.timezone,
          }
        : null,
    });
  },
);

/**
 * Self-serve organization creation: any signed-in user without an org can
 * create one and becomes its owner. Platform admins may also create orgs
 * without joining them (client provisioning).
 */
router.post(
  "/orgs",
  requireSessionUser,
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body ?? {};
    const name = typeof body.name === "string" ? body.name : "";
    const slug = typeof body.slug === "string" ? body.slug : undefined;
    const timezone = typeof body.timezone === "string" ? body.timezone : undefined;
    if (!name.trim()) {
      res.status(400).json({ error: "Company name is required" });
      return;
    }
    const user = req.sessionUser!;
    const attachCreator = !user.organizationId;
    if (user.organizationId && !user.isPlatformAdmin) {
      res.status(409).json({ error: "You already belong to an organization" });
      return;
    }
    const result = await createOrganization({
      name,
      slug,
      timezone,
      creatorUserId: user.id,
      attachCreator,
    });
    if ("error" in result) {
      res.status(400).json({ error: result.error });
      return;
    }
    await recordAudit({
      organizationId: result.org.id,
      actorUserId: user.id,
      action: "organization.created",
      entityType: "organization",
      entityId: result.org.id,
      metadata: { name: result.org.name, slug: result.org.slug },
    });
    res.status(201).json({ organization: result.org, joined: attachCreator });
  },
);

/** Platform admin: list every organization with member counts. */
router.get(
  "/platform/orgs",
  requirePlatformAdmin,
  async (_req: Request, res: Response): Promise<void> => {
    const orgs = await listAllOrganizations();
    res.json({
      organizations: orgs.map((o) => ({
        id: o.id,
        name: o.name,
        slug: o.slug,
        timezone: o.timezone,
        createdAt: o.createdAt?.toISOString?.() ?? String(o.createdAt),
        memberCount: Number(o.memberCount ?? 0),
      })),
    });
  },
);

/** Platform admin: rename an organization / change its timezone. */
router.patch(
  "/platform/orgs/:id",
  requirePlatformAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body ?? {};
    const patch: Partial<{ name: string; timezone: string }> = {};
    if (typeof body.name === "string" && body.name.trim().length >= 2) {
      patch.name = body.name.trim().slice(0, 120);
    }
    if (typeof body.timezone === "string" && body.timezone.trim()) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: body.timezone });
        patch.timezone = body.timezone;
      } catch {
        res.status(400).json({ error: "Invalid timezone" });
        return;
      }
    }
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    const [updated] = await db
      .update(organizationsTable)
      .set(patch)
      .where(eq(organizationsTable.id, String(req.params.id)))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    await recordAudit({
      organizationId: updated.id,
      actorUserId: req.sessionUser!.id,
      action: "organization.updated",
      entityType: "organization",
      entityId: updated.id,
      metadata: patch,
    });
    res.json({
      organization: {
        id: updated.id,
        name: updated.name,
        slug: updated.slug,
        timezone: updated.timezone,
      },
    });
  },
);

export default router;
