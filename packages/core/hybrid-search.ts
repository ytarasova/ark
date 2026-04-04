/**
 * Unified hybrid search — merges memory, knowledge, and transcript results,
 * deduplicates, and optionally re-ranks via Claude Haiku.
 */

import { recall, type MemoryEntry } from "./memory.js";
import { queryKnowledge } from "./knowledge.js";
import { searchTranscripts, type SearchResult as TranscriptSearchResult } from "./search.js";
import { createHash } from "crypto";

// ── Types ──────────────────────────────────────────────────────────────────

export interface HybridSearchResult {
  source: "memory" | "knowledge" | "transcript";
  content: string;
  score: number;
  metadata: {
    id?: string;
    sessionId?: string;
    tags?: string[];
    timestamp?: string;
  };
}

export interface HybridSearchOpts {
  limit?: number;
  sources?: Array<"memory" | "knowledge" | "transcript">;
  rerank?: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function contentHash(s: string): string {
  return createHash("md5").update(s.trim().toLowerCase()).digest("hex");
}

function memoryToResult(entry: MemoryEntry, source: "memory" | "knowledge"): HybridSearchResult {
  return {
    source,
    content: entry.content,
    score: entry.importance,
    metadata: { id: entry.id, tags: entry.tags, timestamp: entry.accessedAt },
  };
}

function transcriptToResult(r: TranscriptSearchResult): HybridSearchResult {
  return {
    source: "transcript",
    content: r.match,
    score: 0.5,
    metadata: { sessionId: r.sessionId, timestamp: r.timestamp },
  };
}

// ── Merge & Dedup ──────────────────────────────────────────────────────────

export function mergeAndDeduplicate(results: HybridSearchResult[]): HybridSearchResult[] {
  const sorted = [...results].sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const deduped: HybridSearchResult[] = [];
  for (const r of sorted) {
    const hash = contentHash(r.content);
    if (!seen.has(hash)) {
      seen.add(hash);
      deduped.push(r);
    }
  }
  return deduped;
}

// ── Re-ranking ─────────────────────────────────────────────────────────────

async function rerankWithClaude(query: string, candidates: HybridSearchResult[]): Promise<HybridSearchResult[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return candidates;

  const numbered = candidates.map((c, i) => `[${i}] ${c.content.slice(0, 200)}`).join("\n");
  const prompt = `Given the search query: "${query}"

Rank these search results by relevance. Return ONLY a JSON array of objects with "index" (0-based) and "score" (0.0-1.0). Most relevant first. Example: [{"index": 0, "score": 0.95}, {"index": 2, "score": 0.7}]

Results:
${numbered}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json() as any;
    const text = data.content?.[0]?.text ?? "";
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return candidates;

    const rankings = JSON.parse(match[0]) as Array<{ index: number; score: number }>;
    const reranked: HybridSearchResult[] = [];
    for (const r of rankings) {
      if (r.index >= 0 && r.index < candidates.length) {
        reranked.push({ ...candidates[r.index], score: r.score });
      }
    }

    const rankedIndices = new Set(rankings.map(r => r.index));
    for (let i = 0; i < candidates.length; i++) {
      if (!rankedIndices.has(i)) {
        reranked.push({ ...candidates[i], score: 0 });
      }
    }

    return reranked.sort((a, b) => b.score - a.score);
  } catch {
    return candidates;
  }
}

// ── Main API ───────────────────────────────────────────────────────────────

export async function hybridSearch(
  query: string,
  opts?: HybridSearchOpts,
): Promise<HybridSearchResult[]> {
  const limit = opts?.limit ?? 10;
  const sources = opts?.sources ?? ["memory", "knowledge", "transcript"];
  const shouldRerank = opts?.rerank ?? true;

  const allResults: HybridSearchResult[] = [];

  if (sources.includes("memory")) {
    const memories = recall(query, { limit: 20 });
    allResults.push(...memories.map(m => memoryToResult(m, "memory")));
  }

  if (sources.includes("knowledge")) {
    const knowledge = queryKnowledge(query, { limit: 20 });
    allResults.push(...knowledge.map(m => memoryToResult(m, "knowledge")));
  }

  if (sources.includes("transcript")) {
    const transcripts = searchTranscripts(query, { limit: 20 });
    allResults.push(...transcripts.map(transcriptToResult));
  }

  if (allResults.length === 0) return [];

  let candidates = mergeAndDeduplicate(allResults);
  candidates = candidates.slice(0, 40);

  if (shouldRerank && candidates.length > 1) {
    candidates = await rerankWithClaude(query, candidates);
  }

  return candidates.slice(0, limit);
}
