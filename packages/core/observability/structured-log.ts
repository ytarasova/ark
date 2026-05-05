/**
 * Structured JSONL logging with component filtering and rotation.
 */

import { appendFileSync, existsSync, statSync, renameSync, mkdirSync } from "fs";
import { join } from "path";

export type LogComponent =
  | "session"
  | "conductor"
  | "mcp"
  | "status"
  | "web"
  | "bridge"
  | "pool"
  | "compute"
  | "general"
  | "triggers"
  | "connectors"
  | "workspace"
  | "handoff"
  | "compute-pool"
  | "router";
export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: LogComponent;
  message: string;
  data?: Record<string, unknown>;
}

let _level: LogLevel = "info";
let _components: Set<LogComponent> | null = null; // null = all
let _arkDir: string | null = null;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_BACKUPS = 3;

export function setLogLevel(level: LogLevel): void {
  _level = level;
}
export function setLogComponents(components: LogComponent[] | null): void {
  _components = components ? new Set(components) : null;
}
/** Set the ark directory for log file output. Called during app boot.
 * Pass `null` to clear (tests that simulate a never-bound hosted state). */
export function setLogArkDir(arkDir: string | null): void {
  _arkDir = arkDir;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function logPath(): string | null {
  if (!_arkDir) return null;
  return join(_arkDir, "ark.jsonl");
}

function shouldLog(level: LogLevel, component: LogComponent): boolean {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[_level]) return false;
  if (_components && !_components.has(component)) return false;
  return true;
}

function rotate(): void {
  const path = logPath();
  if (!path || !existsSync(path)) return;
  try {
    const stat = statSync(path);
    if (stat.size < MAX_FILE_SIZE) return;
    // Rotate: ark.jsonl.2 -> ark.jsonl.3, ark.jsonl.1 -> ark.jsonl.2, ark.jsonl -> ark.jsonl.1
    for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
      const from = `${path}.${i}`;
      const to = `${path}.${i + 1}`;
      if (existsSync(from))
        try {
          renameSync(from, to);
        } catch {
          // Rotating the logger from inside the logger would recurse forever --
          // if rename fails (permissions, race with another process) we just
          // skip this backup slot. The next rotate cycle will retry.
        }
    }
    try {
      renameSync(path, `${path}.1`);
    } catch {
      // See comment above: logger cannot log its own failures.
    }
  } catch {
    // stat()/rotate() failed entirely. Silent by design (logger internal).
  }
}

/** Write a structured log entry. */
export function log(level: LogLevel, component: LogComponent, message: string, data?: Record<string, unknown>): void {
  if (!shouldLog(level, component)) return;

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    component,
    message,
    ...(data ? { data } : {}),
  };

  try {
    if (!_arkDir) return;
    mkdirSync(_arkDir, { recursive: true });
    rotate();
    const path = logPath();
    if (path) appendFileSync(path, JSON.stringify(entry) + "\n");
  } catch {
    // Logging must never throw (or we would crash the app on a disk-full
    // condition). Recursing into log() here would also loop forever.
  }
}

// Convenience methods
export const logDebug = (c: LogComponent, msg: string, data?: Record<string, unknown>) => log("debug", c, msg, data);
export const logInfo = (c: LogComponent, msg: string, data?: Record<string, unknown>) => log("info", c, msg, data);
export const logWarn = (c: LogComponent, msg: string, data?: Record<string, unknown>) => log("warn", c, msg, data);
export const logError = (c: LogComponent, msg: string, data?: Record<string, unknown>) => log("error", c, msg, data);
