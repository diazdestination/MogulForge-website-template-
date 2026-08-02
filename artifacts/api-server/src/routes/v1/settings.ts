import { UpdateSettingsBody } from "@workspace/api-zod";
import { Router, type IRouter, type Request, type Response } from "express";
import { clearReviewCache } from "./google-reviews";
import { hasPermission } from "../../lib/permissions";

import { requireMember } from "../../middlewares/requireMember";
import { recordAudit } from "../../services/audit";
import { getEmailSendHealth } from "../../services/automation";
import {
  getEmailProviderStatus,
  getSmsProviderStatus,
} from "../../services/providers";
import {
  getInspectionAvailability,
  getOrgSettings,
  updateOrgSettings,
} from "../../services/settings";
import type { OrgSettings } from "@workspace/db";

/**
 * Mask a Google Places API key so it cannot be read back verbatim.
 * Shows the first 4 and last 4 characters with bullets in between so admins
 * can confirm which key is saved without being able to extract it.
 */
function maskApiKey(key: string): string {
  if (key.length <= 8) return "••••••••";
  return key.slice(0, 4) + "••••••••" + key.slice(-4);
}

/**
 * Returns true when the value is the masked sentinel returned by the API
 * (i.e. the admin did not change the key and we should keep the stored one).
 * An explicitly empty value is NOT treated as "keep existing" — it means the
 * admin intentionally cleared the field to remove the stored key.
 */
function isMaskedSentinel(value: string | undefined | null): boolean {
  return typeof value === "string" && value.includes("••••");
}

/**
 * Apply API-key masking to a settings object before sending it to the client.
 * Admins (settings.manage) see a masked key; non-admins never see the key.
 */
function applyApiKeyMask(settings: OrgSettings, isAdmin: boolean): OrgSettings {
  if (!settings.googleReviews?.apiKey) return settings;
  const { googleReviews, ...rest } = settings;
  if (!isAdmin) {
    return { ...rest, googleReviews: googleReviews ? { placeId: googleReviews.placeId } : null };
  }
  return {
    ...rest,
    googleReviews: { ...googleReviews, apiKey: maskApiKey(googleReviews.apiKey!) },
  };
}

const router: IRouter = Router();

// Which email provider automations use right now, (for Gmail) the connected
// account messages are sent from, and whether recent send_email automation
// runs are failing. Settings surface → admin-only.
router.get(
  "/settings/email-provider",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const [status, sendHealth] = await Promise.all([
      getEmailProviderStatus(),
      getEmailSendHealth(req.member!.organizationId),
    ]);
    res.json({
      ...status,
      recentSendFailures: sendHealth.consecutiveFailures,
      lastSendFailureAt: sendHealth.lastFailureAt,
      lastSendFailureDetail: sendHealth.lastFailureDetail,
    });
  },
);

// Which SMS provider automations use right now and (for Twilio) the sending
// phone number. Settings surface → admin-only.
router.get(
  "/settings/sms-provider",
  requireMember("settings.manage"),
  (_req: Request, res: Response): void => {
    res.json(getSmsProviderStatus());
  },
);

// Effective inspection availability (defaults merged with any org override,
// sanitized). Read-only and needed by anyone booking appointments in the CRM,
// so it's crm.read rather than settings.manage.
router.get(
  "/settings/inspection-availability",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    res.json(await getInspectionAvailability(req.member!.organizationId));
  },
);

router.get(
  "/settings",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const settings = await getOrgSettings(req.member!.organizationId);
    const isAdmin = hasPermission(req.member!.role, "settings.manage");
    res.json(applyApiKeyMask(settings, isAdmin));
  },
);

router.put(
  "/settings",
  requireMember("settings.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = UpdateSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid settings" });
      return;
    }
    const { securityAlertsAcknowledgedAt, ...rest } = parsed.data;
    let acknowledgedAt: Date | undefined;
    if (securityAlertsAcknowledgedAt !== undefined) {
      const ts = new Date(securityAlertsAcknowledgedAt);
      if (Number.isNaN(ts.getTime())) {
        res.status(400).json({ error: "Invalid settings" });
        return;
      }
      // Never acknowledge into the future — that would silently dismiss
      // alerts for attacks that haven't happened yet.
      acknowledgedAt = ts.getTime() > Date.now() ? new Date() : ts;
    }
    // When the admin submits the masked sentinel they didn't change the key —
    // preserve the stored key instead of overwriting with the mask string.
    // An explicitly empty or absent apiKey means "clear the key" (intentional).
    let patch = rest as Parameters<typeof updateOrgSettings>[1];
    if (patch.googleReviews != null && isMaskedSentinel(patch.googleReviews.apiKey)) {
      const existing = await getOrgSettings(req.member!.organizationId);
      patch = {
        ...patch,
        googleReviews: {
          ...patch.googleReviews,
          apiKey: existing.googleReviews?.apiKey,
        },
      };
    }
    const settings = await updateOrgSettings(req.member!.organizationId, {
      ...patch,
      ...(acknowledgedAt !== undefined
        ? { securityAlertsAcknowledgedAt: acknowledgedAt }
        : {}),
    });
    // If Google Reviews credentials changed, bust the in-memory cache so the
    // next public request fetches fresh reviews with the new credentials.
    if (parsed.data.googleReviews !== undefined) {
      clearReviewCache();
    }
    await recordAudit({
      organizationId: req.member!.organizationId,
      actorUserId: req.member!.user.id,
      action: "settings.updated",
      entityType: "org_settings",
      entityId: settings.id,
      metadata: { fields: Object.keys(parsed.data) },
    });
    // Never return the raw API key — apply the same masking as GET /settings.
    res.json(applyApiKeyMask(settings, true));
  },
);

export default router;
