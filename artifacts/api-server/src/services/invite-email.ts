/**
 * Invite notification email: lets a newly invited teammate know they have
 * access and where to sign in. Send failures are reported to the inviting
 * admin (never silent) but do not roll back the invite itself.
 */
import { logger } from "../lib/logger";

import { isSafeMailbox, providers } from "./providers";
import { getOrgSettings } from "./settings";

/**
 * Absolute URL of the CRM app the invitee should sign in to.
 * APP_URL wins when set; otherwise derive from the Replit domain for this
 * environment (production deployments expose the published domain here).
 */
export function crmAppUrl(): string {
  const override = process.env.APP_URL?.trim();
  if (override) return override.replace(/\/$/, "");
  const domain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  if (domain) return `https://${domain}/crm/`;
  return "http://localhost:5000/crm/";
}

export interface InviteEmailResult {
  sent: boolean;
  error: string | null;
}

export async function sendInviteEmail(params: {
  organizationId: string;
  to: string;
  inviteeFirstName?: string | null;
  inviterName: string;
  role: string;
}): Promise<InviteEmailResult> {
  try {
    if (!isSafeMailbox(params.to)) {
      return { sent: false, error: "Invalid recipient email address" };
    }
    const settings = await getOrgSettings(params.organizationId);
    const businessName =
      settings.businessProfile?.businessName?.trim() || "Painless Roofing";
    const url = crmAppUrl();
    const roleLabel = params.role.replace(/_/g, " ");
    const body = [
      `Hi ${params.inviteeFirstName?.trim() || "there"},`,
      "",
      `${params.inviterName} invited you to join the ${businessName} team as ${roleLabel}.`,
      "",
      `You already have access — just sign in with this email address (${params.to}) to get started:`,
      url,
      "",
      `If you weren't expecting this invitation, you can ignore this email.`,
      "",
      `— ${businessName}`,
    ].join("\n");
    await providers.email.send(
      params.to,
      `You've been invited to the ${businessName} team`,
      body,
    );
    return { sent: true, error: null };
  } catch (err) {
    logger.error({ err }, "invite: failed to send invite email");
    return {
      sent: false,
      error: err instanceof Error ? err.message : "Failed to send invite email",
    };
  }
}
