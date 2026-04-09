/**
 * Cross-session memory — persistent knowledge agents can recall.
 * Stores memories with tags, timestamps, and importance scores.
 * Uses text similarity for retrieval (no external vector DB needed).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { AppContext } from "./app.js";

export interface MemoryEntry {
  id: string;
  content: string;
  tags: string[];
  scope: string;       // e.g., "project/myapp", "agent/reviewer", "global"
  importance: number;  // 0-1
  createdAt: string;
  accessedAt: string;
  accessCount: number;
}

function memoryPath(app: AppContext): string {
  return join(app.config.arkDir, "memories.json");
}

function loadAll(app: AppContext): MemoryEntry[] {
  const path = memoryPath(app);
  if (!existsSync(path)) return [];
  try { return JSON.parse(readFileSync(path, "utf-8")); }
  catch { return []; }
}

function saveAll(app: AppContext, entries: MemoryEntry[]): void {
  mkdirSync(app.config.arkDir, { recursive: true });
  writeFileSync(memoryPath(app), JSON.stringify(entries, null, 2));
}

/** Store a memory entry. */
export function remember(app: AppContext, content: string, opts?: {
  tags?: string[];
  scope?: string;
  importance?: number;
}): MemoryEntry {
  const entries = loadAll(app);
  const entry: MemoryEntry = {
    id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    content,
    tags: opts?.tags ?? [],
    scope: opts?.scope ?? "global",
    importance: opts?.importance ?? 0.5,
    createdAt: new Date().toISOString(),
    accessedAt: new Date().toISOString(),
    accessCount: 0,
  };
  entries.push(entry);
  saveAll(app, entries);
  return entry;
}

/** Recall memories relevant to a query. Uses keyword overlap scoring. */
export function recall(app: AppContext, query: string, opts?: {
  scope?: string;
  limit?: number;
  minScore?: number;
}): MemoryEntry[] {
  const entries = loadAll(app);
  const limit = opts?.limit ?? 10;
  const minScore = opts?.minScore ?? 0.1;
  const queryWords = new Set(query.toLowerCase().split(/\s+/).filter(w => w.length > 2));

  const scored = entries
    .filter(e => !opts?.scope || e.scope === opts.scope || e.scope === "global")
    .map(e => {
      const contentWords = new Set(e.content.toLowerCase().split(/\s+/));
      const tagWords = new Set(e.tags.map(t => t.toLowerCase()));

      // Keyword overlap score
      let overlap = 0;
      for (const w of queryWords) {
        if (contentWords.has(w)) overlap++;
        if (tagWords.has(w)) overlap += 2;  // tag matches weighted higher
      }
      const keywordScore = queryWords.size > 0 ? overlap / queryWords.size : 0;

      // Recency score (decays over 30 days)
      const ageMs = Date.now() - new Date(e.accessedAt).getTime();
      const recencyScore = Math.max(0, 1 - ageMs / (30 * 86400000));

      // Composite score
      const score = keywordScore * 0.5 + recencyScore * 0.3 + e.importance * 0.2;

      return { entry: e, score };
    })
    .filter(s => s.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Update access timestamps
  const ids = new Set(scored.map(s => s.entry.id));
  const updated = entries.map(e => {
    if (ids.has(e.id)) {
      return { ...e, accessedAt: new Date().toISOString(), accessCount: e.accessCount + 1 };
    }
    return e;
  });
  saveAll(app, updated);

  return scored.map(s => s.entry);
}

/** Forget a specific memory. */
export function forget(app: AppContext, id: string): boolean {
  const entries = loadAll(app);
  const idx = entries.findIndex(e => e.id === id);
  if (idx < 0) return false;
  entries.splice(idx, 1);
  saveAll(app, entries);
  return true;
}

/** List all memories, optionally filtered by scope. */
export function listMemories(app: AppContext, scope?: string): MemoryEntry[] {
  const entries = loadAll(app);
  if (!scope) return entries;
  return entries.filter(e => e.scope === scope || e.scope === "global");
}

/** Clear all memories for a scope. */
export function clearMemories(app: AppContext, scope?: string): number {
  if (!scope) {
    const count = loadAll(app).length;
    saveAll(app, []);
    return count;
  }
  const entries = loadAll(app);
  const kept = entries.filter(e => e.scope !== scope);
  saveAll(app, kept);
  return entries.length - kept.length;
}

/** Format memories for injection into agent system prompt. */
export function formatMemoriesForPrompt(memories: MemoryEntry[]): string {
  if (memories.length === 0) return "";
  const lines = memories.map(m =>
    `- ${m.content}${m.tags.length ? ` [${m.tags.join(", ")}]` : ""}`
  );
  return `\n## Relevant Memories\n${lines.join("\n")}\n`;
}
