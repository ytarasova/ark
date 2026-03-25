/**
 * Session search — grep across metadata, events, messages, and Claude transcripts.
 * Supports FTS5-indexed transcript search for sub-100ms queries.
 */

import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getDb } from "./store.js";

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

export function searchSessions(query: string, opts?: SearchOpts): SearchResult[] {
  const limit = opts?.limit ?? 50;
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  const add = (r: SearchResult) => {
    const key = `${r.sessionId}:${r.source}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push(r);
  };

  const db = getDb();
  const pattern = `%${query}%`;

  // 1. Session metadata
  const metaRows = db.prepare(
    `SELECT id, jira_key, jira_summary, repo, created_at FROM sessions
     WHERE jira_summary LIKE ? COLLATE NOCASE
        OR jira_key LIKE ? COLLATE NOCASE
        OR repo LIKE ? COLLATE NOCASE
     ORDER BY created_at DESC LIMIT ?`
  ).all(pattern, pattern, pattern, limit) as any[];

  for (const row of metaRows) {
    add({ sessionId: row.id, source: "metadata", match: row.jira_summary ?? row.jira_key ?? row.repo ?? "", timestamp: row.created_at });
  }

  // 2. Events
  const eventRows = db.prepare(
    `SELECT track_id, data, created_at FROM events
     WHERE data LIKE ? COLLATE NOCASE
     ORDER BY created_at DESC LIMIT ?`
  ).all(pattern, limit) as any[];

  for (const row of eventRows) {
    add({ sessionId: row.track_id, source: "event", match: row.data ?? "", timestamp: row.created_at });
  }

  // 3. Messages
  const msgRows = db.prepare(
    `SELECT session_id, content, created_at FROM messages
     WHERE content LIKE ? COLLATE NOCASE
     ORDER BY created_at DESC LIMIT ?`
  ).all(pattern, limit) as any[];

  for (const row of msgRows) {
    add({ sessionId: row.session_id, source: "message", match: row.content ?? "", timestamp: row.created_at });
  }

  return results.slice(0, limit);
}

export function searchTranscripts(query: string, opts?: SearchOpts): SearchResult[] {
  const limit = opts?.limit ?? 50;

  // Try FTS5 index first
  const db = getDb();
  try {
    const count = (db.prepare("SELECT COUNT(*) as c FROM transcript_index").get() as any)?.c ?? 0;
    if (count > 0) {
      return searchTranscriptsFTS(query, limit);
    }
  } catch { /* FTS5 table may not exist yet */ }

  // Fallback to file scanning
  return searchTranscriptsFiles(query, opts);
}

function searchTranscriptsFTS(query: string, limit: number): SearchResult[] {
  const db = getDb();
  // FTS5 match query — escape special chars, use quoted terms
  const ftsQuery = query.replace(/['"*()]/g, "").split(/\s+/).map(w => `"${w}"`).join(" ");

  const rows = db.prepare(
    `SELECT session_id, role, content, timestamp,
            snippet(transcript_index, 3, '>>>','<<<', '...', 30) as snippet
     FROM transcript_index
     WHERE transcript_index MATCH ?
     ORDER BY rank
     LIMIT ?`
  ).all(ftsQuery, limit) as any[];

  return rows.map(r => ({
    sessionId: r.session_id,
    source: "transcript" as const,
    match: r.snippet || r.content?.slice(0, 120) || "",
    timestamp: r.timestamp,
  }));
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
    try { files = readdirSync(projectPath).filter(f => f.endsWith(".jsonl")); } catch { continue; }

    for (const file of files) {
      if (results.length >= limit) return results;
      const filePath = join(projectPath, file);
      let content: string;
      try { content = readFileSync(filePath, "utf-8"); } catch { continue; }

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
        } catch {}
      }
    }
  }

  return results.slice(0, limit);
}

// ── Per-session conversation ─────────────────────────────────────────────────

/** Get conversation turns for a specific session, ordered chronologically */
export function getSessionConversation(sessionId: string, opts?: { limit?: number }): { role: string; content: string; timestamp: string }[] {
  const db = getDb();
  const limit = opts?.limit ?? 100;
  try {
    return db.prepare(
      `SELECT role, content, timestamp FROM transcript_index
       WHERE session_id = ? ORDER BY rowid DESC LIMIT ?`
    ).all(sessionId, limit).reverse() as any[];
  } catch { return []; }
}

/** Search within a specific session's conversation */
export function searchSessionConversation(sessionId: string, query: string, opts?: { limit?: number }): SearchResult[] {
  const db = getDb();
  const limit = opts?.limit ?? 20;
  const ftsQuery = query.replace(/['"*()]/g, "").split(/\s+/).map(w => `"${w}"`).join(" ");
  try {
    const rows = db.prepare(
      `SELECT role, content, timestamp,
              snippet(transcript_index, 3, '>>>','<<<', '...', 30) as snippet
       FROM transcript_index
       WHERE session_id = ? AND transcript_index MATCH ?
       ORDER BY rank LIMIT ?`
    ).all(sessionId, ftsQuery, limit) as any[];
    return rows.map(r => ({
      sessionId,
      source: "transcript" as const,
      match: r.snippet || r.content?.slice(0, 120) || "",
      timestamp: r.timestamp,
    }));
  } catch { return []; }
}

// ── Indexing ──────────────────────────────────────────────────────────────────

export async function indexTranscripts(opts?: { transcriptsDir?: string; onProgress?: (indexed: number, total: number) => void }): Promise<number> {
  const transcriptsDir = opts?.transcriptsDir ?? join(homedir(), ".claude", "projects");
  if (!existsSync(transcriptsDir)) return 0;

  const db = getDb();

  // Clear existing index
  db.exec("DELETE FROM transcript_index");

  const insert = db.prepare(
    "INSERT INTO transcript_index (session_id, project, role, content, timestamp) VALUES (?, ?, ?, ?, ?)"
  );

  let indexed = 0;
  let fileCount = 0;
  const projectDirs = readdirSync(transcriptsDir);

  for (const projectDir of projectDirs) {
    const projectPath = join(transcriptsDir, projectDir);
    let files: string[];
    try { files = readdirSync(projectPath).filter(f => f.endsWith(".jsonl")); } catch { continue; }

    for (const file of files) {
      const filePath = join(projectPath, file);
      const sessionId = file.replace(".jsonl", "");

      // For large files, read only the last 64KB (recent conversation)
      // For small files, read the whole thing
      let content: string;
      try {
        const fstat = statSync(filePath);
        if (fstat.size > 65536) {
          // Large file — read tail only (recent conversation)
          const fd = openSync(filePath, "r");
          const buf = Buffer.alloc(65536);
          readSync(fd, buf, 0, 65536, fstat.size - 65536);
          closeSync(fd);
          content = buf.toString("utf-8");
        } else {
          content = readFileSync(filePath, "utf-8");
        }
      } catch { continue; }

      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type !== "user" && entry.type !== "assistant") continue;
          // Skip tool_result (user) and tool_use-only (assistant) entries
          const content = entry.message?.content;
          if (Array.isArray(content)) {
            if (content.some((c: any) => c.type === "tool_result")) continue;
            if (content.every((c: any) => c.type === "tool_use")) continue;
          }
          const text = extractText(entry);
          if (!text.trim() || text.length < 10) continue;
          insert.run(sessionId, projectDir, entry.type, text, entry.timestamp ?? null);
          indexed++;
        } catch {}
      }

      fileCount++;
      opts?.onProgress?.(indexed, fileCount);

      // Yield after every file so TUI stays responsive
      await new Promise(r => setTimeout(r, 0));
    }
  }

  return indexed;
}

export function indexSession(transcriptPath: string, sessionId: string, project?: string): number {
  if (!existsSync(transcriptPath)) return 0;

  const db = getDb();

  // Incremental: find the max timestamp already indexed for this session
  let maxTs: string | null = null;
  try {
    const row = db.prepare(
      "SELECT MAX(timestamp) as ts FROM transcript_index WHERE session_id = ?"
    ).get(sessionId) as any;
    maxTs = row?.ts ?? null;
  } catch {}

  const insert = db.prepare(
    "INSERT INTO transcript_index (session_id, project, role, content, timestamp) VALUES (?, ?, ?, ?, ?)"
  );

  let indexed = 0;

  // For large files, read only the last 64KB (recent conversation)
  let content: string;
  try {
    const fstat = statSync(transcriptPath);
    if (fstat.size > 65536) {
      const fd = openSync(transcriptPath, "r");
      const buf = Buffer.alloc(65536);
      readSync(fd, buf, 0, 65536, fstat.size - 65536);
      closeSync(fd);
      content = buf.toString("utf-8");
    } else {
      content = readFileSync(transcriptPath, "utf-8");
    }
  } catch { return 0; }

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
        if (msgContent.some((c: any) => c.type === "tool_result")) continue;
        if (msgContent.every((c: any) => c.type === "tool_use")) continue;
      }

      const text = extractText(entry);
      if (!text.trim() || text.length < 10) continue;

      insert.run(sessionId, project ?? "", entry.type, text, ts);
      indexed++;
    } catch {}
  }

  return indexed;
}

export function getIndexStats(): { entries: number; sessions: number } {
  const db = getDb();
  try {
    const entries = (db.prepare("SELECT COUNT(*) as c FROM transcript_index").get() as any)?.c ?? 0;
    const sessions = (db.prepare("SELECT COUNT(DISTINCT session_id) as c FROM transcript_index").get() as any)?.c ?? 0;
    return { entries, sessions };
  } catch {
    return { entries: 0, sessions: 0 };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractText(entry: any): string {
  const msg = entry.message;
  if (!msg) return "";
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ");
  }
  return "";
}

function truncateAround(text: string, query: string, maxLen: number): string {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, maxLen);
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + query.length + 80);
  let result = text.slice(start, end);
  if (start > 0) result = "..." + result;
  if (end < text.length) result = result + "...";
  return result;
}
