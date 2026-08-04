import {
  AttachLeadPhotosBody,
  BulkUpdateLeadsBody,
  SendLeadEmailBody,
  CreateLeadActivityBody,
  CreateLeadBody,
  CreateSavedFilterBody,
  CorrectWonRevenueBody,
  MergeLeadBody,
  UpdateLeadBody,
  RequestPublicUploadUrlBody,
  DeleteLeadPhotoBody,
  RecordNextActionFeedbackBody,
} from "@workspace/api-zod";
import {
  ObjectStorageService,
} from "../../lib/objectStorage";
import { validatePhotoObjects } from "../../lib/photoValidation";
import { Router, type IRouter, type Request, type Response } from "express";

import { beginIdempotent, releaseIdempotent, storeIdempotent } from "../../lib/idempotency";
import { requireMember } from "../../middlewares/requireMember";
import { getLeadBehaviorSummary } from "../../services/attribution";
import { recordAudit } from "../../services/audit";
import { emitAutomationEvent } from "../../services/automation";
import { listLeadConversations } from "../../services/concierge";
import * as crm from "../../services/crm";
import { correctWonRevenue } from "../../services/post-sale";
import {
  getNextBestAction,
  listTodayActions,
  recordActionFeedback,
} from "../../services/next-best-action";
import { notifyHomeownerOfTeamReply } from "../../services/portal-message-email";
import {
  gmailEmailProvider,
  isGmailConfigured,
} from "../../services/providers";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

router.get(
  "/leads",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(
      await crm.listLeads(req.member!.organizationId, {
        status:
          typeof req.query.status === "string" ? req.query.status : undefined,
        assignedUserId:
          typeof req.query.assignedUserId === "string"
            ? req.query.assignedUserId
            : undefined,
        source:
          typeof req.query.source === "string" ? req.query.source : undefined,
        search:
          typeof req.query.search === "string" ? req.query.search : undefined,
        limit:
          typeof req.query.limit === "string" && req.query.limit !== ""
            ? Number(req.query.limit)
            : undefined,
        offset:
          typeof req.query.offset === "string" && req.query.offset !== ""
            ? Number(req.query.offset)
            : undefined,
        hasUnreadPortalMessage:
          req.query.hasUnreadPortalMessage === "true" ? true : undefined,
      }),
    );
  },
);

router.post(
  "/leads",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateLeadBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid lead" });
      return;
    }
    // Programmatic API idempotency: a retried request replays the stored
    // response instead of creating a duplicate lead.
    if (!(await beginIdempotent(req, res, "leads.create"))) return;
    const lead = await crm.createLead(req.member!.organizationId, parsed.data);
    if (!lead) {
      // The work failed — release the reservation so a corrected retry with
      // the same key can run instead of getting stuck behind a placeholder.
      await releaseIdempotent(req, "leads.create");
      res.status(400).json({ error: "Contact not found in your organization" });
      return;
    }
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "lead.created",
      entityType: "lead",
      entityId: lead.id,
    });
    emitAutomationEvent(req.member!.organizationId, "lead.created", {
      leadId: lead.id,
      contactId: lead.contactId,
      actorUserId: req.member!.user.id,
      fields: {
        "lead.status": lead.status,
        "lead.urgency": lead.urgency,
        "lead.source": lead.source,
      },
    });
    await storeIdempotent(req, "leads.create", 201, lead);
    res.status(201).json(lead);
  },
);

router.post(
  "/leads/bulk",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = BulkUpdateLeadsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid bulk action" });
      return;
    }
    const { leadIds, action } = parsed.data;
    const provided = [
      action.status !== undefined,
      action.assignedUserId !== undefined,
      action.tagId !== undefined,
    ].filter(Boolean).length;
    if (provided !== 1) {
      res.status(400).json({
        error: "Provide exactly one of status, assignedUserId, or tagId",
      });
      return;
    }

    let updatedIds: string[] | null;
    let auditAction: string;
    let metadata: Record<string, unknown>;
    if (action.tagId !== undefined) {
      updatedIds = await crm.bulkTagLeads(
        req.member!.organizationId,
        leadIds,
        action.tagId,
      );
      auditAction = "lead.bulk_tagged";
      metadata = { tagId: action.tagId };
    } else {
      updatedIds = await crm.bulkUpdateLeads(req.member!.organizationId, leadIds, {
        status: action.status,
        assignedUserId: action.assignedUserId,
      });
      auditAction =
        action.status !== undefined
          ? "lead.bulk_status_changed"
          : "lead.bulk_assigned";
      metadata =
        action.status !== undefined
          ? { status: action.status }
          : { assignedUserId: action.assignedUserId };
    }
    if (updatedIds === null) {
      res.status(400).json({ error: "Referenced user or tag not found in your organization" });
      return;
    }
    for (const leadId of updatedIds) {
      await recordAudit({
        organizationId: req.member!.organizationId,
        actorUserId: req.member!.user.id,
        action: auditAction,
        entityType: "lead",
        entityId: leadId,
        metadata: { ...metadata, bulkCount: updatedIds.length },
      });
    }
    res.json({ updated: updatedIds.length, skipped: leadIds.length - updatedIds.length });
  },
);

router.get(
  "/leads/duplicates",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(await crm.findDuplicateLeadGroups(req.member!.organizationId));
  },
);

router.get(
  "/saved-filters",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(
      await crm.listSavedFilters(
        req.member!.organizationId,
        req.member!.user.id,
      ),
    );
  },
);

router.post(
  "/saved-filters",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateSavedFilterBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid saved filter" });
      return;
    }
    const filter = await crm.createSavedFilter(
      req.member!.organizationId,
      req.member!.user.id,
      { name: parsed.data.name, filters: parsed.data.filters ?? {} },
    );
    res.status(201).json(filter);
  },
);

router.delete(
  "/saved-filters/:id",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const deleted = await crm.deleteSavedFilter(
      req.member!.organizationId,
      req.member!.user.id,
      String(req.params.id),
    );
    if (!deleted) {
      res.status(404).json({ error: "Saved filter not found" });
      return;
    }
    res.status(204).end();
  },
);

// ---------- next-best-action copilot ----------

router.get(
  "/next-actions",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(
      await listTodayActions(req.member!.organizationId, {
        limit:
          typeof req.query.limit === "string" && req.query.limit !== ""
            ? Number(req.query.limit)
            : undefined,
      }),
    );
  },
);

router.get(
  "/leads/:id/next-action",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const action = await getNextBestAction(
      req.member!.organizationId,
      String(req.params.id),
    );
    if (!action) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    res.json(action);
  },
);

router.post(
  "/leads/:id/next-action/feedback",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = RecordNextActionFeedbackBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid feedback" });
      return;
    }
    const ok = await recordActionFeedback(
      req.member!.organizationId,
      String(req.params.id),
      req.member!.user.id,
      parsed.data,
    );
    if (!ok) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    res.status(204).end();
  },
);

router.get(
  "/leads/:id",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const lead = await crm.getLead(req.member!.organizationId, String(req.params.id));
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    res.json(lead);
  },
);

router.get(
  "/leads/:id/behavior",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const summary = await getLeadBehaviorSummary(
      req.member!.organizationId,
      String(req.params.id),
    );
    if (!summary) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    res.json(summary);
  },
);

router.patch(
  "/leads/:id",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdateLeadBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid lead update" });
      return;
    }
    // Snapshot the prior status so downstream consumers (webhook mirror) can
    // distinguish a real transition from a no-op update to a terminal lead.
    const before = await crm.getLead(req.member!.organizationId, String(req.params.id));
    const lead = await crm.updateLead(
      req.member!.organizationId,
      String(req.params.id),
      parsed.data as Record<string, never>,
    );
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    if (parsed.data.status) {
      await recordAudit({
        organizationId: req.member!.organizationId,
        actorUserId: req.member!.user.id,
        action: "lead.status_changed",
        entityType: "lead",
        entityId: lead.id,
        metadata: { status: parsed.data.status },
      });
    }
    emitAutomationEvent(
      req.member!.organizationId,
      parsed.data.assignedUserId ? "lead.assigned" : "lead.updated",
      {
        leadId: lead.id,
        contactId: lead.contactId,
        actorUserId: req.member!.user.id,
        fields: {
          "lead.status": lead.status,
          "lead.urgency": lead.urgency,
          "lead.assignedUserId": lead.assignedUserId,
          "lead.statusChanged": Boolean(before && before.status !== lead.status),
        },
      },
    );
    res.json(lead);
  },
);

router.post(
  "/leads/:id/merge",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = MergeLeadBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid merge request" });
      return;
    }
    const survivorId = String(req.params.id);
    const result = await crm.mergeLeads(
      req.member!.organizationId,
      survivorId,
      parsed.data.sourceLeadId,
      req.member!.user.id,
    );
    if (!result.ok) {
      if (result.error === "same_lead") {
        res.status(400).json({ error: "Cannot merge a lead into itself" });
      } else {
        res.status(404).json({ error: "Lead not found" });
      }
      return;
    }
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "lead.merged",
      entityType: "lead",
      entityId: survivorId,
      metadata: {
        sourceLeadId: parsed.data.sourceLeadId,
        movedActivities: result.movedActivities,
        movedTags: result.movedTags,
        movedAppointments: result.movedAppointments,
        movedTasks: result.movedTasks,
        movedEstimates: result.movedEstimates,
        movedProjects: result.movedProjects,
        movedConversations: result.movedConversations,
      },
    });
    res.json(result.lead);
  },
);

router.get(
  "/leads/:id/activities",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const lead = await crm.getLead(req.member!.organizationId, String(req.params.id));
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    res.json(
      await crm.listLeadActivities(req.member!.organizationId, String(req.params.id)),
    );
  },
);

router.get(
  "/leads/:id/conversations",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const lead = await crm.getLead(req.member!.organizationId, String(req.params.id));
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    res.json(
      await listLeadConversations(req.member!.organizationId, lead.id),
    );
  },
);

router.post(
  "/leads/:id/activities",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateLeadActivityBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid activity" });
      return;
    }
    const lead = await crm.getLead(req.member!.organizationId, String(req.params.id));
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    if (!(await beginIdempotent(req, res, "leads.activity"))) return;
    const activity = await crm.createActivity(req.member!.organizationId, {
      leadId: lead.id,
      contactId: lead.contactId,
      actorUserId: req.member!.user.id,
      type: parsed.data.type,
      title: parsed.data.title,
      body: parsed.data.body ?? null,
      metadata: parsed.data.metadata ?? {},
    });
    if (parsed.data.type === "team_message") {
      // Fire-and-forget: never throws, and must not block the reply itself.
      void notifyHomeownerOfTeamReply({
        organizationId: req.member!.organizationId,
        leadId: lead.id,
        messageContent: parsed.data.body?.trim() || parsed.data.title,
        activityId: activity.id,
      });
    }
    await storeIdempotent(req, "leads.activity", 201, activity);
    res.status(201).json(activity);
  },
);

router.post(
  "/leads/:id/send-email",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = SendLeadEmailBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid email" });
      return;
    }
    const lead = await crm.getLead(req.member!.organizationId, String(req.params.id));
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    const contact = await crm.getContact(
      req.member!.organizationId,
      lead.contactId,
    );
    if (!contact?.email) {
      res.status(400).json({ error: "This lead's contact has no email address" });
      return;
    }
    if (!isGmailConfigured()) {
      res.status(503).json({
        error:
          "Gmail is not connected. Connect the Gmail integration to send emails from the CRM.",
      });
      return;
    }

    const subject = parsed.data.subject.trim();
    const body = parsed.data.body.trim();
    if (!subject || !body) {
      res.status(400).json({ error: "Subject and body are required" });
      return;
    }

    let sent: { id: string; provider: string };
    try {
      sent = await gmailEmailProvider.send(contact.email, subject, body);
    } catch (err) {
      console.error("[leads] Gmail send failed:", err);
      res.status(502).json({
        error:
          err instanceof Error && err.message.includes("invalid recipient")
            ? "The contact's email address is not a valid recipient"
            : "Sending the email through Gmail failed. Try again in a moment.",
      });
      return;
    }

    const activity = await crm.createActivity(req.member!.organizationId, {
      leadId: lead.id,
      contactId: lead.contactId,
      actorUserId: req.member!.user.id,
      type: "lead_email_sent",
      title: `Email sent: ${subject}`,
      body: body.length > 300 ? `${body.slice(0, 300)}…` : body,
      metadata: {
        channel: "email",
        to: contact.email,
        subject,
        provider: sent.provider,
        providerMessageId: sent.id,
        source: "crm-compose",
      },
    });
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "lead.email_sent",
      entityType: "lead",
      entityId: lead.id,
      metadata: { to: contact.email, subject, provider: sent.provider },
    });
    res.status(201).json(activity);
  },
);

// ---------- Won-revenue correction (admin only) ----------

router.patch(
  "/leads/:id/won-revenue",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = CorrectWonRevenueBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body: wonRevenueCents must be a non-negative integer or null" });
      return;
    }
    const result = await correctWonRevenue(
      req.member!.organizationId,
      String(req.params.id),
      parsed.data.wonRevenueCents,
    );
    if (!result.ok) {
      if (result.error === "not_found") {
        res.status(404).json({ error: "Lead not found" });
      } else {
        res.status(409).json({ error: "Lead has not been won yet; there is no revenue record to correct" });
      }
      return;
    }
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "lead.won_revenue_corrected",
      entityType: "lead",
      entityId: String(req.params.id),
      metadata: {
        previousCents: result.previousCents,
        newCents: parsed.data.wonRevenueCents,
      },
    });
    res.status(204).end();
  },
);

// ---------- Rep photo upload ----------

router.post(
  "/leads/:id/photos/request-url",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = RequestPublicUploadUrlBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Missing or invalid required fields" });
      return;
    }
    const lead = await crm.getLead(req.member!.organizationId, String(req.params.id));
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    try {
      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);
      res.json({ uploadURL, objectPath });
    } catch (error) {
      req.log.error({ err: error }, "Error generating rep photo upload URL");
      res.status(500).json({ error: "Failed to generate upload URL" });
    }
  },
);

router.post(
  "/leads/:id/photos",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = AttachLeadPhotosBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid photo paths" });
      return;
    }
    const lead = await crm.getLead(req.member!.organizationId, String(req.params.id));
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    const validation = await validatePhotoObjects(
      objectStorageService,
      parsed.data.photoPaths,
    );
    if (!validation.ok) {
      res.status(400).json({ error: validation.reason });
      return;
    }
    const n = parsed.data.photoPaths.length;
    const activity = await crm.createActivity(req.member!.organizationId, {
      leadId: lead.id,
      contactId: lead.contactId,
      actorUserId: req.member!.user.id,
      type: "photos_attached",
      title: `Rep attached ${n} photo${n === 1 ? "" : "s"}`,
      body: null,
      metadata: { photoPaths: parsed.data.photoPaths },
    });
    res.status(201).json(activity);
  },
);

router.delete(
  "/leads/:id/photos",
  requireMember("crm.write"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = DeleteLeadPhotoBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Missing or invalid objectPath" });
      return;
    }
    const lead = await crm.getLead(req.member!.organizationId, String(req.params.id));
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    const removed = await crm.removeLeadPhoto(
      req.member!.organizationId,
      lead.id,
      parsed.data.objectPath,
    );
    if (!removed) {
      res.status(400).json({ error: "Photo not found on this lead" });
      return;
    }
    res.status(204).end();
  },
);

export default router;
