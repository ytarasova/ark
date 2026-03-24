/**
 * Claude Code session discovery — scan ~/.claude/projects/ for transcripts.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

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
const JUNK_PREFIXES = ["Caveat:", "<local-command", "<command-", "<system-reminder", "<channel"];

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

  // Only scan first 100 lines for header info + summary (don't read entire 50MB file)
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

      // Only look for summary in first 100 lines
      if (i < scanLimit && entry.type === "user" && !summary) {
        const msg = entry.message;
        if (msg) {
          let text = "";
          const c = msg.content;
          if (typeof c === "string") {
            text = c;
          } else if (Array.isArray(c)) {
            text = c.filter((x: any) => x.type === "text").map((x: any) => x.text).join(" ");
          }
          // Strip HTML/XML tags, then check if it's a real message
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

export async function listClaudeSessions(opts?: ListOpts): Promise<ClaudeSession[]> {
  const baseDir = opts?.baseDir ?? join(homedir(), ".claude", "projects");
  const limit = opts?.limit ?? 100;

  if (!existsSync(baseDir)) return [];

  const sessions: ClaudeSession[] = [];
  let fileCount = 0;

  for (const projectDir of readdirSync(baseDir)) {
    const projectPath = join(baseDir, projectDir);
    try { if (!statSync(projectPath).isDirectory()) continue; } catch { continue; }

    const decodedProject = decodeProjectDir(projectDir);

    // Skip temp dirs, worktrees, and test artifacts
    if (decodedProject.includes("/var/folders/") ||
        decodedProject.includes("/tmp/") ||
        decodedProject.includes("/worktrees/") ||
        decodedProject.includes("/subagents/")) continue;

    if (opts?.project && !decodedProject.toLowerCase().includes(opts.project.toLowerCase())) continue;

    let files: string[];
    try {
      files = readdirSync(projectPath).filter(f => f.endsWith(".jsonl"));
    } catch { continue; }

    for (const file of files) {
      const filePath = join(projectPath, file);
      try { if (!statSync(filePath).isFile()) continue; } catch { continue; }

      const meta = parseTranscriptMeta(filePath);
      if (!meta) continue;

      sessions.push({
        ...meta,
        project: decodedProject,
        projectDir,
        transcriptPath: filePath,
      });

      fileCount++;
      // Yield to event loop every 5 files so TUI stays responsive
      if (fileCount % 5 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }
  }

  sessions.sort((a, b) => (b.lastActivity || b.timestamp).localeCompare(a.lastActivity || a.timestamp));
  return sessions.slice(0, limit);
}

export async function getClaudeSession(sessionId: string, opts?: ListOpts): Promise<ClaudeSession | null> {
  const all = await listClaudeSessions({ ...opts, limit: 10000 });
  return all.find(s => s.sessionId === sessionId || s.sessionId.startsWith(sessionId)) ?? null;
}
