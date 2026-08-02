import { apiKeysTable, db } from "@workspace/db";
import { eq } from "drizzle-orm";

import { logger } from "../lib/logger";

import { orgAdminEmails } from "./api-key-expiry-reminder";
import { recordAudit } from "./audit";
import { providers } from "./providers";

/** Email every active owner/admin of an org about the blocked attack. */
async function emailOrgAdmins(
  organizationId: string,
  params: { ip: string; windowMs: number; maxFailures: number },
): Promise<void> {
  const recipients = await orgAdminEmails(organizationId);
  if (recipients.length === 0) {
    logger.warn(
      { organizationId },
      "brute-force alert: no admin recipients for org",
    );
    return;
  }
  const minutes = Math.round(params.windowMs / 60000);
  const subject = "Security alert: API key guessing attempts blocked";
  const body = [
    `We blocked the IP address ${params.ip} after ${params.maxFailures} invalid API key attempts within ${minutes} minutes.`,
    "",
    "Someone may be trying to guess API keys. Your keys were not compromised by these blocked attempts, but as a precaution you may want to:",
    "- Review your API keys and rotate any that may be exposed.",
    "- Check the audit log for unusual activity.",
    "",
    "You can manage API keys in the Command Center under Settings → API keys.",
  ].join("\n");
  for (const to of recipients) {
    try {
      await providers.email.send(to, subject, body);
    } catch (err) {
      // One bad mailbox must not block the remaining admins.
      logger.error({ err, to, organizationId }, "brute-force alert: send failed");
    }
  }
}

/**
 * Called once per block window when an IP crosses the OIDC / mobile login
 * failure threshold (see invalidAuthAttemptLimiter in auth.ts).
 *
 * Login attempts carry no org context, so the event is recorded — and org
 * admins are emailed — for every organization that has an active API key;
 * those are the configured, active orgs whose admins should be aware of a
 * sustained attack against the login page. Mirrors the scoping used by
 * reportApiKeyBruteForceBlock. Because the limiter reports a block only once
 * per window, admins get at most one email per block window. Never throws:
 * alerting must not affect request handling.
 */
export async function reportCallbackBruteForceBlock(params: {
  ip: string;
  windowMs: number;
  maxFailures: number;
}): Promise<void> {
  try {
    console.warn(
      `[security] IP ${params.ip} blocked after ${params.maxFailures} invalid login attempts within ${Math.round(params.windowMs / 60000)} minutes`,
    );
    const orgs = await db
      .selectDistinct({ organizationId: apiKeysTable.organizationId })
      .from(apiKeysTable)
      .where(eq(apiKeysTable.isActive, true));
    await Promise.all(
      orgs.map(async (o) => {
        await recordAudit({
          organizationId: o.organizationId,
          action: "auth.brute_force_blocked",
          entityType: "session",
          metadata: {
            ip: params.ip,
            maxFailures: params.maxFailures,
            windowMs: params.windowMs,
          },
        });
        await emailOrgAdminsLoginBlock(o.organizationId, params);
      }),
    );
  } catch (err) {
    console.error("[security] failed to record login brute-force audit event", err);
  }
}

/** Email every active owner/admin of an org about the blocked login attack. */
async function emailOrgAdminsLoginBlock(
  organizationId: string,
  params: { ip: string; windowMs: number; maxFailures: number },
): Promise<void> {
  const recipients = await orgAdminEmails(organizationId);
  if (recipients.length === 0) {
    logger.warn(
      { organizationId },
      "login brute-force alert: no admin recipients for org",
    );
    return;
  }
  const minutes = Math.round(params.windowMs / 60000);
  const subject = "Security alert: Login attempts blocked";
  const body = [
    `We blocked the IP address ${params.ip} after ${params.maxFailures} failed login attempts within ${minutes} minutes.`,
    "",
    "Someone may be trying to guess login credentials. As a precaution you may want to:",
    "- Review your team's accounts and ensure strong passwords are in use.",
    "- Check the audit log for unusual activity.",
    "",
    "You can review activity in the Command Center under Settings → Audit log.",
  ].join("\n");
  for (const to of recipients) {
    try {
      await providers.email.send(to, subject, body);
    } catch (err) {
      // One bad mailbox must not block the remaining admins.
      logger.error({ err, to, organizationId }, "login brute-force alert: send failed");
    }
  }
}

/**
 * Called once per block window when an IP crosses the invalid-API-key
 * failure threshold (see invalidApiKeyLimiter in requireMember).
 *
 * Invalid keys carry no org context, so the event is recorded — and org
 * admins are emailed — for every organization that has an active API key;
 * those are the admins who need to spot the attack and rotate keys early.
 * Because the limiter reports a block only once per window, admins get at
 * most one email per block window. Never throws: alerting must not affect
 * request handling.
 */
export async function reportApiKeyBruteForceBlock(params: {
  ip: string;
  windowMs: number;
  maxFailures: number;
}): Promise<void> {
  try {
    console.warn(
      `[security] IP ${params.ip} blocked after ${params.maxFailures} invalid API key attempts within ${Math.round(params.windowMs / 60000)} minutes`,
    );
    const orgs = await db
      .selectDistinct({ organizationId: apiKeysTable.organizationId })
      .from(apiKeysTable)
      .where(eq(apiKeysTable.isActive, true));
    await Promise.all(
      orgs.map(async (o) => {
        await recordAudit({
          organizationId: o.organizationId,
          action: "api_key.brute_force_blocked",
          entityType: "api_key",
          metadata: {
            ip: params.ip,
            maxFailures: params.maxFailures,
            windowMs: params.windowMs,
          },
        });
        await emailOrgAdmins(o.organizationId, params);
      }),
    );
  } catch (err) {
    console.error("[security] failed to record API-key brute-force audit event", err);
  }
}
