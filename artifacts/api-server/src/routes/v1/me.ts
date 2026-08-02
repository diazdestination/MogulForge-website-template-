import { InviteUserBody, UpdateUserBody } from "@workspace/api-zod";
import { db, organizationsTable, usersTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";

import { consumeCooldown } from "../../lib/rateLimit";
import { requireMember } from "../../middlewares/requireMember";
import { recordAudit } from "../../services/audit";
import { listMembers } from "../../services/crm";
import { sendInviteEmail } from "../../services/invite-email";

const router: IRouter = Router();

function memberDto(u: {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  role: string;
  isActive: boolean;
}) {
  return {
    id: u.id,
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    role: u.role,
    isActive: u.isActive,
  };
}

router.get(
  "/me",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const { user, organizationId } = req.member!;
    const [organization] = await db
      .select()
      .from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId));
    res.json({
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      isActive: user.isActive,
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

router.get(
  "/users",
  requireMember("users.read"),
  async (req: Request, res: Response): Promise<void> => {
    const members = await listMembers(req.member!.organizationId);
    res.json(
      members.map((m) => ({
        id: m.id,
        email: m.email,
        firstName: m.firstName,
        lastName: m.lastName,
        role: m.role,
        isActive: m.isActive,
      })),
    );
  },
);

router.post(
  "/users/invite",
  requireMember("users.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = InviteUserBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid invite" });
      return;
    }
    const { email, role, firstName, lastName } = parsed.data;
    if (role === "owner" && req.member!.role !== "owner") {
      res.status(403).json({ error: "Only the owner can grant the owner role" });
      return;
    }
    const [existing] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email.toLowerCase()));
    if (existing) {
      res.status(409).json({ error: "A member with this email already exists" });
      return;
    }
    const [user] = await db
      .insert(usersTable)
      .values({
        // "invite:" ids are adopted (re-keyed to the auth subject) on first sign-in.
        id: `invite:${crypto.randomUUID()}`,
        email: email.toLowerCase(),
        firstName: firstName ?? null,
        lastName: lastName ?? null,
        organizationId: req.member!.organizationId,
        role,
      })
      .returning();
    // Notify the invitee. Failures are surfaced to the admin in the
    // response (inviteEmail.sent=false) rather than failing the invite.
    const inviter = req.member!.user;
    const inviterName =
      [inviter.firstName, inviter.lastName].filter(Boolean).join(" ") ||
      inviter.email ||
      "A teammate";
    const inviteEmail = await sendInviteEmail({
      organizationId: req.member!.organizationId,
      to: user.email!,
      inviteeFirstName: user.firstName,
      inviterName,
      role,
    });
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "user.invited",
      entityType: "user",
      metadata: {
        invitedUserId: user.id,
        email: user.email,
        role,
        inviteEmailSent: inviteEmail.sent,
      },
    });
    res.status(201).json({ ...memberDto(user), inviteEmail });
  },
);

router.post(
  "/users/:id/resend-invite",
  requireMember("users.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const actor = req.member!;
    const [target] = await db
      .select()
      .from(usersTable)
      .where(
        and(
          eq(usersTable.id, String(req.params.id)),
          eq(usersTable.organizationId, actor.organizationId),
        ),
      );
    if (!target) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    if (!target.id.startsWith("invite:")) {
      res.status(400).json({ error: "This member is not a pending invite" });
      return;
    }
    if (!target.email) {
      res.status(400).json({ error: "Pending invite has no email address" });
      return;
    }
    // Cooldown: one resend per invite per minute, shared across instances,
    // so a stuck button or rapid clicks can't spam the invitee.
    const cooldown = await consumeCooldown({
      key: `invite-resend:${actor.organizationId}:${target.id}`,
      windowMs: 60_000,
    });
    if (!cooldown.allowed) {
      res
        .status(429)
        .setHeader(
          "Retry-After",
          String(Math.ceil(cooldown.retryAfterMs / 1000)),
        )
        .json({
          error: "Invite was just resent. Please wait a minute before trying again.",
        });
      return;
    }
    const inviterName =
      [actor.user.firstName, actor.user.lastName].filter(Boolean).join(" ") ||
      actor.user.email ||
      "A teammate";
    const result = await sendInviteEmail({
      organizationId: actor.organizationId,
      to: target.email,
      inviteeFirstName: target.firstName,
      inviterName,
      role: target.role,
    });
    await recordAudit({
      organizationId: actor.organizationId,
      actorUserId: actor.user.id,
      action: "user.invite_resent",
      entityType: "user",
      metadata: {
        invitedUserId: target.id,
        email: target.email,
        inviteEmailSent: result.sent,
        ...(result.error ? { inviteEmailError: result.error } : {}),
      },
    });
    res.json(result);
  },
);

router.patch(
  "/users/:id",
  requireMember("users.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdateUserBody.safeParse(req.body);
    if (!parsed.success || (parsed.data.role === undefined && parsed.data.isActive === undefined)) {
      res.status(400).json({ error: "Invalid change" });
      return;
    }
    const actor = req.member!;
    if (String(req.params.id) === actor.user.id) {
      res.status(403).json({ error: "You cannot change your own role or status" });
      return;
    }
    const [target] = await db
      .select()
      .from(usersTable)
      .where(
        and(
          eq(usersTable.id, String(req.params.id)),
          eq(usersTable.organizationId, actor.organizationId),
        ),
      );
    if (!target) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    if ((target.role === "owner" || parsed.data.role === "owner") && actor.role !== "owner") {
      res.status(403).json({ error: "Only the owner can change owner membership" });
      return;
    }
    const [updated] = await db
      .update(usersTable)
      .set({
        ...(parsed.data.role !== undefined ? { role: parsed.data.role } : {}),
        ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
      })
      .where(eq(usersTable.id, target.id))
      .returning();
    await recordAudit({
      organizationId: actor.organizationId,
      actorUserId: actor.user.id,
      action: "user.updated",
      entityType: "user",
      metadata: {
        targetUserId: target.id,
        ...(parsed.data.role !== undefined ? { roleFrom: target.role, roleTo: parsed.data.role } : {}),
        ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
      },
    });
    res.json(memberDto(updated));
  },
);

export default router;
