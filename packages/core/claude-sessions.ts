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

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (!timestamp) {
        sessionId = entry.sessionId ?? sessionId;
        timestamp = entry.timestamp ?? "";
      }
      lastActivity = entry.timestamp ?? lastActivity;

      if (entry.type === "user" || entry.type === "assistant") {
        messageCount++;
      }

      if (entry.type === "user" && !summary) {
        const msg = entry.message;
        if (msg) {
          const c = msg.content;
          if (typeof c === "string") {
            summary = c;
          } else if (Array.isArray(c)) {
            summary = c.filter((x: any) => x.type === "text").map((x: any) => x.text).join(" ");
          }
          summary = summary.replace(/<[^>]+>/g, " ").trim().slice(0, 200);
        }
      }
    } catch {}
  }

  return { sessionId, timestamp, lastActivity, summary, messageCount };
}

export function listClaudeSessions(opts?: ListOpts): ClaudeSession[] {
  const baseDir = opts?.baseDir ?? join(homedir(), ".claude", "projects");
  const limit = opts?.limit ?? 100;

  if (!existsSync(baseDir)) return [];

  const sessions: ClaudeSession[] = [];

  for (const projectDir of readdirSync(baseDir)) {
    const projectPath = join(baseDir, projectDir);
    try { if (!statSync(projectPath).isDirectory()) continue; } catch { continue; }

    const decodedProject = decodeProjectDir(projectDir);
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
    }
  }

  sessions.sort((a, b) => (b.lastActivity || b.timestamp).localeCompare(a.lastActivity || a.timestamp));
  return sessions.slice(0, limit);
}

export function getClaudeSession(sessionId: string, opts?: ListOpts): ClaudeSession | null {
  const all = listClaudeSessions({ ...opts, limit: 10000 });
  return all.find(s => s.sessionId === sessionId || s.sessionId.startsWith(sessionId)) ?? null;
}
