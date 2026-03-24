/**
 * Session search — grep across metadata, events, messages, and Claude transcripts.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getDb } from "./context.js";

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
