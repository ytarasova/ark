/**
 * Log file management — max size, orphan cleanup.
 */

import { readdirSync, statSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { ARK_DIR } from "./store.js";
import { listSessions } from "./store.js";

export interface LogManagerOptions {
  maxSizeMb?: number;    // Max log file size (default: 10)
  maxLines?: number;     // Lines to keep when truncating (default: 10000)
  removeOrphans?: boolean; // Delete logs for missing sessions (default: true)
}

const DEFAULTS: Required<LogManagerOptions> = {
  maxSizeMb: 10,
  maxLines: 10_000,
  removeOrphans: true,
};

/** Get the log directory path. */
export function logDir(): string {
  return join(ARK_DIR(), "logs");
}

/** Truncate a log file to maxLines, keeping the most recent. */
export function truncateLog(filePath: string, maxLines: number): void {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  if (lines.length <= maxLines) return;
  const kept = lines.slice(-maxLines);
  writeFileSync(filePath, kept.join("\n"));
}

/** Clean up log files: truncate oversized, remove orphans. */
export function cleanupLogs(opts?: LogManagerOptions): { truncated: number; removed: number } {
  const o = { ...DEFAULTS, ...opts };
  const dir = logDir();
  if (!existsSync(dir)) return { truncated: 0, removed: 0 };

  let truncated = 0;
  let removed = 0;

  const sessionIds = new Set(listSessions({ limit: 1000 }).map(s => s.id));
  const files = readdirSync(dir).filter(f => f.endsWith(".log"));

  for (const file of files) {
    const filePath = join(dir, file);

    try {
      const stat = statSync(filePath);

      // Truncate oversized files
      if (stat.size > o.maxSizeMb * 1024 * 1024) {
        truncateLog(filePath, o.maxLines);
        truncated++;
      }

      // Remove orphaned logs
      if (o.removeOrphans) {
        // Extract session ID from filename (ark-s-<id>.log pattern)
        const match = file.match(/s-([a-f0-9]+)/);
        if (match && !sessionIds.has(`s-${match[1]}`)) {
          unlinkSync(filePath);
          removed++;
        }
      }
    } catch { /* skip errors */ }
  }

  return { truncated, removed };
}
