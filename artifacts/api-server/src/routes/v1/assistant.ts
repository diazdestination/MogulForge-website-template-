/**
 * Assistant routes:
 *   POST /v1/assistant/chat    — CRM AI assistant (SSE stream)
 *   GET  /v1/assistant/history — load per-user conversation history
 *   POST /v1/assistant/history — upsert per-user conversation history
 *
 * SSE stream events for chat:
 *   data: {"tool":"get_pipeline_snapshot"}   (progress: data being looked up)
 *   data: {"content":"..."}                  (answer text delta)
 *   data: {"done":true}                      (turn complete)
 *   data: {"error":"..."}                    (fatal error for this turn)
 */
import {
  SaveAssistantHistoryBody,
  SendAssistantChatBody,
} from "@workspace/api-zod";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  and,
  eq,
} from "drizzle-orm";

import { db, assistantHistoryTable } from "@workspace/db";
import { logger } from "../../lib/logger";
import { rateLimit } from "../../lib/rateLimit";
import { requireMember } from "../../middlewares/requireMember";
import {
  runAssistantChat,
  type AssistantChatMessage,
} from "../../services/assistant";

const router: IRouter = Router();

/* ── GET /v1/assistant/history ──────────────────────────────────────────── */

router.get(
  "/assistant/history",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const organizationId = req.member!.organizationId;
    const userId = req.member!.user.id;

    const [row] = await db
      .select()
      .from(assistantHistoryTable)
      .where(
        and(
          eq(assistantHistoryTable.organizationId, organizationId),
          eq(assistantHistoryTable.userId, userId),
        ),
      )
      .limit(1);

    res.json({ messages: row?.messages ?? [] });
  },
);

/* ── POST /v1/assistant/history ─────────────────────────────────────────── */

router.post(
  "/assistant/history",
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    const organizationId = req.member!.organizationId;
    const userId = req.member!.user.id;

    const parsed = SaveAssistantHistoryBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid history payload" });
      return;
    }

    const [row] = await db
      .insert(assistantHistoryTable)
      .values({
        organizationId,
        userId,
        messages: parsed.data.messages,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [assistantHistoryTable.organizationId, assistantHistoryTable.userId],
        set: {
          messages: parsed.data.messages,
          updatedAt: new Date(),
        },
      })
      .returning();

    res.json({ messages: row.messages });
  },
);

/* ── POST /v1/assistant/chat ────────────────────────────────────────────── */

router.post(
  "/assistant/chat",
  rateLimit({ windowMs: 60_000, max: 20, key: "assistant-chat" }),
  requireMember("crm.read"),
  async (req: Request, res: Response): Promise<void> => {
    if (!process.env.OPENAI_API_KEY) {
      res.status(503).json({ error: "The AI assistant is not configured yet" });
      return;
    }
    const parsed = SendAssistantChatBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid chat payload" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const send = (payload: unknown) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      await runAssistantChat({
        organizationId: req.member!.organizationId,
        messages: parsed.data.messages as AssistantChatMessage[],
        onDelta: (content) => send({ content }),
        onToolCall: (tool) => send({ tool }),
      });
      send({ done: true });
    } catch (err) {
      logger.error({ err }, "assistant chat failed");
      send({ error: "Something went wrong answering that — please try again." });
    } finally {
      res.end();
    }
  },
);

export default router;
