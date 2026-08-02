/**
 * Proves the scheduler-tick cleanup nulls out previous webhook secrets
 * whose rotation grace window has elapsed, while leaving in-window
 * secrets untouched.
 */
import { db, organizationsTable, webhookEndpointsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteTestOrgs } from "../test-helpers/delete-test-orgs";

process.env.SESSION_SECRET ??= "test-session-secret";

const { cleanupExpiredPreviousSecrets, createEndpoint, rotateEndpointSecret } =
  await import("./webhooks");

let org: { id: string };
const endpointIds: string[] = [];

beforeAll(async () => {
  const [row] = await db
    .insert(organizationsTable)
    .values({ name: "Webhook Cleanup Org", slug: `test-webhook-cleanup-${Date.now()}` })
    .returning();
  org = row;
});

afterAll(async () => {
  await deleteTestOrgs(org.id);
});

async function getEndpoint(id: string) {
  const [row] = await db
    .select()
    .from(webhookEndpointsTable)
    .where(eq(webhookEndpointsTable.id, id));
  return row;
}

describe("cleanupExpiredPreviousSecrets", () => {
  it("clears expired previous secrets and keeps in-window ones", async () => {
    const expired = await createEndpoint(org.id, { url: "https://example.com/a" });
    const fresh = await createEndpoint(org.id, { url: "https://example.com/b" });
    endpointIds.push(expired.id, fresh.id);

    // Rotate both with a grace window so previousSecret is populated.
    await rotateEndpointSecret(org.id, expired.id, 24);
    await rotateEndpointSecret(org.id, fresh.id, 24);

    // Force the first endpoint's grace window into the past.
    await db
      .update(webhookEndpointsTable)
      .set({ previousSecretExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(webhookEndpointsTable.id, expired.id));

    const before = await getEndpoint(expired.id);
    expect(before.previousSecret).not.toBeNull();

    const cleaned = await cleanupExpiredPreviousSecrets();
    expect(cleaned).toBeGreaterThanOrEqual(1);

    const after = await getEndpoint(expired.id);
    expect(after.previousSecret).toBeNull();
    expect(after.previousSecretExpiresAt).toBeNull();

    // The in-window endpoint keeps its previous secret.
    const untouched = await getEndpoint(fresh.id);
    expect(untouched.previousSecret).not.toBeNull();
    expect(untouched.previousSecretExpiresAt).not.toBeNull();
  });

  it("is a no-op when nothing is expired", async () => {
    const ep = await createEndpoint(org.id, { url: "https://example.com/c" });
    endpointIds.push(ep.id);
    await rotateEndpointSecret(org.id, ep.id, 24);

    await cleanupExpiredPreviousSecrets();

    const row = await getEndpoint(ep.id);
    expect(row.previousSecret).not.toBeNull();
  });
});
