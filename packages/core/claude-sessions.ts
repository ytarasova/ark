/**
 * Claude Code session discovery — cached in SQLite, refreshed from disk on demand.
 *
 * On first call or explicit refresh, scans ~/.claude/projects/ and caches
 * results in claude_sessions_cache table. Subsequent reads are instant SQLite queries.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { getDb } from "./store.js";

export interface ClaudeSession {
  sessionId: string;
  project: string;
  projectDir: string;
  transcriptPath: string;
  summary: string;
  messageCount: number;
  timestamp: string;
  lastActivity: string;
}

export interface ListOpts {
  baseDir?: string;
  limit?: number;
  project?: string;
}

function decodeProjectDir(dirName: string): string {
  return dirName.replace(/^-/, "/").replace(/-/g, "/");
}

/** Junk prefixes in user messages that aren't real prompts */
const JUNK_PREFIXES = [
  // System/channel noise
  "Caveat:", "<local-command", "<command-", "<system-reminder", "<channel",
  "Listening for channel", '"""', "Base directory for this skill",
  // Ark agent task assignments
  "Session s-", "Work on s-",
  "You are the worker agent", "You are the implementer agent",
  "You are the planner agent", "You are the reviewer agent",
  "You are a healing agent",
  // Slash commands
  "/effort", "/remote-control", "/resume", "/clear", "/plugin",
  "/compact", "/help", "/init",
  // Interrupted/error states
  "[Request interrupted",
  // Repetitive automated prompts
  "Describe this image", "Read the image at",
  "say hello",
];

function isRealUserMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < 3) return false;
  return !JUNK_PREFIXES.some(p => trimmed.startsWith(p));
}

function parseTranscriptMeta(filePath: string): Omit<ClaudeSession, "project" | "projectDir" | "transcriptPath"> | null {
  let content: string;
  try { content = readFileSync(filePath, "utf-8"); } catch { return null; }

  const lines = content.split("\n").filter(l => l.trim());
  if (lines.length === 0) return null;

  let sessionId = basename(filePath, ".jsonl");
  let timestamp = "";
  let lastActivity = "";
  let summary = "";
  let messageCount = 0;

  const scanLimit = Math.min(lines.length, 100);

  for (let i = 0; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      if (!timestamp) {
        sessionId = entry.sessionId ?? sessionId;
        timestamp = entry.timestamp ?? "";
      }
      lastActivity = entry.timestamp ?? lastActivity;

      if (entry.type === "user" || entry.type === "assistant") {
        messageCount++;
      }

      if (i < scanLimit && entry.type === "user" && !summary) {
        const msg = entry.message;
        if (msg) {
          let text = "";
          const c = msg.content;
          if (typeof c === "string") text = c;
          else if (Array.isArray(c)) {
            text = c.filter((x: any) => x.type === "text").map((x: any) => x.text).join(" ");
          }
          text = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
          if (isRealUserMessage(text)) {
            summary = text.slice(0, 200);
          }
        }
      }
    } catch {}
  }

  return { sessionId, timestamp, lastActivity, summary, messageCount };
}

// ── Cache layer ──────────────────────────────────────────────────────────────

/**
 * List Claude sessions from cache (instant).
 * Call refreshClaudeSessionsCache() to populate/update the cache.
 */
export function listClaudeSessions(opts?: ListOpts): ClaudeSession[] {
  const db = getDb();
  const limit = opts?.limit ?? 100;

  let sql = "SELECT * FROM claude_sessions_cache WHERE 1=1";
  const params: any[] = [];

  if (opts?.project) {
    sql += " AND project LIKE ? COLLATE NOCASE";
    params.push(`%${opts.project}%`);
  }

  sql += " ORDER BY last_activity DESC LIMIT ?";
  params.push(limit);

  try {
    const rows = db.prepare(sql).all(...params) as any[];
    return rows.map(r => ({
      sessionId: r.session_id,
      project: r.project,
      projectDir: r.project_dir,
      transcriptPath: r.transcript_path,
      summary: r.summary,
      messageCount: r.message_count,
      timestamp: r.timestamp,
      lastActivity: r.last_activity,
    }));
  } catch {
    return []; // table may not exist yet
  }
}

/**
 * Find a specific Claude session by ID (prefix match supported).
 */
export function getClaudeSession(sessionId: string, opts?: ListOpts): ClaudeSession | null {
  const db = getDb();
  try {
    const row = db.prepare(
      "SELECT * FROM claude_sessions_cache WHERE session_id = ? OR session_id LIKE ?"
    ).get(sessionId, `${sessionId}%`) as any;
    if (!row) return null;
    return {
      sessionId: row.session_id, project: row.project, projectDir: row.project_dir,
      transcriptPath: row.transcript_path, summary: row.summary,
      messageCount: row.message_count, timestamp: row.timestamp, lastActivity: row.last_activity,
    };
  } catch {
    return null;
  }
}

/**
 * Refresh the cache by scanning ~/.claude/projects/.
 * Async with periodic yields so the TUI stays responsive.
 */
export async function refreshClaudeSessionsCache(opts?: { baseDir?: string }): Promise<number> {
  const baseDir = opts?.baseDir ?? join(homedir(), ".claude", "projects");
  if (!existsSync(baseDir)) return 0;

  const db = getDb();

  // Clear stale cache before rebuild
  db.exec("DELETE FROM claude_sessions_cache");

  const insert = db.prepare(
    `INSERT OR REPLACE INTO claude_sessions_cache
     (session_id, project, project_dir, transcript_path, summary, message_count, timestamp, last_activity, cached_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let count = 0;
  let fileCount = 0;
  const now = new Date().toISOString();

  for (const projectDir of readdirSync(baseDir)) {
    const projectPath = join(baseDir, projectDir);
    try { if (!statSync(projectPath).isDirectory()) continue; } catch { continue; }

    const decodedProject = decodeProjectDir(projectDir);

    // Skip temp dirs, worktrees, test artifacts
    if (decodedProject.includes("/var/folders/") ||
        decodedProject.includes("/tmp/") ||
        decodedProject.includes("/worktrees/") ||
        decodedProject.includes("/subagents/")) continue;

    let files: string[];
    try { files = readdirSync(projectPath).filter(f => f.endsWith(".jsonl")); } catch { continue; }

    for (const file of files) {
      const filePath = join(projectPath, file);
      try { if (!statSync(filePath).isFile()) continue; } catch { continue; }

      const meta = parseTranscriptMeta(filePath);
      if (!meta) continue;
      // Skip trivial sessions — need real conversations (10+ messages)
      if (meta.messageCount < 10) continue;

      insert.run(
        meta.sessionId, decodedProject, projectDir, filePath,
        meta.summary, meta.messageCount, meta.timestamp, meta.lastActivity, now,
      );
      count++;

      fileCount++;
      if (fileCount % 5 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }
  }

  return count;
}
