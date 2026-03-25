/**
 * Claude Code session discovery — cached in SQLite, refreshed from disk on demand.
 *
 * On first call or explicit refresh, scans ~/.claude/projects/ and caches
 * results in claude_sessions_cache table. Subsequent reads are instant SQLite queries.
 */

import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { getDb } from "./store.js";

const execFileAsync = promisify(execFile);

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

/**
 * Fast metadata extraction — reads only first 8KB + last 2KB of the file,
 * NOT the entire 100MB transcript. Uses grep -c for message counting.
 */
async function parseTranscriptMeta(filePath: string): Promise<Omit<ClaudeSession, "project" | "projectDir" | "transcriptPath"> | null> {
  let sessionId = basename(filePath, ".jsonl");
  let timestamp = "";
  let lastActivity = "";
  let summary = "";
  let messageCount = 0;

  try {
    const stat = statSync(filePath);
    if (stat.size === 0) return null;

    // Read first 16KB for header + summary (8KB may miss real messages in tool-heavy sessions)
    const fd = openSync(filePath, "r");
    const headBuf = Buffer.alloc(Math.min(16384, stat.size));
    readSync(fd, headBuf, 0, headBuf.length, 0);

    // Read last 2KB for lastActivity timestamp
    const tailSize = Math.min(2048, stat.size);
    const tailBuf = Buffer.alloc(tailSize);
    readSync(fd, tailBuf, 0, tailSize, Math.max(0, stat.size - tailSize));
    closeSync(fd);

    // Parse head lines for sessionId, timestamp, summary
    const headLines = headBuf.toString("utf-8").split("\n").filter(l => l.trim());
    for (const line of headLines) {
      try {
        const entry = JSON.parse(line);
        if (!timestamp) {
          sessionId = entry.sessionId ?? sessionId;
          timestamp = entry.timestamp ?? "";
        }
        // Try user messages first, fall back to first assistant response
        if ((entry.type === "user" || entry.type === "assistant") && !summary) {
          const msg = entry.message;
          if (msg) {
            let text = "";
            const c = msg.content;
            if (typeof c === "string") text = c;
            else if (Array.isArray(c)) {
              text = c.filter((x: any) => x.type === "text").map((x: any) => x.text).join(" ");
            }
            text = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            if (entry.type === "user" && isRealUserMessage(text)) {
              summary = text.slice(0, 200);
            } else if (entry.type === "assistant" && text.length > 10) {
              // Use assistant response as fallback summary
              summary = text.slice(0, 200);
            }
          }
        }
      } catch {}
    }

    // Parse tail lines for lastActivity
    const tailLines = tailBuf.toString("utf-8").split("\n").filter(l => l.trim());
    for (let i = tailLines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(tailLines[i]);
        if (entry.timestamp) { lastActivity = entry.timestamp; break; }
      } catch {}
    }

    // Fast message count via grep -c (counts lines matching "user" or "assistant")
    try {
      const { stdout: out } = await execFileAsync("grep", ["-c", '"type":"user"\\|"type":"assistant"', filePath], {
        encoding: "utf-8",
      });
      messageCount = parseInt(out.trim()) || 0;
    } catch {
      // grep returns exit 1 if no matches — that's 0 messages
      messageCount = 0;
    }
  } catch {
    return null;
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
export async function refreshClaudeSessionsCache(opts?: { baseDir?: string; onProgress?: (processed: number, total: number) => void }): Promise<number> {
  const baseDir = opts?.baseDir ?? join(homedir(), ".claude", "projects");
  if (!existsSync(baseDir)) return 0;

  const db = getDb();

  const insert = db.prepare(
    `INSERT OR REPLACE INTO claude_sessions_cache
     (session_id, project, project_dir, transcript_path, summary, message_count, timestamp, last_activity, cached_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // Get the most recent cached_at timestamp for incremental refresh
  let lastCachedAt = "";
  try {
    const row = db.prepare("SELECT MAX(cached_at) as max_ts FROM claude_sessions_cache").get() as any;
    lastCachedAt = row?.max_ts ?? "";
  } catch {}
  const lastCachedTime = lastCachedAt ? new Date(lastCachedAt).getTime() : 0;

  let count = 0;
  let skipped = 0;
  let fileCount = 0;
  const now = new Date().toISOString();

  // Count total files first for progress reporting
  let totalFiles = 0;
  for (const pd of readdirSync(baseDir)) {
    const pp = join(baseDir, pd);
    try { if (!statSync(pp).isDirectory()) continue; } catch { continue; }
    const decoded = decodeProjectDir(pd);
    if (decoded.includes("/var/folders/") || decoded.includes("/tmp/") || decoded.includes("/worktrees/") || decoded.includes("/subagents/")) continue;
    try { totalFiles += readdirSync(pp).filter(f => f.endsWith(".jsonl")).length; } catch {}
  }

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
      let fileStat;
      try { fileStat = statSync(filePath); if (!fileStat.isFile()) continue; } catch { continue; }

      fileCount++;

      // Incremental: skip files not modified since last cache
      if (lastCachedTime > 0 && fileStat.mtimeMs <= lastCachedTime) {
        skipped++;
        opts?.onProgress?.(fileCount, totalFiles);
        continue;
      }

      const meta = await parseTranscriptMeta(filePath);
      if (!meta) continue;
      if (meta.messageCount < 10) continue;

      insert.run(
        meta.sessionId, decodedProject, projectDir, filePath,
        meta.summary, meta.messageCount, meta.timestamp, meta.lastActivity, now,
      );
      count++;

      opts?.onProgress?.(fileCount, totalFiles);
      // Yield after every file so TUI stays responsive
      await new Promise(r => setTimeout(r, 0));
    }
  }

  return count;
}
