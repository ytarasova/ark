/**
 * Global search across all Claude Code conversations.
 * Scans ~/.claude/projects/ for JSONL transcripts.
 */

import { readdirSync, readFileSync, statSync, existsSync, openSync, readSync, closeSync, fstatSync } from "fs";
import { join } from "path";

export interface GlobalSearchResult {
  projectPath: string;
  projectName: string;
  fileName: string;
  matchLine: string;
  lineNumber: number;
  modifiedAt: Date;
}

const CLAUDE_PROJECTS_DIR = join(
  process.env.HOME ?? process.env.USERPROFILE ?? "~",
  ".claude", "projects"
);

/** Search all Claude conversations for a query string. */
export function searchAllConversations(query: string, opts?: {
  maxResults?: number;
  recentDays?: number;
}): GlobalSearchResult[] {
  const maxResults = opts?.maxResults ?? 50;
  const recentDays = opts?.recentDays ?? 90;
  const cutoff = Date.now() - recentDays * 24 * 60 * 60 * 1000;
  const results: GlobalSearchResult[] = [];
  const queryLower = query.toLowerCase();

  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];

  try {
    // Use withFileTypes to avoid separate stat() calls per directory entry
    const entries = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });

    for (const dirEntry of entries) {
      if (results.length >= maxResults) break;
      if (!dirEntry.isDirectory()) continue;
      const projectDir = join(CLAUDE_PROJECTS_DIR, dirEntry.name);
      const projectName = decodeProjectName(dirEntry.name);

      // Scan JSONL files in the project directory
      try {
        const files = readdirSync(projectDir).filter(f => f.endsWith(".jsonl"));
        for (const file of files) {
          if (results.length >= maxResults) break;
          const filePath = join(projectDir, file);

          try {
            const stat = statSync(filePath);
            if (stat.mtimeMs < cutoff) continue;

            // Read last 64KB for large files
            const content = stat.size > 65536
              ? readLastBytes(filePath, 65536)
              : readFileSync(filePath, "utf-8");

            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (results.length >= maxResults) break;
              const line = lines[i];
              if (!line.trim()) continue;

              try {
                const jsonEntry = JSON.parse(line);
                const text = jsonEntry.message?.content
                  ?? (typeof jsonEntry.content === "string" ? jsonEntry.content : "");

                if (typeof text === "string" && text.toLowerCase().includes(queryLower)) {
                  results.push({
                    projectPath: projectDir,
                    projectName,
                    fileName: file,
                    matchLine: text.slice(0, 200),
                    lineNumber: i + 1,
                    modifiedAt: new Date(stat.mtimeMs),
                  });
                }
              } catch { /* malformed JSONL line */ }
            }
          } catch { /* file read error */ }
        }
      } catch { /* directory read error */ }
    }
  } catch { /* projects dir error */ }

  // Sort by recency
  results.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  return results;
}

/** Decode the URL-encoded project directory name back to a readable path. */
function decodeProjectName(encoded: string): string {
  return encoded.replace(/-/g, "/");
}

/** Read the last N bytes of a file. */
function readLastBytes(filePath: string, bytes: number): string {
  const fd = openSync(filePath, "r");
  try {
    const stat = fstatSync(fd);
    const start = Math.max(0, stat.size - bytes);
    const buf = Buffer.alloc(Math.min(bytes, stat.size));
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf-8");
  } finally {
    closeSync(fd);
  }
}
