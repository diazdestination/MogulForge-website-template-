/**
 * Route-level tests for POST /v1/assistant/chat.
 *
 * - Authenticated member receives a valid SSE stream (tool progress + content + done).
 * - Missing OPENAI_API_KEY returns 503 (no SSE, plain JSON).
 * - 21st request in a minute returns 429.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { db, organizationsTable, rateLimitCountersTable, sessionsTable, usersTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Mock the assistant service before importing app so the route picks up the stub.
const runAssistantChatMock = vi.fn(
  async (params: {
    organizationId: string;
    messages: unknown[];
    onDelta: (text: string) => void;
    onToolCall?: (toolName: string) => void;
  }) => {
    params.onToolCall?.("get_pipeline_snapshot");
    params.onDelta("Hello from the assistant.");
    return "Hello from the assistant.";
  },
);

vi.mock("../../services/assistant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/assistant")>();
  return { ...actual, runAssistantChat: runAssistantChatMock };
});

const { default: app } = await import("../../app");
import { createSession } from "../../lib/auth";

/* ------------------------------------------------------------------ setup */

let server: Server;
let baseUrl: string;
let orgId: string;
let sid: string;

const RATE_LIMIT_KEY_PREFIX = "assistant-chat:";

beforeAll(async () => {
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: "Assistant Route Test Org",
      slug: `assistant-route-${Date.now()}`,
    })
    .returning();
  orgId = org.id;

  const [user] = await db
    .insert(usersTable)
    .values({
      email: `assistant-route-${Date.now()}@example.com`,
      organizationId: orgId,
      role: "sales_rep",
    })
    .returning();

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

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Ensure the rate-limit counter for this process starts fresh.
  await db
    .delete(rateLimitCountersTable)
    .where(
      sql`${rateLimitCountersTable.key} like ${RATE_LIMIT_KEY_PREFIX + "%"}`,
    );
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Clean up rate-limit counters created during the tests.
  await db
    .delete(rateLimitCountersTable)
    .where(
      sql`${rateLimitCountersTable.key} like ${RATE_LIMIT_KEY_PREFIX + "%"}`,
    );
  await db.delete(sessionsTable).where(eq(sessionsTable.sid, sid));
  await db.delete(usersTable).where(eq(usersTable.organizationId, orgId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

/* ---------------------------------------------------------------- helpers */

function postChat(body: unknown, authSid = sid) {
  return fetch(`${baseUrl}/api/v1/assistant/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${authSid}`,
    },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  messages: [{ role: "user", content: "How are my leads doing?" }],
};

/** Parse all complete SSE lines from a response body string. */
function parseSseLines(raw: string): Array<Record<string, unknown>> {
  return raw
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice("data: ".length)) as Record<string, unknown>);
}

/* ------------------------------------------------------- SSE stream shape */

describe("POST /v1/assistant/chat — SSE stream", () => {
  it("emits tool progress, content delta, and done events as valid SSE", async () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    try {
      const res = await postChat(VALID_BODY);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

      const raw = await res.text();

      // Every non-empty line must start with "data: " and carry valid JSON.
      const sseLines = parseSseLines(raw);
      expect(sseLines.length).toBeGreaterThanOrEqual(3);

      const toolEvent = sseLines.find((e) => "tool" in e);
      expect(toolEvent).toBeDefined();
      expect(toolEvent!.tool).toBe("get_pipeline_snapshot");

      const contentEvent = sseLines.find((e) => "content" in e);
      expect(contentEvent).toBeDefined();
      expect(typeof contentEvent!.content).toBe("string");
      expect((contentEvent!.content as string).length).toBeGreaterThan(0);

      const doneEvent = sseLines.at(-1);
      expect(doneEvent).toEqual({ done: true });
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
      else delete process.env.OPENAI_API_KEY;
    }
  });

  it("returns a parseable SSE error event when the service throws", async () => {
    runAssistantChatMock.mockRejectedValueOnce(new Error("DB gone"));
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    try {
      const res = await postChat(VALID_BODY);
      expect(res.status).toBe(200); // SSE: always 200 once headers flushed
      const lines = parseSseLines(await res.text());
      const errorEvent = lines.find((e) => "error" in e);
      expect(errorEvent).toBeDefined();
      expect(typeof errorEvent!.error).toBe("string");
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
      else delete process.env.OPENAI_API_KEY;
    }
  });

  it("rejects malformed bodies with 400", async () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    try {
      const res = await postChat({ messages: "not-an-array" });
      expect(res.status).toBe(400);
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
      else delete process.env.OPENAI_API_KEY;
    }
  });
});

/* ---------------------------------------------- 503 when key is missing */

describe("POST /v1/assistant/chat — 503 when OPENAI_API_KEY absent", () => {
  it("returns 503 JSON (not SSE) when the key is not configured", async () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const res = await postChat(VALID_BODY);
      expect(res.status).toBe(503);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBeTruthy();
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
    }
  });
});

/* -------------------------------------------------- rate-limit: 21st req */

describe("POST /v1/assistant/chat — rate limit", () => {
  it("returns 429 on the 21st request within the same minute", async () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";

    // Reset the shared counter so we start from zero regardless of earlier tests.
    await db
      .delete(rateLimitCountersTable)
      .where(
        sql`${rateLimitCountersTable.key} like ${RATE_LIMIT_KEY_PREFIX + "%"}`,
      );

    try {
      // Requests 1-20 must succeed (200 SSE).
      for (let i = 0; i < 20; i++) {
        const res = await postChat(VALID_BODY);
        expect(res.status, `request ${i + 1} should be 200`).toBe(200);
        // Drain the body so the connection closes cleanly.
        await res.text();
      }

      // 21st request must be blocked.
      const res = await postChat(VALID_BODY);
      expect(res.status).toBe(429);
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
      else delete process.env.OPENAI_API_KEY;

      // Leave the counter in place; afterAll cleans it up.
    }
  });
});
