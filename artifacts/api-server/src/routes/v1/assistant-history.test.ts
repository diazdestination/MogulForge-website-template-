/**
 * Route-level tests for assistant history endpoints:
 *   GET  /v1/assistant/history — returns empty array for a fresh user, then saved messages
 *   POST /v1/assistant/history — upserts history; repeated POSTs replace rather than append
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import {
  assistantHistoryTable,
  db,
  organizationsTable,
  sessionsTable,
  usersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { default: app } = await import("../../app");
import { createSession } from "../../lib/auth";

/* ------------------------------------------------------------------ setup */

let server: Server;
let baseUrl: string;
let orgId: string;
let userId: string;
let sid: string;

// Second user in the same org for cross-user isolation tests
let userBId: string;
let sidB: string;

beforeAll(async () => {
  const ts = Date.now();
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Assistant History Test Org",
      slug: `assistant-history-${ts}`,
    })
    .returning();
  orgId = org.id;

  const [user] = await db
    .insert(usersTable)
    .values({
      email: `assistant-history-a-${ts}@example.com`,
      organizationId: orgId,
      role: "sales_rep",
    })
    .returning();
  userId = user.id;

  sid = await createSession({
    user: {
      id: user.id,
      email: null,
      firstName: null,
      lastName: null,
      profileImageUrl: null,
    },
    access_token: "test-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });

  const [userB] = await db
    .insert(usersTable)
    .values({
      email: `assistant-history-b-${ts}@example.com`,
      organizationId: orgId,
      role: "sales_rep",
    })
    .returning();
  userBId = userB.id;

  sidB = await createSession({
    user: {
      id: userB.id,
      email: null,
      firstName: null,
      lastName: null,
      profileImageUrl: null,
    },
    access_token: "test-token-b",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db
    .delete(assistantHistoryTable)
    .where(eq(assistantHistoryTable.organizationId, orgId));
  await db.delete(sessionsTable).where(eq(sessionsTable.sid, sid));
  await db.delete(sessionsTable).where(eq(sessionsTable.sid, sidB));
  await db.delete(usersTable).where(eq(usersTable.organizationId, orgId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

/* ---------------------------------------------------------------- helpers */

function getHistory(authSid = sid) {
  return fetch(`${baseUrl}/api/v1/assistant/history`, {
    headers: { Authorization: `Bearer ${authSid}` },
  });
}

function postHistory(messages: unknown[], authSid = sid) {
  return fetch(`${baseUrl}/api/v1/assistant/history`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${authSid}`,
    },
    body: JSON.stringify({ messages }),
  });
}

/* ----------------------------------------------------------- GET history */

describe("GET /v1/assistant/history", () => {
  it("returns an empty messages array for a user with no history", async () => {
    const res = await getHistory();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: unknown[] };
    expect(body.messages).toEqual([]);
  });

  it("returns 401 without authentication", async () => {
    const res = await fetch(`${baseUrl}/api/v1/assistant/history`);
    expect(res.status).toBe(401);
  });
});

/* ---------------------------------------------------------- POST history */

describe("POST /v1/assistant/history", () => {
  const TURN = [
    { role: "user", content: "How are my leads doing?" },
    { role: "assistant", content: "Looking good!", toolsRun: ["get_pipeline_snapshot"] },
  ];

  it("saves history and returns the saved messages", async () => {
    const res = await postHistory(TURN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: typeof TURN };
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[1].role).toBe("assistant");
    expect(body.messages[1].toolsRun).toEqual(["get_pipeline_snapshot"]);
  });

  it("GET returns the just-saved history", async () => {
    const res = await getHistory();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: typeof TURN };
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].content).toBe("How are my leads doing?");
  });

  it("replaces history on a second POST (upsert, not append)", async () => {
    const newTurn = [{ role: "user", content: "New question" }, { role: "assistant", content: "New answer" }];
    await postHistory(newTurn);

    const res = await getHistory();
    const body = (await res.json()) as { messages: typeof newTurn };
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].content).toBe("New question");
  });

  it("clears history when an empty array is saved", async () => {
    await postHistory([]);
    const res = await getHistory();
    const body = (await res.json()) as { messages: unknown[] };
    expect(body.messages).toEqual([]);
  });

  it("returns 400 for a malformed payload", async () => {
    const res = await fetch(`${baseUrl}/api/v1/assistant/history`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${sid}`,
      },
      body: JSON.stringify({ messages: "not-an-array" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 401 without authentication", async () => {
    const res = await fetch(`${baseUrl}/api/v1/assistant/history`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(401);
  });
});

/* ------------------------------------------------ cross-user isolation */

describe("cross-user isolation", () => {
  const USER_A_HISTORY = [
    { role: "user", content: "User A's secret question" },
    { role: "assistant", content: "User A's private answer" },
  ];

  const USER_B_HISTORY = [
    { role: "user", content: "User B's own question" },
    { role: "assistant", content: "User B's own answer" },
  ];

  beforeAll(async () => {
    // Seed history for user A so isolation can be verified
    await postHistory(USER_A_HISTORY, sid);
  });

  it("GET as user B returns an empty array even though user A has history", async () => {
    const res = await getHistory(sidB);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: unknown[] };
    expect(body.messages).toEqual([]);
  });

  it("POST as user B does not overwrite user A's rows", async () => {
    // User B saves their own history
    const resB = await postHistory(USER_B_HISTORY, sidB);
    expect(resB.status).toBe(200);

    // User A's history must be unchanged
    const resA = await getHistory(sid);
    expect(resA.status).toBe(200);
    const bodyA = (await resA.json()) as { messages: typeof USER_A_HISTORY };
    expect(bodyA.messages).toHaveLength(2);
    expect(bodyA.messages[0].content).toBe("User A's secret question");
    expect(bodyA.messages[1].content).toBe("User A's private answer");
  });

  it("user B can only read their own history, not user A's", async () => {
    const resB = await getHistory(sidB);
    expect(resB.status).toBe(200);
    const bodyB = (await resB.json()) as { messages: typeof USER_B_HISTORY };
    expect(bodyB.messages).toHaveLength(2);
    expect(bodyB.messages[0].content).toBe("User B's own question");
    // Confirm user A's content is absent
    const contents = bodyB.messages.map((m) => m.content);
    expect(contents).not.toContain("User A's secret question");
    expect(contents).not.toContain("User A's private answer");
  });
});
