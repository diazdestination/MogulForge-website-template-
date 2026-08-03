import {
  consentRecordsTable,
  contactsTable,
  db,
  leadsTable,
  playbookEnrollmentsTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { createHmac } from "node:crypto";

import { rateLimit } from "../../lib/rateLimit";
import { recordAudit } from "../../services/audit";
import { stopEnrollmentsForLead } from "../../services/playbooks";
import {
  addSuppression,
  normalizePhone,
  parseUnsubscribeToken,
  publicBaseUrl,
  removeSuppression,
} from "../../services/send-gate";

/**
 * Public opt-out endpoints (no auth — recipients are not CRM users):
 *
 * - GET  /public/unsubscribe/:token  → confirmation landing page
 * - POST /public/unsubscribe/:token  → records the email unsubscribe
 * - POST /public/sms/inbound         → Twilio inbound webhook: STOP keywords
 *                                      suppress the number, START re-enables
 *
 * The unsubscribe token is an HMAC over (org, contact) — unguessable, no DB
 * state, and safe to expose in every outbound email footer.
 */
const router: IRouter = Router();

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:64px auto;padding:0 20px;line-height:1.6;color:#1a1a1a}button{background:#1a1a1a;color:#fff;border:0;border-radius:8px;padding:12px 24px;font-size:16px;cursor:pointer}p{color:#444}</style></head>
<body>${body}</body>
</html>`;
}

router.get(
  "/public/unsubscribe/:token",
  rateLimit({ windowMs: 60_000, max: 30, key: "unsubscribe" }),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = parseUnsubscribeToken(String(req.params.token ?? ""));
    if (!parsed) {
      res
        .status(404)
        .send(page("Link not valid", "<h1>This link isn't valid</h1><p>The unsubscribe link may be incomplete — try copying the full link from the email.</p>"));
      return;
    }
    // Confirmation step so mail scanners that prefetch links can't
    // unsubscribe people by accident; the POST does the actual work.
    res.status(200).setHeader("Cache-Control", "no-store").send(
      page(
        "Unsubscribe",
        `<h1>Unsubscribe from emails</h1>
<p>You'll stop receiving automated emails at this address. You can still be contacted about appointments you book.</p>
<form method="POST" action=""><button type="submit">Unsubscribe</button></form>`,
      ),
    );
  },
);

router.post(
  "/public/unsubscribe/:token",
  rateLimit({ windowMs: 60_000, max: 10, key: "unsubscribe-post" }),
  async (req: Request, res: Response): Promise<void> => {
    const parsed = parseUnsubscribeToken(String(req.params.token ?? ""));
    if (!parsed) {
      res.status(404).send(page("Link not valid", "<h1>This link isn't valid</h1>"));
      return;
    }
    const { organizationId, contactId } = parsed;
    const [contact] = await db
      .select()
      .from(contactsTable)
      .where(
        and(
          eq(contactsTable.id, contactId),
          eq(contactsTable.organizationId, organizationId),
        ),
      );
    if (contact?.email) {
      await addSuppression({
        organizationId,
        channel: "email",
        value: contact.email,
        reason: "unsubscribed",
        source: "unsubscribe_link",
      });
      await db.insert(consentRecordsTable).values({
        organizationId,
        contactId: contact.id,
        channel: "email",
        granted: false,
        disclosureVersion: "unsubscribe-link-v1",
        sourceIp: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? null,
        userAgent: (req.headers["user-agent"] as string) ?? null,
      });
      await stopContactEnrollments(organizationId, contact.id, "recipient unsubscribed");
      await recordAudit({
        organizationId,
        action: "send.unsubscribed",
        entityType: "contact",
        entityId: contact.id,
        metadata: { channel: "email", source: "unsubscribe_link" },
      });
    }
    // Same response whether or not the contact still exists — don't leak.
    res.status(200).send(
      page(
        "Unsubscribed",
        "<h1>You're unsubscribed</h1><p>You won't receive any more automated emails at this address.</p>",
      ),
    );
  },
);

/** STOP keywords per CTIA guidance; START/UNSTOP re-enables. */
const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
const START_WORDS = new Set(["start", "unstop", "yes"]);

/** Twilio request-signature check (HMAC-SHA1 of URL + sorted form params). */
function twilioSignatureValid(req: Request): boolean {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return true; // dev / mock provider: nothing to validate against
  const signature = req.headers["x-twilio-signature"];
  if (typeof signature !== "string") return false;
  const url = `${publicBaseUrl()}${req.originalUrl}`;
  const params = req.body as Record<string, string>;
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("");
  const expected = createHmac("sha1", token).update(data, "utf8").digest("base64");
  return signature === expected;
}

router.post(
  "/public/sms/inbound",
  rateLimit({ windowMs: 60_000, max: 60, key: "sms-inbound" }),
  async (req: Request, res: Response): Promise<void> => {
    if (!twilioSignatureValid(req)) {
      res.status(403).json({ error: "invalid signature" });
      return;
    }
    const from = typeof req.body?.From === "string" ? req.body.From : "";
    const body = typeof req.body?.Body === "string" ? req.body.Body : "";
    const keyword = body.trim().toLowerCase();
    const normalized = normalizePhone(from);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
    res.setHeader("Content-Type", "text/xml");

    if (normalized.length < 10 || (!STOP_WORDS.has(keyword) && !START_WORDS.has(keyword))) {
      res.status(200).send(twiml);
      return;
    }

    // One Twilio number serves every org, so apply the keyword to each org
    // that has a contact with this phone number (matched on last 10 digits).
    const last10 = normalized.slice(-10);
    const matches = await db
      .select({
        id: contactsTable.id,
        organizationId: contactsTable.organizationId,
        phone: contactsTable.phone,
      })
      .from(contactsTable)
      .where(
        sql`regexp_replace(coalesce(${contactsTable.phone}, ''), '\\D', '', 'g') LIKE ${"%" + last10}`,
      );

    const seenOrgs = new Set<string>();
    for (const contact of matches) {
      if (STOP_WORDS.has(keyword)) {
        if (!seenOrgs.has(contact.organizationId)) {
          seenOrgs.add(contact.organizationId);
          await addSuppression({
            organizationId: contact.organizationId,
            channel: "sms",
            value: from,
            reason: "stop_keyword",
            source: "twilio_inbound",
            detail: keyword,
          });
        }
        await db.insert(consentRecordsTable).values({
          organizationId: contact.organizationId,
          contactId: contact.id,
          channel: "sms",
          granted: false,
          disclosureVersion: "sms-stop-v1",
        });
        await stopContactEnrollments(
          contact.organizationId,
          contact.id,
          "recipient texted STOP",
        );
        await recordAudit({
          organizationId: contact.organizationId,
          action: "send.sms_stop",
          entityType: "contact",
          entityId: contact.id,
          metadata: { keyword },
        });
      } else {
        // START/UNSTOP: only lift a suppression the STOP flow created —
        // an unauthenticated START can't undo an unsubscribe-link or
        // bounce suppression.
        const removed = await removeSuppressionIfStopKeyword(
          contact.organizationId,
          from,
        );
        if (removed) {
          await db.insert(consentRecordsTable).values({
            organizationId: contact.organizationId,
            contactId: contact.id,
            channel: "sms",
            granted: true,
            disclosureVersion: "sms-start-v1",
          });
          await recordAudit({
            organizationId: contact.organizationId,
            action: "send.sms_start",
            entityType: "contact",
            entityId: contact.id,
            metadata: { keyword },
          });
        }
      }
    }

    res.status(200).send(twiml);
  },
);

/** Remove an SMS suppression only if it came from a STOP keyword. */
async function removeSuppressionIfStopKeyword(
  organizationId: string,
  rawPhone: string,
): Promise<boolean> {
  const { getSuppression } = await import("../../services/send-gate");
  const existing = await getSuppression(organizationId, "sms", rawPhone);
  if (!existing || existing.reason !== "stop_keyword") return false;
  return removeSuppression(organizationId, "sms", rawPhone);
}

/** Stop every live enrollment on every lead belonging to the contact. */
async function stopContactEnrollments(
  organizationId: string,
  contactId: string,
  reason: string,
): Promise<void> {
  const leads = await db
    .select({ id: leadsTable.id })
    .from(leadsTable)
    .innerJoin(
      playbookEnrollmentsTable,
      and(
        eq(playbookEnrollmentsTable.leadId, leadsTable.id),
        inArray(playbookEnrollmentsTable.status, ["active", "paused"]),
      ),
    )
    .where(
      and(
        eq(leadsTable.organizationId, organizationId),
        eq(leadsTable.contactId, contactId),
      ),
    );
  for (const lead of leads) {
    await stopEnrollmentsForLead(organizationId, lead.id, reason, "stopped");
  }
}

export default router;
