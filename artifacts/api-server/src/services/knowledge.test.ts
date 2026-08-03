import { db, organizationsTable } from "@workspace/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

import { getConciergeSettings } from "./settings";
import { handleMessage, startConversation } from "./concierge";
import {
  createKnowledgeEntry,
  deleteKnowledgeEntry,
  findKnowledgeAnswer,
  listKnowledgeEntries,
  updateKnowledgeEntry,
} from "./knowledge";

let org: { id: string };
let otherOrg: { id: string };

beforeAll(async () => {
  const stamp = Date.now();
  const [a] = await db
    .insert(organizationsTable)
    .values({ name: "Knowledge Test Org", slug: `test-knowledge-${stamp}` })
    .returning();
  org = a;
  const [b] = await db
    .insert(organizationsTable)
    .values({ name: "Knowledge Other Org", slug: `test-knowledge-b-${stamp}` })
    .returning();
  otherOrg = b;
});

afterAll(async () => {
  await deleteTestOrgs(org.id, otherOrg.id);
});

describe("knowledge CRUD", () => {
  it("creates, lists, updates, and deletes entries org-scoped", async () => {
    const entry = await createKnowledgeEntry(org.id, {
      category: "financing",
      title: "Do you offer financing?",
      content: "Yes — 12-month same-as-cash financing on approved credit.",
    });
    expect(entry).not.toBeNull();

    // Tenant isolation: the other org never sees it.
    expect(await listKnowledgeEntries(otherOrg.id)).toHaveLength(0);
    expect((await listKnowledgeEntries(org.id)).map((e) => e.id)).toContain(entry!.id);

    // Cross-org update/delete must fail.
    expect(await updateKnowledgeEntry(otherOrg.id, entry!.id, { title: "Hacked" })).toBeNull();
    expect(await deleteKnowledgeEntry(otherOrg.id, entry!.id)).toBe(false);

    const updated = await updateKnowledgeEntry(org.id, entry!.id, { isActive: false });
    expect(updated).not.toBeNull();
    expect((updated as { isActive: boolean }).isActive).toBe(false);

    expect(await deleteKnowledgeEntry(org.id, entry!.id)).toBe(true);
  });

  it("rejects invalid category and blank content", async () => {
    expect(
      await createKnowledgeEntry(org.id, {
        category: "nonsense" as never,
        title: "x",
        content: "y",
      }),
    ).toBeNull();
    expect(
      await createKnowledgeEntry(org.id, { category: "faq", title: "  ", content: "y" }),
    ).toBeNull();
  });
});

describe("findKnowledgeAnswer", () => {
  it("matches on word overlap and ignores inactive entries", async () => {
    const entry = await createKnowledgeEntry(org.id, {
      category: "warranty",
      title: "Workmanship warranty length",
      content: "Every roof replacement includes a 10-year workmanship warranty.",
    });
    const hit = await findKnowledgeAnswer(org.id, "How long is your workmanship warranty?");
    expect(hit?.id).toBe(entry!.id);

    await updateKnowledgeEntry(org.id, entry!.id, { isActive: false });
    expect(await findKnowledgeAnswer(org.id, "How long is your workmanship warranty?")).toBeNull();
    await deleteKnowledgeEntry(org.id, entry!.id);
  });

  it("returns null instead of guessing on unrelated questions", async () => {
    expect(await findKnowledgeAnswer(org.id, "What is the airspeed of a swallow?")).toBeNull();
  });
});

describe("concierge knowledge Q&A", () => {
  it("answers a known FAQ mid-intake and re-asks the current step", async () => {
    await createKnowledgeEntry(org.id, {
      category: "financing",
      title: "Financing options",
      content: "We offer 12-month same-as-cash financing through Acme Lending.",
    });
    const started = await startConversation({ organizationId: org.id });
    // Move past intent into details.
    await handleMessage({
      organizationId: org.id,
      conversationId: started.conversationId,
      content: "Roof leak or water damage",
    });
    await handleMessage({
      organizationId: org.id,
      conversationId: started.conversationId,
      content: "No",
    });
    const reply = await handleMessage({
      organizationId: org.id,
      conversationId: started.conversationId,
      content: "Do you offer financing options?",
    });
    const text = reply!.messages.join("\n");
    expect(text).toContain("Acme Lending");
    // Still in the intake flow — the step prompt is repeated, not advanced.
    expect(reply!.done).toBe(false);
  });

  it("uses the unknown-answer fallback and keeps capturing the lead", async () => {
    const cfg = await getConciergeSettings(org.id);
    const started = await startConversation({ organizationId: org.id });
    await handleMessage({
      organizationId: org.id,
      conversationId: started.conversationId,
      content: "Roof leak or water damage",
    });
    await handleMessage({
      organizationId: org.id,
      conversationId: started.conversationId,
      content: "No",
    });
    const reply = await handleMessage({
      organizationId: org.id,
      conversationId: started.conversationId,
      content: "Do you install solar panels on Mars?",
    });
    expect(reply!.messages.join("\n")).toContain(cfg.unknownAnswerFallback);
    // Flow continues so the team can follow up with contact info.
    const next = await handleMessage({
      organizationId: org.id,
      conversationId: started.conversationId,
      content: "There is a leak in my kitchen ceiling",
    });
    expect(next!.messages.length).toBeGreaterThan(0);
  });
});

describe("org-configured concierge", () => {
  it("uses custom greeting, assistant name, and intents", async () => {
    const stamp = Date.now();
    const [customOrg] = await db
      .insert(organizationsTable)
      .values({ name: "Custom Concierge Org", slug: `test-knowledge-c-${stamp}` })
      .returning();
    try {
      const { updateOrgSettings } = await import("./settings");
      await updateOrgSettings(customOrg.id, {
        concierge: {
          assistantName: "Solar Sam",
          greeting: "Welcome to SunCo! How can I help?",
          intents: [
            {
              key: "install",
              label: "New solar install",
              service: "solar-install",
              points: 30,
              reason: "New install inquiry",
              urgency: "normal",
              triage: false,
              keywords: ["solar", "panels"],
            },
          ],
        },
      } as never);

      const started = await startConversation({ organizationId: customOrg.id });
      expect(started.messages[0]).toContain("Welcome to SunCo!");
      expect(started.quickReplies).toContain("New solar install");

      const reply = await handleMessage({
        organizationId: customOrg.id,
        conversationId: started.conversationId,
        content: "I want solar panels",
      });
      // Custom intent matched → moved past intent step.
      expect(reply!.messages.length).toBeGreaterThan(0);
    } finally {
      await deleteTestOrgs(customOrg.id);
    }
  });
});
