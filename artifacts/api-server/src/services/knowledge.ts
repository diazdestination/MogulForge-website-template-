/**
 * Org knowledge base — admin-managed facts that ground the concierge and
 * outreach drafting. Answer lookup is deterministic keyword overlap (no AI),
 * so the concierge can never invent an answer: it either quotes a stored
 * entry or admits it doesn't know.
 */
import {
  db,
  knowledgeEntriesTable,
  KNOWLEDGE_CATEGORIES,
  type KnowledgeCategory,
  type KnowledgeEntry,
} from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";

const MAX_TITLE = 200;
const MAX_CONTENT = 4000;

export function isKnowledgeCategory(value: string): value is KnowledgeCategory {
  return (KNOWLEDGE_CATEGORIES as readonly string[]).includes(value);
}

export async function listKnowledgeEntries(organizationId: string): Promise<KnowledgeEntry[]> {
  return db
    .select()
    .from(knowledgeEntriesTable)
    .where(eq(knowledgeEntriesTable.organizationId, organizationId))
    .orderBy(asc(knowledgeEntriesTable.category), asc(knowledgeEntriesTable.createdAt));
}

export async function createKnowledgeEntry(
  organizationId: string,
  input: { category: string; title: string; content: string; source?: string; isActive?: boolean },
): Promise<KnowledgeEntry | null> {
  if (!isKnowledgeCategory(input.category)) return null;
  const title = input.title.trim().slice(0, MAX_TITLE);
  const content = input.content.trim().slice(0, MAX_CONTENT);
  if (!title || !content) return null;
  const [row] = await db
    .insert(knowledgeEntriesTable)
    .values({
      organizationId,
      category: input.category,
      title,
      content,
      source: input.source === "seed" ? "seed" : "manual",
      isActive: input.isActive ?? true,
    })
    .returning();
  return row;
}

export async function updateKnowledgeEntry(
  organizationId: string,
  id: string,
  patch: { category?: string; title?: string; content?: string; isActive?: boolean },
): Promise<KnowledgeEntry | null | "invalid"> {
  const set: Record<string, unknown> = {};
  if (patch.category !== undefined) {
    if (!isKnowledgeCategory(patch.category)) return "invalid";
    set.category = patch.category;
  }
  if (patch.title !== undefined) {
    const t = patch.title.trim().slice(0, MAX_TITLE);
    if (!t) return "invalid";
    set.title = t;
  }
  if (patch.content !== undefined) {
    const c = patch.content.trim().slice(0, MAX_CONTENT);
    if (!c) return "invalid";
    set.content = c;
  }
  if (patch.isActive !== undefined) set.isActive = patch.isActive;
  if (Object.keys(set).length === 0) return "invalid";
  const [row] = await db
    .update(knowledgeEntriesTable)
    .set(set)
    .where(
      and(
        eq(knowledgeEntriesTable.id, id),
        eq(knowledgeEntriesTable.organizationId, organizationId),
      ),
    )
    .returning();
  return row ?? null;
}

export async function deleteKnowledgeEntry(
  organizationId: string,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(knowledgeEntriesTable)
    .where(
      and(
        eq(knowledgeEntriesTable.id, id),
        eq(knowledgeEntriesTable.organizationId, organizationId),
      ),
    )
    .returning({ id: knowledgeEntriesTable.id });
  return rows.length > 0;
}

async function activeEntries(organizationId: string): Promise<KnowledgeEntry[]> {
  return db
    .select()
    .from(knowledgeEntriesTable)
    .where(
      and(
        eq(knowledgeEntriesTable.organizationId, organizationId),
        eq(knowledgeEntriesTable.isActive, true),
      ),
    )
    .orderBy(asc(knowledgeEntriesTable.category), asc(knowledgeEntriesTable.createdAt));
}

/**
 * Compact "Org knowledge" fact lines for AI prompts (sales summaries,
 * outreach drafting). Bounded so a huge knowledge base can't blow the prompt.
 */
export async function buildKnowledgeFacts(
  organizationId: string,
  maxEntries = 30,
): Promise<string[]> {
  const entries = await activeEntries(organizationId);
  return entries
    .slice(0, maxEntries)
    .map((e) => `Org knowledge [${e.category}] ${e.title}: ${e.content.slice(0, 400)}`);
}

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are",
  "do", "does", "you", "your", "we", "our", "i", "my", "me", "it", "that",
  "this", "with", "can", "how", "what", "when", "where", "who", "why", "have",
  "has", "will", "would", "should", "could", "be", "was", "were", "about",
  "any", "get", "if", "at", "by", "from", "there", "they", "them",
]);

function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

/**
 * Deterministic knowledge lookup: score active entries by word overlap with
 * the visitor's question; return the best entry when the match is meaningful
 * (≥2 overlapping significant words, or 1 that appears in the entry title).
 * Returns null when the knowledge base can't answer — callers must then use
 * the "I don't know" fallback rather than guessing.
 */
export async function findKnowledgeAnswer(
  organizationId: string,
  question: string,
): Promise<KnowledgeEntry | null> {
  const words = significantWords(question);
  if (words.length === 0) return null;
  const entries = await activeEntries(organizationId);
  let best: { entry: KnowledgeEntry; score: number } | null = null;
  for (const entry of entries) {
    const haystackTitle = entry.title.toLowerCase();
    const haystackBody = entry.content.toLowerCase();
    let score = 0;
    let titleHit = false;
    for (const w of words) {
      if (haystackTitle.includes(w)) {
        score += 2;
        titleHit = true;
      } else if (haystackBody.includes(w)) {
        score += 1;
      }
    }
    const overlaps = words.filter(
      (w) => haystackTitle.includes(w) || haystackBody.includes(w),
    ).length;
    if (overlaps >= 2 || (overlaps === 1 && titleHit)) {
      if (!best || score > best.score) best = { entry, score };
    }
  }
  return best?.entry ?? null;
}
