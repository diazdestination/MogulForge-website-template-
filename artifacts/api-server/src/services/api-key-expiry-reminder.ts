/**
 * Pre-expiry reminder for org API keys.
 *
 * Once a key's expiresAt falls within the reminder window, org admins get a
 * single heads-up email so they can rotate the key before the integration
 * silently stops working. Sent-once semantics: a key is atomically "claimed"
 * by setting expiry_reminder_sent_at (update ... where null ... returning)
 * before any email goes out, so concurrent scheduler ticks or repeated runs
 * never double-send for the same key. If no email is actually delivered for a
 * claimed key (provider outage, all mailboxes bad, no recipients), the claim
 * is released so a later tick retries instead of expiring silently.
 */
import { apiKeysTable, db, usersTable, type ApiKey } from "@workspace/db";
import { and, eq, gt, inArray, isNull, lte } from "drizzle-orm";

import { logger } from "../lib/logger";

import { isSafeMailbox, providers } from "./providers";

/** How many days before expiry the reminder goes out. */
export const API_KEY_EXPIRY_REMINDER_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

function formatWhenExpires(expiresAt: Date, now: Date): string {
  const days = Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS);
  const dateText = expiresAt.toISOString().slice(0, 10);
  if (days <= 0) return `today (${dateText})`;
  if (days === 1) return `tomorrow (${dateText})`;
  return `in ${days} days (${dateText})`;
}

/** Usable email addresses of an org's active owners/admins. */
export async function orgAdminEmails(organizationId: string): Promise<string[]> {
  const admins = await db
    .select({ email: usersTable.email })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.organizationId, organizationId),
        eq(usersTable.isActive, true),
        inArray(usersTable.role, ["owner", "admin"]),
      ),
    );
  return admins
    .map((a) => a.email?.trim() ?? "")
    .filter((email) => email.length > 0 && isSafeMailbox(email));
}

/**
 * Emails the org's admins about the key's upcoming expiry. Returns true when
 * at least one email was successfully handed to the provider — the caller
 * uses this to decide whether the claim may be kept.
 */
async function sendReminderForKey(key: ApiKey, now: Date): Promise<boolean> {
  if (!key.expiresAt) return false;
  const recipients = await orgAdminEmails(key.organizationId);
  if (recipients.length === 0) {
    logger.warn(
      { apiKeyId: key.id, organizationId: key.organizationId },
      "api-key expiry reminder: no admin recipients",
    );
    // Nothing was delivered; release the claim so the reminder still goes
    // out if an admin (or a fixable mailbox) shows up before expiry.
    return false;
  }
  const whenText = formatWhenExpires(key.expiresAt, now);
  const subject = `API key "${key.name}" expires ${whenText}`;
  const body = [
    `The API key "${key.name}" (${key.prefix}…) expires ${whenText}.`,
    "",
    "After that moment, any integration using this key will stop working.",
    "To avoid an interruption, create a replacement key and update the",
    "integration before the expiry date, then revoke the old key.",
    "",
    "You can manage API keys in the Command Center under Settings → API keys.",
  ].join("\n");
  let delivered = 0;
  for (const to of recipients) {
    try {
      await providers.email.send(to, subject, body);
      delivered += 1;
    } catch (err) {
      // One bad mailbox must not block the remaining admins.
      logger.error(
        { err, to, apiKeyId: key.id },
        "api-key expiry reminder: send failed",
      );
    }
  }
  return delivered > 0;
}

/**
 * Find active keys expiring within the reminder window that have not been
 * reminded about yet, claim them, and email org admins. Returns the claimed
 * keys (useful for tests/observability).
 */
export async function processApiKeyExpiryReminders(
  withinDays = API_KEY_EXPIRY_REMINDER_DAYS,
  now = new Date(),
): Promise<ApiKey[]> {
  const windowEnd = new Date(now.getTime() + withinDays * DAY_MS);
  // Atomically claim eligible keys so a reminder is sent at most once even
  // if two scheduler instances tick at the same time.
  const claimed = await db
    .update(apiKeysTable)
    .set({ expiryReminderSentAt: now })
    .where(
      and(
        eq(apiKeysTable.isActive, true),
        isNull(apiKeysTable.revokedAt),
        isNull(apiKeysTable.expiryReminderSentAt),
        gt(apiKeysTable.expiresAt, now),
        lte(apiKeysTable.expiresAt, windowEnd),
      ),
    )
    .returning();
  for (const key of claimed) {
    const deliveredAny = await sendReminderForKey(key, now);
    if (!deliveredAny) {
      // No admin actually got the warning (provider outage, all sends
      // failed, or no usable recipients). Release the claim so a later tick
      // retries; the guard on expiryReminderSentAt = our claim timestamp
      // keeps us from clobbering a newer claim or a cleared marker.
      await db
        .update(apiKeysTable)
        .set({ expiryReminderSentAt: null })
        .where(
          and(
            eq(apiKeysTable.id, key.id),
            eq(apiKeysTable.expiryReminderSentAt, now),
          ),
        );
      logger.warn(
        { apiKeyId: key.id, organizationId: key.organizationId },
        "api-key expiry reminder: no email delivered, claim released for retry",
      );
    }
  }
  return claimed;
}
