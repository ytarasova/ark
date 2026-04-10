/**
 * Claude Code session discovery — cached in SQLite, refreshed from disk on demand.
 *
 * On first call or explicit refresh, scans ~/.claude/projects/ and caches
 * results in claude_sessions_cache table. Subsequent reads are instant SQLite queries.
 */

import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import type { AppContext } from "../app.js";

const execFileAsync = promisify(execFile);

/** Bytes to read from the start of a transcript for header + summary extraction */
const TRANSCRIPT_HEAD_BYTES = 16384;

/** Bytes to read from the end of a transcript for lastActivity timestamp */
const TRANSCRIPT_TAIL_BYTES = 2048;

/** Minimum message count to include a session in the cache */
const MIN_MESSAGE_COUNT = 5;

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
    const headBuf = Buffer.alloc(Math.min(TRANSCRIPT_HEAD_BYTES, stat.size));
    readSync(fd, headBuf, 0, headBuf.length, 0);

    // Read last 2KB for lastActivity timestamp
    const tailSize = Math.min(TRANSCRIPT_TAIL_BYTES, stat.size);
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
              text = c.filter((x: { type: string; text?: string }) => x.type === "text").map((x: { type: string; text?: string }) => x.text ?? "").join(" ");
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
      } catch {
          // Truncated or malformed JSON lines are expected in partial transcript reads
        }
    }

    // Parse tail lines for lastActivity
    const tailLines = tailBuf.toString("utf-8").split("\n").filter(l => l.trim());
    for (let i = tailLines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(tailLines[i]);
        if (entry.timestamp) { lastActivity = entry.timestamp; break; }
      } catch {
          // Truncated JSON in tail buffer is expected — last line is often incomplete
        }
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
  } catch (e: any) {
    console.error(`parseTranscriptMeta(${filePath}):`, e?.message ?? e);
    return null;
  }

  return { sessionId, timestamp, lastActivity, summary, messageCount };
}

// ── Row types for bun:sqlite queries ─────────────────────────────────────────

/** Raw row shape from the claude_sessions_cache table. */
interface ClaudeSessionCacheRow {
  session_id: string;
  project: string;
  project_dir: string;
  transcript_path: string;
  summary: string;
  message_count: number;
  timestamp: string;
  last_activity: string;
  cached_at: string;
}

/** Result of SELECT MAX(cached_at) query. */
interface MaxTsRow {
  max_ts: string | null;
}

// ── Cache layer ──────────────────────────────────────────────────────────────

/**
 * List Claude sessions from cache (instant).
 * Call refreshClaudeSessionsCache() to populate/update the cache.
 */
export function listClaudeSessions(app: AppContext, opts?: ListOpts): ClaudeSession[] {
  const db = app.db;
  const limit = opts?.limit ?? 100;

  let sql = "SELECT * FROM claude_sessions_cache WHERE 1=1";
  const params: (string | number)[] = [];

  if (opts?.project) {
    sql += " AND project LIKE ? COLLATE NOCASE";
    params.push(`%${opts.project}%`);
  }

  sql += " ORDER BY last_activity DESC LIMIT ?";
  params.push(limit);

  try {
    const rows = db.prepare(sql).all(...params) as ClaudeSessionCacheRow[];
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
  } catch (e: any) {
    // Table may not exist yet on first run — SQLITE_ERROR is expected
    if (!String(e?.message).includes("no such table")) {
      console.error("listClaudeSessions:", e?.message ?? e);
    }
    return [];
  }
}

/**
 * Find a specific Claude session by ID (prefix match supported).
 */
export function getClaudeSession(app: AppContext, sessionId: string, _opts?: ListOpts): ClaudeSession | null {
  const db = app.db;
  try {
    const row = db.prepare(
      "SELECT * FROM claude_sessions_cache WHERE session_id = ? OR session_id LIKE ?"
    ).get(sessionId, `${sessionId}%`) as ClaudeSessionCacheRow | undefined;
    if (!row) return null;
    return {
      sessionId: row.session_id, project: row.project, projectDir: row.project_dir,
      transcriptPath: row.transcript_path, summary: row.summary,
      messageCount: row.message_count, timestamp: row.timestamp, lastActivity: row.last_activity,
    };
  } catch (e: any) {
    if (!String(e?.message).includes("no such table")) {
      console.error("getClaudeSession:", e?.message ?? e);
    }
    return null;
  }
}

/**
 * Refresh the cache by scanning ~/.claude/projects/.
 * Async with periodic yields so the TUI stays responsive.
 */
export async function refreshClaudeSessionsCache(app: AppContext, opts?: { baseDir?: string; onProgress?: (processed: number, total: number) => void }): Promise<number> {
  const baseDir = opts?.baseDir ?? join(homedir(), ".claude", "projects");
  if (!existsSync(baseDir)) return 0;

  const db = app.db;

  const insert = db.prepare(
    `INSERT OR REPLACE INTO claude_sessions_cache
     (session_id, project, project_dir, transcript_path, summary, message_count, timestamp, last_activity, cached_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // Get the most recent cached_at timestamp for incremental refresh
  let lastCachedAt = "";
  try {
    const row = db.prepare("SELECT MAX(cached_at) as max_ts FROM claude_sessions_cache").get() as MaxTsRow | undefined;
    lastCachedAt = row?.max_ts ?? "";
  } catch (e: any) {
    // Table may not exist yet on first refresh — that's fine, we'll do a full scan
    if (!String(e?.message).includes("no such table")) {
      console.error("refreshClaudeSessionsCache (read max cached_at):", e?.message ?? e);
    }
  }
  const lastCachedTime = lastCachedAt ? new Date(lastCachedAt).getTime() : 0;

  let count = 0;
  let _skipped = 0;
  let fileCount = 0;
  const now = new Date().toISOString();

  // Count total files first for progress reporting
  let totalFiles = 0;
  for (const pd of readdirSync(baseDir)) {
    const pp = join(baseDir, pd);
    try { if (!statSync(pp).isDirectory()) continue; } catch (e: any) { if (e?.code !== 'ENOENT') console.error('refreshClaudeSessionsCache (stat project dir):', e?.message ?? e); continue; }
    const decoded = decodeProjectDir(pd);
    if (decoded.includes("/var/folders/") || decoded.includes("/tmp/") || decoded.includes("/worktrees/") || decoded.includes("/subagents/")) continue;
    try { totalFiles += readdirSync(pp).filter(f => f.endsWith(".jsonl")).length; } catch (e: any) { if (e?.code !== 'ENOENT') console.error('refreshClaudeSessionsCache (readdir for count):', e?.message ?? e); }
  }

  for (const projectDir of readdirSync(baseDir)) {
    const projectPath = join(baseDir, projectDir);
    try { if (!statSync(projectPath).isDirectory()) continue; } catch (e: any) { if (e?.code !== 'ENOENT') console.error('refreshClaudeSessionsCache (stat project):', e?.message ?? e); continue; }

    const decodedProject = decodeProjectDir(projectDir);

    // Skip temp dirs, worktrees, test artifacts
    if (decodedProject.includes("/var/folders/") ||
        decodedProject.includes("/tmp/") ||
        decodedProject.includes("/worktrees/") ||
        decodedProject.includes("/subagents/")) continue;

    let files: string[];
    try { files = readdirSync(projectPath).filter(f => f.endsWith(".jsonl")); } catch (e: any) { if (e?.code !== 'ENOENT') console.error('refreshClaudeSessionsCache (readdir):', e?.message ?? e); continue; }

    for (const file of files) {
      const filePath = join(projectPath, file);
      let fileStat;
      try { fileStat = statSync(filePath); if (!fileStat.isFile()) continue; } catch (e: any) { if (e?.code !== 'ENOENT') console.error('refreshClaudeSessionsCache (stat file):', e?.message ?? e); continue; }

      fileCount++;

      // Incremental: skip files not modified since last cache
      // Use Math.floor to handle sub-millisecond mtime precision on APFS/ext4
      if (lastCachedTime > 0 && Math.floor(fileStat.mtimeMs) <= lastCachedTime) {
        _skipped++;
        opts?.onProgress?.(fileCount, totalFiles);
        continue;
      }

      const meta = await parseTranscriptMeta(filePath);
      if (!meta) continue;
      if (meta.messageCount < MIN_MESSAGE_COUNT) continue;

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
