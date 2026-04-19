/**
 * Session search -- grep across metadata, events, messages, and Claude transcripts.
 * Supports FTS5-indexed transcript search for sub-100ms queries.
 */

import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { AppContext } from "../app.js";

/**
 * Max bytes to read from the tail of large transcript files for indexing.
 * Trade-off: larger value captures more conversation but costs more I/O.
 * 256KB captures ~4x more context than the previous 64KB default while
 * staying fast enough for interactive use.
 */
const MAX_TRANSCRIPT_TAIL_BYTES = 262144;

/** Number of context words for FTS5 snippet() results */
const FTS_SNIPPET_WORDS = 30;

export interface SearchResult {
  sessionId: string;
  source: "metadata" | "event" | "message" | "transcript";
  match: string;
  timestamp?: string;
}

export interface SearchOpts {
  limit?: number;
  transcriptsDir?: string;
}

export function searchSessions(app: AppContext, query: string, opts?: SearchOpts): SearchResult[] {
  const limit = opts?.limit ?? 50;
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  const add = (r: SearchResult) => {
    const key = `${r.sessionId}:${r.source}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push(r);
  };

  const db = app.db;
  const pattern = `%${query}%`;

  // 1. Session metadata
  const metaRows = db
    .prepare(
      `SELECT id, ticket, summary, repo, created_at FROM sessions
     WHERE summary LIKE ? COLLATE NOCASE
        OR ticket LIKE ? COLLATE NOCASE
        OR repo LIKE ? COLLATE NOCASE
     ORDER BY created_at DESC LIMIT ?`,
    )
    .all(pattern, pattern, pattern, limit) as {
    id: string;
    ticket: string | null;
    summary: string | null;
    repo: string | null;
    created_at: string;
  }[];

  for (const row of metaRows) {
    add({
      sessionId: row.id,
      source: "metadata",
      match: row.summary ?? row.ticket ?? row.repo ?? "",
      timestamp: row.created_at,
    });
  }

  // 2. Events
  const eventRows = db
    .prepare(
      `SELECT track_id, data, created_at FROM events
     WHERE data LIKE ? COLLATE NOCASE
     ORDER BY created_at DESC LIMIT ?`,
    )
    .all(pattern, limit) as { track_id: string; data: string | null; created_at: string }[];

  for (const row of eventRows) {
    add({ sessionId: row.track_id, source: "event", match: row.data ?? "", timestamp: row.created_at });
  }

  // 3. Messages
  const msgRows = db
    .prepare(
      `SELECT session_id, content, created_at FROM messages
     WHERE content LIKE ? COLLATE NOCASE
     ORDER BY created_at DESC LIMIT ?`,
    )
    .all(pattern, limit) as { session_id: string; content: string | null; created_at: string }[];

  for (const row of msgRows) {
    add({ sessionId: row.session_id, source: "message", match: row.content ?? "", timestamp: row.created_at });
  }

  return results.slice(0, limit);
}

/** Check if the FTS5 transcript_index table exists in the database */
export function ftsTableExists(app: AppContext): boolean {
  const db = app.db;
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='transcript_index'").get();
  return !!row;
}

export function searchTranscripts(app: AppContext, query: string, opts?: SearchOpts): SearchResult[] {
  const limit = opts?.limit ?? 50;

  // When a custom transcriptsDir is provided, always use file scanning (used by tests)
  if (opts?.transcriptsDir) {
    return searchTranscriptsFiles(query, opts);
  }

  // Use FTS5 index when the table exists (even if empty -- empty means no transcripts indexed yet)
  if (ftsTableExists(app)) {
    return searchTranscriptsFTS(app, query, limit);
  }

  // Fallback to file scanning only when FTS table hasn't been created yet
  return searchTranscriptsFiles(query, opts);
}

function searchTranscriptsFTS(app: AppContext, query: string, limit: number): SearchResult[] {
  const db = app.db;
  const terms = query
    .replace(/['"*()]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (terms.length === 0) return [];

  // Single term: simple FTS query
  if (terms.length === 1) {
    const rows = db
      .prepare(
        `SELECT session_id, role, content, timestamp,
              snippet(transcript_index, 3, '>>>','<<<', '...', ${FTS_SNIPPET_WORDS}) as snippet
       FROM transcript_index
       WHERE transcript_index MATCH ?
       ORDER BY rank
       LIMIT ?`,
      )
      .all(`"${terms[0]}"`, limit) as FtsRow[];
    return rows.map(ftsRowToResult);
  }

  // Multi-term: match at session level (terms can appear in different turns)
  // 1. Find session IDs matching each term, intersect in JS
  let matchingSessions: Set<string> | null = null;
  for (const term of terms) {
    const rows = db
      .prepare(`SELECT DISTINCT session_id FROM transcript_index WHERE transcript_index MATCH ?`)
      .all(`"${term}"`) as { session_id: string }[];
    const ids = new Set(rows.map((r) => r.session_id));
    if (matchingSessions === null) {
      matchingSessions = ids;
    } else {
      matchingSessions = new Set([...matchingSessions].filter((id) => ids.has(id)));
    }
    if (matchingSessions.size === 0) return [];
  }

  // 2. Get snippets from matching sessions (OR query for highlighting)
  const sessionIds = [...matchingSessions!];
  const placeholders = sessionIds.map(() => "?").join(",");
  const orQuery = terms.map((t) => `"${t}"`).join(" OR ");
  const rows = db
    .prepare(
      `SELECT session_id, role, content, timestamp,
            snippet(transcript_index, 3, '>>>','<<<', '...', ${FTS_SNIPPET_WORDS}) as snippet
     FROM transcript_index
     WHERE session_id IN (${placeholders})
       AND transcript_index MATCH ?
     ORDER BY rank
     LIMIT ?`,
    )
    .all(...sessionIds, orQuery, limit) as FtsRow[];
  return rows.map(ftsRowToResult);
}

type FtsRow = {
  session_id: string;
  role: string;
  content: string | null;
  timestamp: string | null;
  snippet: string | null;
};
function ftsRowToResult(r: FtsRow): SearchResult {
  return {
    sessionId: r.session_id,
    source: "transcript",
    match: r.snippet || r.content?.slice(0, 120) || "",
    timestamp: r.timestamp ?? undefined,
  };
}

function searchTranscriptsFiles(query: string, opts?: SearchOpts): SearchResult[] {
  const limit = opts?.limit ?? 50;
  const transcriptsDir = opts?.transcriptsDir ?? join(homedir(), ".claude", "projects");
  const results: SearchResult[] = [];
  const lowerQuery = query.toLowerCase();

  if (!existsSync(transcriptsDir)) return results;

  for (const projectDir of readdirSync(transcriptsDir)) {
    const projectPath = join(transcriptsDir, projectDir);
    let files: string[];
    try {
      files = readdirSync(projectPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      if (results.length >= limit) return results;
      const filePath = join(projectPath, file);
      let content: string;
      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }

      for (const line of content.split("\n")) {
        if (!line.trim() || !line.toLowerCase().includes(lowerQuery)) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type !== "user" && entry.type !== "assistant") continue;
          const text = extractText(entry);
          if (text.toLowerCase().includes(lowerQuery)) {
            results.push({
              sessionId: file.replace(".jsonl", ""),
              source: "transcript",
              match: truncateAround(text, query, 120),
              timestamp: entry.timestamp,
            });
            break; // One match per file
          }
        } catch {
          /* skip malformed JSONL entries */
        }
      }
    }
  }

  return results.slice(0, limit);
}

// ── Per-session conversation ─────────────────────────────────────────────────

/** Get conversation turns for a specific session, ordered chronologically */
export function getSessionConversation(
  app: AppContext,
  sessionId: string,
  opts?: { limit?: number },
): { role: string; content: string; timestamp: string }[] {
  if (!ftsTableExists(app)) return [];
  const db = app.db;
  const limit = opts?.limit ?? 100;
  try {
    return (
      db
        .prepare(
          `SELECT role, content, timestamp FROM transcript_index
       WHERE session_id = ? ORDER BY rowid DESC LIMIT ?`,
        )
        .all(sessionId, limit) as { role: string; content: string; timestamp: string }[]
    ).reverse();
  } catch {
    return [];
  }
}

/** Search within a specific session's conversation */
export function searchSessionConversation(
  app: AppContext,
  sessionId: string,
  query: string,
  opts?: { limit?: number },
): SearchResult[] {
  if (!ftsTableExists(app)) return [];
  const db = app.db;
  const limit = opts?.limit ?? 20;
  const ftsQuery = escapeFtsQuery(query);
  try {
    const rows = db
      .prepare(
        `SELECT role, content, timestamp,
              snippet(transcript_index, 3, '>>>','<<<', '...', ${FTS_SNIPPET_WORDS}) as snippet
       FROM transcript_index
       WHERE session_id = ? AND transcript_index MATCH ?
       ORDER BY rank LIMIT ?`,
      )
      .all(sessionId, ftsQuery, limit) as {
      role: string;
      content: string | null;
      timestamp: string | null;
      snippet: string | null;
    }[];
    return rows.map((r) => ({
      sessionId,
      source: "transcript" as const,
      match: r.snippet || r.content?.slice(0, 120) || "",
      timestamp: r.timestamp,
    }));
  } catch {
    return [];
  }
}

// ── Indexing ──────────────────────────────────────────────────────────────────

export async function indexTranscripts(
  app: AppContext,
  opts?: { transcriptsDir?: string; onProgress?: (indexed: number, total: number) => void },
): Promise<number> {
  const transcriptsDir = opts?.transcriptsDir ?? join(homedir(), ".claude", "projects");
  if (!existsSync(transcriptsDir)) return 0;

  const db = app.db;

  // Clear existing index
  db.exec("DELETE FROM transcript_index");

  const insert = db.prepare(
    "INSERT INTO transcript_index (session_id, project, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
  );

  let indexed = 0;
  let fileCount = 0;
  const projectDirs = readdirSync(transcriptsDir);

  for (const projectDir of projectDirs) {
    const projectPath = join(transcriptsDir, projectDir);
    let files: string[];
    try {
      files = readdirSync(projectPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = join(projectPath, file);
      const sessionId = file.replace(".jsonl", "");

      let content: string;
      try {
        content = readTranscriptTail(filePath);
      } catch {
        continue;
      }

      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type !== "user" && entry.type !== "assistant") continue;
          // Skip tool_result (user) and tool_use-only (assistant) entries
          const content = entry.message?.content;
          if (Array.isArray(content)) {
            if (content.some((c: { type?: string }) => c.type === "tool_result")) continue;
            if (content.every((c: { type?: string }) => c.type === "tool_use")) continue;
          }
          const text = extractText(entry);
          if (!text.trim() || text.length < 10) continue;
          insert.run(sessionId, projectDir, entry.type, text, entry.timestamp ?? null);
          indexed++;
        } catch {
          /* skip malformed entries */
        }
      }

      fileCount++;
      opts?.onProgress?.(indexed, fileCount);

      // Yield after every file so UI stays responsive
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  return indexed;
}

export function indexSession(app: AppContext, transcriptPath: string, sessionId: string, project?: string): number {
  if (!existsSync(transcriptPath)) return 0;

  const db = app.db;

  // Incremental: find the max timestamp already indexed for this session
  let maxTs: string | null = null;
  try {
    const row = db.prepare("SELECT MAX(timestamp) as ts FROM transcript_index WHERE session_id = ?").get(sessionId) as
      | { ts: string | null }
      | undefined;
    maxTs = row?.ts ?? null;
  } catch {
    /* index table may not exist yet */
  }

  const insert = db.prepare(
    "INSERT INTO transcript_index (session_id, project, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
  );

  let indexed = 0;

  let content: string;
  try {
    content = readTranscriptTail(transcriptPath);
  } catch {
    return 0;
  }

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "user" && entry.type !== "assistant") continue;

      // Skip entries we've already indexed (incremental)
      const ts = entry.timestamp ?? null;
      if (maxTs && ts && ts <= maxTs) continue;

      // Skip tool_result (user) and tool_use-only (assistant) entries
      const msgContent = entry.message?.content;
      if (Array.isArray(msgContent)) {
        if (msgContent.some((c: { type?: string }) => c.type === "tool_result")) continue;
        if (msgContent.every((c: { type?: string }) => c.type === "tool_use")) continue;
      }

      const text = extractText(entry);
      if (!text.trim() || text.length < 10) continue;

      insert.run(sessionId, project ?? "", entry.type, text, ts);
      indexed++;
    } catch {
      /* skip malformed entries */
    }
  }

  return indexed;
}

export function getIndexStats(app: AppContext): { entries: number; sessions: number } {
  const db = app.db;
  try {
    const entries =
      (db.prepare("SELECT COUNT(*) as c FROM transcript_index").get() as { c: number } | undefined)?.c ?? 0;
    const sessions =
      (db.prepare("SELECT COUNT(DISTINCT session_id) as c FROM transcript_index").get() as { c: number } | undefined)
        ?.c ?? 0;
    return { entries, sessions };
  } catch {
    return { entries: 0, sessions: 0 };
  }
}

// ── Transcript tail reader ──────────────────────────────────────────────────

/**
 * Read the tail of a transcript file. For files larger than MAX_TRANSCRIPT_TAIL_BYTES
 * (256KB), reads only the last 256KB to capture recent conversation while staying fast.
 * Small files are read in full.
 */
export function readTranscriptTail(filePath: string): string {
  const fstat = statSync(filePath);
  if (fstat.size > MAX_TRANSCRIPT_TAIL_BYTES) {
    const fd = openSync(filePath, "r");
    const buf = Buffer.alloc(MAX_TRANSCRIPT_TAIL_BYTES);
    readSync(fd, buf, 0, MAX_TRANSCRIPT_TAIL_BYTES, fstat.size - MAX_TRANSCRIPT_TAIL_BYTES);
    closeSync(fd);
    return buf.toString("utf-8");
  }
  return readFileSync(filePath, "utf-8");
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Escape and quote terms for FTS5 MATCH queries. */
function escapeFtsQuery(query: string): string {
  return query
    .replace(/['"*()]/g, "")
    .split(/\s+/)
    .map((w) => `"${w}"`)
    .join(" ");
}

function extractText(entry: { message?: { content?: string | Array<{ type?: string; text?: string }> } }): string {
  const msg = entry.message;
  if (!msg) return "";
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join(" ");
  }
  return "";
}

function truncateAround(text: string, query: string, maxLen: number): string {
  const matchIndex = text.toLowerCase().indexOf(query.toLowerCase());
  if (matchIndex === -1) return text.slice(0, maxLen);
  const contextStart = Math.max(0, matchIndex - 40);
  const contextEnd = Math.min(text.length, matchIndex + query.length + 80);
  let result = text.slice(contextStart, contextEnd);
  if (contextStart > 0) result = "..." + result;
  if (contextEnd < text.length) result = result + "...";
  return result;
}
