import {
  activitiesTable,
  auditEventsTable,
  db,
  organizationsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

// Prevent real email/SMS sends — the Gmail connector is live in this workspace
// and hitting it during parallel test runs triggers 429 rate-limit errors.
vi.mock("./providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers")>();
  return {
    ...actual,
    providers: {
      ...actual.providers,
      email: {
        ...actual.providers.email,
        send: vi.fn(async () => ({ id: "mock-email", provider: "mock" })),
      },
      sms: {
        ...actual.providers.sms,
        send: vi.fn(async () => ({ id: "mock-sms", provider: "mock" })),
      },
    },
  };
});

import { handleMessage, startConversation } from "./concierge";

let org: { id: string };

beforeAll(async () => {
  const [row] = await db
    .insert(organizationsTable)
    .values({ name: "Confirm Test Org", slug: `test-confirm-${Date.now()}` })
    .returning();
  org = row;
});

afterAll(async () => {
  await deleteTestOrgs(org.id);
});

/** Drive the concierge through the full intake and book the first slot. */
async function runFullFlow(opts: { email: string | "skip"; contactMethod: string }) {
  const start = await startConversation({ organizationId: org.id, source: "test" });
  const say = (content: string) =>
    handleMessage({ organizationId: org.id, conversationId: start.conversationId, content });

  await say("Request a quote"); // intent
  await say("A few shingles blew off last week."); // details
  await say("Connie Firmation"); // name
  await say("+15550009999"); // phone
  await say(opts.email); // email
  await say("123 Test Ln"); // street
  await say("Springfield, TX 75001"); // city/state/zip
  await say("Residential"); // property type
  const consentPrompted = await say(opts.contactMethod); // contact method
  expect(consentPrompted?.messages.join(" ")).toContain("permission");
  const scheduling = await say("Yes, you have my consent"); // consent → slots offered
  expect(scheduling).not.toBeNull();
  const final = await say("1"); // pick first slot → booked + done
  return { conversationId: start.conversationId, final };
}

describe("concierge booking confirmation", () => {
  it("sends an SMS confirmation for text preference, logs activity + audit", async () => {
    const { final } = await runFullFlow({ email: "skip", contactMethod: "Text" });
    expect(final?.done).toBe(true);
    expect(final?.messages.some((m) => m.includes("texted a confirmation"))).toBe(true);

    const activities = await db
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.organizationId, org.id),
          eq(activitiesTable.leadId, final!.leadId!),
          eq(activitiesTable.type, "confirmation_sent"),
        ),
      );
    expect(activities).toHaveLength(1);
    expect(activities[0].metadata.channel).toBe("sms");
    expect(activities[0].title).toContain("Inspection confirmation sent via sms");

    const audits = await db
      .select()
      .from(auditEventsTable)
      .where(
        and(
          eq(auditEventsTable.organizationId, org.id),
          eq(auditEventsTable.action, "appointment.confirmation_sent"),
          eq(auditEventsTable.entityId, activities[0].metadata.appointmentId as string),
        ),
      );
    expect(audits).toHaveLength(1);
  });

  it("sends an email confirmation when the homeowner prefers email", async () => {
    const { final } = await runFullFlow({
      email: "connie@example.com",
      contactMethod: "Email",
    });
    expect(final?.done).toBe(true);
    expect(
      final?.messages.some((m) => m.includes("emailed a confirmation")),
    ).toBe(true);

    const activities = await db
      .select()
      .from(activitiesTable)
      .where(
        and(
          eq(activitiesTable.organizationId, org.id),
          eq(activitiesTable.leadId, final!.leadId!),
          eq(activitiesTable.type, "confirmation_sent"),
        ),
      );
    expect(activities).toHaveLength(1);
    expect(activities[0].metadata.channel).toBe("email");
    expect(activities[0].metadata.to).toBe("connie@example.com");
  });
});
