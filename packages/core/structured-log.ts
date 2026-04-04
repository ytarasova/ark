/**
 * Structured JSONL logging with component filtering and rotation.
 */

import { appendFileSync, existsSync, statSync, renameSync, mkdirSync } from "fs";
import { join } from "path";
import { ARK_DIR } from "./store.js";

export type LogComponent = "session" | "conductor" | "mcp" | "status" | "web" | "bridge" | "pool" | "compute" | "general";
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
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_BACKUPS = 3;

export function setLogLevel(level: LogLevel): void { _level = level; }
export function setLogComponents(components: LogComponent[] | null): void {
  _components = components ? new Set(components) : null;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function logPath(): string {
  return join(ARK_DIR(), "ark.jsonl");
}

function shouldLog(level: LogLevel, component: LogComponent): boolean {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[_level]) return false;
  if (_components && !_components.has(component)) return false;
  return true;
}

function rotate(): void {
  const path = logPath();
  if (!existsSync(path)) return;
  try {
    const stat = statSync(path);
    if (stat.size < MAX_FILE_SIZE) return;
    // Rotate: ark.jsonl.2 -> ark.jsonl.3, ark.jsonl.1 -> ark.jsonl.2, ark.jsonl -> ark.jsonl.1
    for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
      const from = `${path}.${i}`;
      const to = `${path}.${i + 1}`;
      if (existsSync(from)) try { renameSync(from, to); } catch { /* ignore */ }
    }
    try { renameSync(path, `${path}.1`); } catch { /* ignore */ }
  } catch { /* ignore */ }
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
    const dir = ARK_DIR();
    mkdirSync(dir, { recursive: true });
    rotate();
    appendFileSync(logPath(), JSON.stringify(entry) + "\n");
  } catch { /* don't crash on log failure */ }
}

// Convenience methods
export const logDebug = (c: LogComponent, msg: string, data?: Record<string, unknown>) => log("debug", c, msg, data);
export const logInfo = (c: LogComponent, msg: string, data?: Record<string, unknown>) => log("info", c, msg, data);
export const logWarn = (c: LogComponent, msg: string, data?: Record<string, unknown>) => log("warn", c, msg, data);
export const logError = (c: LogComponent, msg: string, data?: Record<string, unknown>) => log("error", c, msg, data);
