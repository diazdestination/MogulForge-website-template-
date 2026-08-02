import {
  automationRunsTable,
  automationsTable,
  db,
  organizationsTable,
  type ActionResult,
} from "@workspace/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

import { getEmailSendHealth } from "./automation";

let org: { id: string };
let automationId: string;

beforeAll(async () => {
  const slug = `test-email-health-${Date.now()}`;
  const [row] = await db
    .insert(organizationsTable)
    .values({ name: "Email Health Test Org", slug })
    .returning();
  org = row;
  const [rule] = await db
    .insert(automationsTable)
    .values({
      organizationId: org.id,
      name: "email rule",
      event: "lead.created",
      actions: [{ type: "send_email", params: {} }],
    })
    .returning();
  automationId = rule.id;
});

afterAll(async () => {
  await deleteTestOrgs(org.id);
});

async function insertRun(
  results: ActionResult[],
  status: "success" | "failed" | "partial" | "skipped",
  createdAt: Date,
) {
  await db.insert(automationRunsTable).values({
    organizationId: org.id,
    automationId,
    event: "lead.created",
    status,
    actionResults: results,
    createdAt,
  });
}

describe("getEmailSendHealth", () => {
  it("reports zero failures for an org with no runs", async () => {
    const health = await getEmailSendHealth(org.id);
    expect(health.consecutiveFailures).toBe(0);
    expect(health.lastFailureAt).toBeNull();
    expect(health.lastFailureDetail).toBeNull();
  });

  it("counts consecutive send_email failures until the last success", async () => {
    const base = Date.now() - 60_000;
    // Oldest: a success, then two failures (newest last).
    await insertRun(
      [{ type: "send_email", status: "success", detail: "gmail:abc" }],
      "success",
      new Date(base),
    );
    await insertRun(
      [{ type: "send_email", status: "failed", detail: "Gmail send failed: 401" }],
      "failed",
      new Date(base + 10_000),
    );
    // Skipped results (no contact email) are not send attempts.
    await insertRun(
      [{ type: "send_email", status: "skipped", detail: "no contact email" }],
      "skipped",
      new Date(base + 15_000),
    );
    // Non-email actions are ignored entirely.
    await insertRun(
      [{ type: "create_task", status: "success" }],
      "success",
      new Date(base + 18_000),
    );
    await insertRun(
      [{ type: "send_email", status: "failed", detail: "Gmail send failed: 401" }],
      "failed",
      new Date(base + 20_000),
    );

    const health = await getEmailSendHealth(org.id);
    expect(health.consecutiveFailures).toBe(2);
    expect(health.lastFailureAt).toBe(new Date(base + 20_000).toISOString());
    expect(health.lastFailureDetail).toBe("Gmail send failed: 401");
  });

  it("resets to zero once the newest send succeeds", async () => {
    await insertRun(
      [{ type: "send_email", status: "success", detail: "gmail:def" }],
      "success",
      new Date(),
    );
    const health = await getEmailSendHealth(org.id);
    expect(health.consecutiveFailures).toBe(0);
  });
});
