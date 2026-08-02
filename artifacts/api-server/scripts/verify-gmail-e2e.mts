/**
 * One-off end-to-end verification for task: confirm a triggered automation
 * really delivers email through the Gmail connector.
 *
 * Steps:
 * 1. Determine the connected Gmail sending account.
 * 2. Create a test contact (email = sender, so we can read the inbox),
 *    a test lead, and a test automation rule guarded by a unique marker
 *    condition so no other data can ever trigger it.
 * 3. Trigger the event, then assert the automation run recorded
 *    provider "gmail" with a real message id.
 * 4. Read the message back from the Gmail API and confirm it exists in
 *    the mailbox (sent-to-self → INBOX).
 * 5. Clean up all test rows.
 */
import { and, desc, eq } from "drizzle-orm";
import {
  automationRunsTable,
  automationsTable,
  contactsTable,
  db,
  leadsTable,
  organizationsTable,
} from "@workspace/db";

import { runEvent } from "../src/services/automation";
import { getEmailProviderStatus } from "../src/services/providers";

async function main() {
  const status = await getEmailProviderStatus();
  console.log("provider status:", status);
  if (status.provider !== "gmail" || !status.senderEmail) {
    throw new Error("Gmail connector not active — cannot run e2e verification");
  }
  const sender = status.senderEmail;

  const [org] = await db.select().from(organizationsTable).limit(1);
  if (!org) throw new Error("no organization found");

  // Ensure no zero-condition rules exist for the chosen event (they'd fire too).
  const event = "review.request_due" as const;
  const existing = await db
    .select()
    .from(automationsTable)
    .where(
      and(
        eq(automationsTable.organizationId, org.id),
        eq(automationsTable.event, event),
        eq(automationsTable.isActive, true),
      ),
    );
  const unconditioned = existing.filter(
    (r) => Object.keys(r.conditions ?? {}).length === 0,
  );
  if (unconditioned.length > 0) {
    console.warn(
      `note: ${unconditioned.length} existing unconditioned rule(s) on ${event} will also fire for this org's test lead`,
    );
  }

  const marker = `e2e-${Date.now()}`;
  const cleanup: (() => Promise<unknown>)[] = [];
  try {
    const [contact] = await db
      .insert(contactsTable)
      .values({
        organizationId: org.id,
        firstName: "E2E",
        lastName: "EmailTest",
        email: sender,
      })
      .returning();
    cleanup.push(() =>
      db.delete(contactsTable).where(eq(contactsTable.id, contact.id)),
    );

    const [lead] = await db
      .insert(leadsTable)
      .values({
        organizationId: org.id,
        contactId: contact.id,
        source: "manual",
        status: "new",
      } as typeof leadsTable.$inferInsert)
      .returning();
    cleanup.push(() => db.delete(leadsTable).where(eq(leadsTable.id, lead.id)));

    const [rule] = await db
      .insert(automationsTable)
      .values({
        organizationId: org.id,
        name: `E2E Gmail delivery check ${marker}`,
        event,
        conditions: { "test.marker": marker },
        actions: [
          {
            type: "send_email",
            params: {
              subject: `Painless Roofing e2e delivery check ${marker}`,
              body: `Automated end-to-end delivery verification (${marker}). Safe to ignore.`,
            },
          },
        ],
        isActive: true,
      } as typeof automationsTable.$inferInsert)
      .returning();
    cleanup.push(() =>
      db.delete(automationsTable).where(eq(automationsTable.id, rule.id)),
    );

    await runEvent(org.id, event, {
      leadId: lead.id,
      contactId: contact.id,
      fields: { "test.marker": marker },
    });

    const [run] = await db
      .select()
      .from(automationRunsTable)
      .where(eq(automationRunsTable.automationId, rule.id))
      .orderBy(desc(automationRunsTable.createdAt))
      .limit(1);
    if (!run) throw new Error("no automation run recorded");
    console.log("run status:", run.status);
    console.log("action results:", JSON.stringify(run.actionResults));
    cleanup.push(() =>
      db.delete(automationRunsTable).where(eq(automationRunsTable.id, run.id)),
    );

    const detail = (run.actionResults as { detail?: string }[])[0]?.detail ?? "";
    if (run.status !== "success" || !detail.startsWith("gmail:")) {
      throw new Error(`expected success with gmail provider, got ${run.status} / ${detail}`);
    }
    const messageId = detail.slice("gmail:".length);
    if (!messageId || messageId === "unknown") {
      throw new Error("no real Gmail message id recorded");
    }
    console.log("gmail message id:", messageId);

    // Verify the message actually exists in the mailbox.
    const { ReplitConnectors } = await import("@replit/connectors-sdk");
    const connectors = new ReplitConnectors();
    const res = await connectors.proxy(
      "google-mail",
      `/gmail/v1/users/me/messages/${messageId}?format=metadata&metadataHeaders=Subject&metadataHeaders=To`,
      { method: "GET" },
    );
    if (!res.ok) {
      throw new Error(`Gmail message lookup failed: ${res.status} ${await res.text()}`);
    }
    const msg = (await res.json()) as {
      id: string;
      labelIds?: string[];
      payload?: { headers?: { name: string; value: string }[] };
    };
    const subject = msg.payload?.headers?.find((h) => h.name === "Subject")?.value;
    const to = msg.payload?.headers?.find((h) => h.name === "To")?.value;
    console.log("verified in mailbox:", {
      id: msg.id,
      labelIds: msg.labelIds,
      subject,
      to,
    });
    if (!subject?.includes(marker)) throw new Error("subject marker mismatch");
    console.log("E2E RESULT: PASS — email delivered via Gmail and verified in mailbox");
  } finally {
    for (const fn of cleanup.reverse()) {
      await fn().catch((e) => console.warn("cleanup failed:", e));
    }
    console.log("cleanup complete");
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("E2E RESULT: FAIL —", err);
    process.exit(1);
  },
);
