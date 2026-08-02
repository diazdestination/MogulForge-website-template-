/**
 * CRM AI Assistant — answers natural-language questions about the org's own
 * CRM data (leads, conversion, appointments, workload, revenue) using OpenAI
 * function-calling over org-scoped aggregation tools.
 *
 * Every tool query is scoped to the caller's organizationId; the model never
 * sees data from another org and never receives raw PII beyond what the CRM
 * user could already read in the app.
 */
import {
  appointmentsTable,
  crmTasksTable,
  db,
  estimatesTable,
  leadsTable,
  organizationsTable,
  projectsTable,
  usersTable,
} from "@workspace/db";
import { and, count, desc, eq, gte, sql } from "drizzle-orm";

import { logger } from "../lib/logger";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";
const MAX_TOOL_ROUNDS = 5;

export interface AssistantChatMessage {
  role: "user" | "assistant";
  content: string;
}

/* ------------------------------------------------------------------ tools */

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

const WON_STATUSES = [
  "won",
  "production_scheduled",
  "in_progress",
  "final_walkthrough",
  "completed",
  "review_requested",
] as const;

async function pipelineSnapshot(organizationId: string, days: number) {
  const since = daysAgo(days);
  const byStatus = await db
    .select({ status: leadsTable.status, count: count() })
    .from(leadsTable)
    .where(eq(leadsTable.organizationId, organizationId))
    .groupBy(leadsTable.status);
  const bySource = await db
    .select({ source: leadsTable.source, count: count() })
    .from(leadsTable)
    .where(eq(leadsTable.organizationId, organizationId))
    .groupBy(leadsTable.source);
  const [newInWindow] = await db
    .select({ value: count() })
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.organizationId, organizationId),
        gte(leadsTable.createdAt, since),
      ),
    );
  return {
    windowDays: days,
    leadsByStatus: byStatus,
    leadsBySource: bySource,
    newLeadsInWindow: newInWindow.value,
  };
}

async function conversionInsights(organizationId: string, days: number) {
  const since = daysAgo(days);
  const rows = await db
    .select({
      source: leadsTable.source,
      serviceType: leadsTable.serviceType,
      status: leadsTable.status,
      count: count(),
    })
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.organizationId, organizationId),
        gte(leadsTable.createdAt, since),
      ),
    )
    .groupBy(leadsTable.source, leadsTable.serviceType, leadsTable.status);

  const wonSet = new Set<string>(WON_STATUSES);
  type Bucket = { total: number; won: number; lost: number };
  const bySource = new Map<string, Bucket>();
  const byService = new Map<string, Bucket>();
  let total = 0;
  let won = 0;
  let lost = 0;
  const add = (map: Map<string, Bucket>, key: string, row: { status: string; count: number }) => {
    const b = map.get(key) ?? { total: 0, won: 0, lost: 0 };
    b.total += row.count;
    if (wonSet.has(row.status)) b.won += row.count;
    if (row.status === "lost") b.lost += row.count;
    map.set(key, b);
  };
  for (const row of rows) {
    total += row.count;
    if (wonSet.has(row.status)) won += row.count;
    if (row.status === "lost") lost += row.count;
    add(bySource, row.source ?? "unknown", row);
    add(byService, row.serviceType ?? "unknown", row);
  }
  return {
    windowDays: days,
    totals: { leads: total, won, lost, stillOpen: total - won - lost },
    bySource: Object.fromEntries(bySource),
    byServiceType: Object.fromEntries(byService),
    note: "won = any status at or past 'won'; rates should be computed as won/(won+lost) for closed-deal win rate, or won/total for overall conversion.",
  };
}

async function appointmentsStats(organizationId: string, days: number) {
  const since = daysAgo(days);
  const byStatus = await db
    .select({ status: appointmentsTable.status, count: count() })
    .from(appointmentsTable)
    .where(
      and(
        eq(appointmentsTable.organizationId, organizationId),
        gte(appointmentsTable.scheduledStart, since),
      ),
    )
    .groupBy(appointmentsTable.status);
  const byType = await db
    .select({ type: appointmentsTable.type, count: count() })
    .from(appointmentsTable)
    .where(
      and(
        eq(appointmentsTable.organizationId, organizationId),
        gte(appointmentsTable.scheduledStart, since),
      ),
    )
    .groupBy(appointmentsTable.type);
  const [upcoming] = await db
    .select({ value: count() })
    .from(appointmentsTable)
    .where(
      and(
        eq(appointmentsTable.organizationId, organizationId),
        eq(appointmentsTable.status, "scheduled"),
        sql`${appointmentsTable.scheduledStart} > now()`,
      ),
    );
  return { windowDays: days, byStatus, byType, upcomingScheduled: upcoming.value };
}

async function teamWorkload(organizationId: string) {
  const members = await db
    .select({
      userId: usersTable.id,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      email: usersTable.email,
    })
    .from(usersTable)
    .where(eq(usersTable.organizationId, organizationId));

  const openTasks = await db
    .select({ assignedUserId: crmTasksTable.assignedUserId, count: count() })
    .from(crmTasksTable)
    .where(
      and(
        eq(crmTasksTable.organizationId, organizationId),
        sql`${crmTasksTable.status} in ('open', 'in_progress')`,
      ),
    )
    .groupBy(crmTasksTable.assignedUserId);
  const overdueTasks = await db
    .select({ assignedUserId: crmTasksTable.assignedUserId, count: count() })
    .from(crmTasksTable)
    .where(
      and(
        eq(crmTasksTable.organizationId, organizationId),
        sql`${crmTasksTable.status} in ('open', 'in_progress')`,
        sql`${crmTasksTable.dueAt} < now()`,
      ),
    )
    .groupBy(crmTasksTable.assignedUserId);
  const activeLeads = await db
    .select({ assignedUserId: leadsTable.assignedUserId, count: count() })
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.organizationId, organizationId),
        sql`${leadsTable.status} not in ('completed', 'lost', 'nurture')`,
      ),
    )
    .groupBy(leadsTable.assignedUserId);
  const upcomingAppts = await db
    .select({ assignedUserId: appointmentsTable.assignedUserId, count: count() })
    .from(appointmentsTable)
    .where(
      and(
        eq(appointmentsTable.organizationId, organizationId),
        sql`${appointmentsTable.status} in ('scheduled', 'confirmed')`,
        sql`${appointmentsTable.scheduledStart} > now()`,
      ),
    )
    .groupBy(appointmentsTable.assignedUserId);

  const toMap = (rows: { assignedUserId: string | null; count: number }[]) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.assignedUserId ?? "unassigned", r.count);
    return m;
  };
  const tasksMap = toMap(openTasks);
  const overdueMap = toMap(overdueTasks);
  const leadsMap = toMap(activeLeads);
  const apptsMap = toMap(upcomingAppts);

  return {
    members: members.map((m) => ({
      name: [m.firstName, m.lastName].filter(Boolean).join(" ") || m.email || m.userId,
      openTasks: tasksMap.get(m.userId) ?? 0,
      overdueTasks: overdueMap.get(m.userId) ?? 0,
      activeLeads: leadsMap.get(m.userId) ?? 0,
      upcomingAppointments: apptsMap.get(m.userId) ?? 0,
    })),
    unassigned: {
      openTasks: tasksMap.get("unassigned") ?? 0,
      overdueTasks: overdueMap.get("unassigned") ?? 0,
      activeLeads: leadsMap.get("unassigned") ?? 0,
      upcomingAppointments: apptsMap.get("unassigned") ?? 0,
    },
  };
}

async function revenueSummary(organizationId: string, days: number) {
  const since = daysAgo(days);
  const estimates = await db
    .select({
      status: estimatesTable.status,
      count: count(),
      totalCents: sql<number>`coalesce(sum(${estimatesTable.totalCents}), 0)::bigint`,
    })
    .from(estimatesTable)
    .where(
      and(
        eq(estimatesTable.organizationId, organizationId),
        gte(estimatesTable.createdAt, since),
      ),
    )
    .groupBy(estimatesTable.status);
  const projects = await db
    .select({ status: projectsTable.status, count: count() })
    .from(projectsTable)
    .where(
      and(
        eq(projectsTable.organizationId, organizationId),
        gte(projectsTable.createdAt, since),
      ),
    )
    .groupBy(projectsTable.status);
  // Value of estimates behind projects (accepted work in production).
  const [bookedValue] = await db
    .select({
      totalCents: sql<number>`coalesce(sum(${estimatesTable.totalCents}), 0)::bigint`,
    })
    .from(projectsTable)
    .innerJoin(estimatesTable, eq(projectsTable.estimateId, estimatesTable.id))
    .where(
      and(
        eq(projectsTable.organizationId, organizationId),
        gte(projectsTable.createdAt, since),
        sql`${projectsTable.status} <> 'cancelled'`,
      ),
    );
  return {
    windowDays: days,
    estimatesByStatus: estimates.map((e) => ({
      status: e.status,
      count: e.count,
      totalDollars: Number(e.totalCents) / 100,
    })),
    projectsByStatus: projects,
    bookedProjectValueDollars: Number(bookedValue?.totalCents ?? 0) / 100,
  };
}

async function staleLeads(organizationId: string, days: number, limit: number) {
  const rows = await db
    .select({
      id: leadsTable.id,
      status: leadsTable.status,
      source: leadsTable.source,
      serviceType: leadsTable.serviceType,
      score: leadsTable.score,
      estimatedValueCents: leadsTable.estimatedValueCents,
      updatedAt: leadsTable.updatedAt,
    })
    .from(leadsTable)
    .where(
      and(
        eq(leadsTable.organizationId, organizationId),
        sql`${leadsTable.status} not in ('completed', 'lost', 'nurture', 'won', 'production_scheduled', 'in_progress', 'final_walkthrough', 'review_requested')`,
        sql`${leadsTable.updatedAt} < now() - make_interval(days => ${days})`,
      ),
    )
    .orderBy(desc(leadsTable.score))
    .limit(Math.min(limit, 25));
  return {
    staleAfterDays: days,
    count: rows.length,
    leads: rows.map((r) => ({
      ...r,
      estimatedValueDollars:
        r.estimatedValueCents != null ? r.estimatedValueCents / 100 : null,
      estimatedValueCents: undefined,
    })),
  };
}

/* --------------------------------------------------------- tool registry */

interface ToolDef {
  description: string;
  parameters: Record<string, unknown>;
  run: (organizationId: string, args: Record<string, unknown>) => Promise<unknown>;
}

const intArg = (v: unknown, fallback: number, max: number) => {
  const n = typeof v === "number" ? Math.floor(v) : Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
};

export const TOOLS: Record<string, ToolDef> = {
  get_pipeline_snapshot: {
    description:
      "Current lead pipeline: lead counts by status and by source, plus how many new leads arrived in the last N days.",
    parameters: {
      type: "object",
      properties: { days: { type: "number", description: "Lookback window in days (default 30)" } },
    },
    run: (org, a) => pipelineSnapshot(org, intArg(a.days, 30, 3650)),
  },
  get_conversion_insights: {
    description:
      "Won vs lost breakdown over the last N days, grouped by lead source and service type. Use for close rates, what's working vs not, and missed opportunities.",
    parameters: {
      type: "object",
      properties: { days: { type: "number", description: "Lookback window in days (default 90)" } },
    },
    run: (org, a) => conversionInsights(org, intArg(a.days, 90, 3650)),
  },
  get_appointments_stats: {
    description:
      "Appointment counts by status (completed, cancelled, no_show...) and type over the last N days, plus upcoming scheduled count.",
    parameters: {
      type: "object",
      properties: { days: { type: "number", description: "Lookback window in days (default 30)" } },
    },
    run: (org, a) => appointmentsStats(org, intArg(a.days, 30, 3650)),
  },
  get_team_workload: {
    description:
      "Per-teammate workload: open and overdue tasks, active leads, and upcoming appointments. Use for workload balance and employee engagement questions.",
    parameters: { type: "object", properties: {} },
    run: (org) => teamWorkload(org),
  },
  get_revenue_summary: {
    description:
      "Estimate totals by status (draft/sent/accepted/declined) in dollars, project counts by status, and booked project value over the last N days.",
    parameters: {
      type: "object",
      properties: { days: { type: "number", description: "Lookback window in days (default 90)" } },
    },
    run: (org, a) => revenueSummary(org, intArg(a.days, 90, 3650)),
  },
  get_stale_leads: {
    description:
      "Open leads with no activity in N days, highest score first — likely missed opportunities worth chasing.",
    parameters: {
      type: "object",
      properties: {
        days: { type: "number", description: "Days without updates to count as stale (default 14)" },
        limit: { type: "number", description: "Max leads to return (default 10, max 25)" },
      },
    },
    run: (org, a) => staleLeads(org, intArg(a.days, 14, 3650), intArg(a.limit, 10, 25)),
  },
};

/* ------------------------------------------------------------ chat loop */

/**
 * Build the system prompt from the org's name.
 * Falls back to a neutral description when the org record is not found or has
 * no name, so the assistant never claims a hardcoded company identity.
 */
export function buildSystemPrompt(orgName: string | null | undefined): string {
  const identity = orgName?.trim() ? `${orgName.trim()}'s CRM` : "this organization's CRM";
  return `You are the built-in business analyst for ${identity}. You answer questions from the company's own team about THEIR live CRM data using the provided tools.

Guidelines:
- Always call the relevant tools to get real numbers before answering. Never invent figures.
- Be concise, direct, and actionable. Lead with the answer, then the supporting numbers.
- Use markdown: short paragraphs, bullet lists, and tables when comparing things. Money in $ with commas.
- When asked "what's working vs not", compare conversion by source/service and call out the best and worst with numbers.
- Proactively flag one useful insight or next step when it's clearly supported by the data (e.g. stale high-score leads, overloaded teammates, high no-show rates).
- Material orders for jobs are not tracked in this CRM yet — say so honestly if asked, and suggest what is trackable (estimates, project statuses).
- If a question is about a specific person's performance, stick to neutral workload/pipeline facts; don't speculate about attitude or engagement beyond the numbers.
- Dates: "today" is the server date. Default lookback windows are fine unless the user asks for a period.`;
}

type OpenAiMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

async function callOpenAi(
  messages: OpenAiMessage[],
  options: { stream: boolean; tools: boolean },
): Promise<Response> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      messages,
      stream: options.stream,
      ...(options.tools
        ? {
            tools: Object.entries(TOOLS).map(([name, t]) => ({
              type: "function",
              function: { name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI request failed: ${res.status} ${await res.text()}`);
  }
  return res;
}

/**
 * Run one assistant turn. Resolves tool calls (up to MAX_TOOL_ROUNDS), then
 * streams the final answer through onDelta. Returns the full answer text.
 */
export async function runAssistantChat(params: {
  organizationId: string;
  messages: AssistantChatMessage[];
  onDelta: (text: string) => void;
  onToolCall?: (toolName: string) => void;
}): Promise<string> {
  const [org] = await db
    .select({ name: organizationsTable.name })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, params.organizationId))
    .limit(1);

  const history: OpenAiMessage[] = [
    { role: "system", content: buildSystemPrompt(org?.name) },
    ...params.messages.slice(-20).map((m) => ({ role: m.role, content: m.content })),
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await callOpenAi(history, { stream: false, tools: true });
    const data = (await res.json()) as {
      choices?: {
        message?: { content?: string | null; tool_calls?: OpenAiToolCall[] };
      }[];
    };
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error("OpenAI returned no message");

    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      // Final answer arrived without streaming; emit it in one delta.
      const text = message.content?.trim() ?? "";
      params.onDelta(text);
      return text;
    }

    history.push({
      role: "assistant",
      content: message.content ?? null,
      tool_calls: toolCalls,
    });
    for (const call of toolCalls) {
      const tool = TOOLS[call.function.name];
      params.onToolCall?.(call.function.name);
      let result: unknown;
      if (!tool) {
        result = { error: `Unknown tool: ${call.function.name}` };
      } else {
        try {
          const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
          result = await tool.run(params.organizationId, args);
        } catch (err) {
          logger.error({ err, tool: call.function.name }, "assistant tool failed");
          result = { error: "This data lookup failed; answer with what you have and mention the gap." };
        }
      }
      history.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  // Tool budget exhausted — force a final answer without tools, streamed.
  const res = await callOpenAi(history, { stream: true, tools: false });
  let full = "";
  const reader = res.body?.getReader();
  if (!reader) throw new Error("OpenAI stream has no body");
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const chunk = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
        };
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          params.onDelta(delta);
        }
      } catch {
        // Ignore malformed keep-alive lines.
      }
    }
  }
  return full;
}
