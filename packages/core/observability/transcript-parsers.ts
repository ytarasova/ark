/**
 * Transcript parsers for non-Claude agents.
 *
 * Each parser reads the agent's local transcript/session file and extracts
 * token usage. Returns a unified TokenUsage shape regardless of the tool.
 *
 * Supported tools:
 *   claude  -- ~/.claude/projects/<proj>/<session>.jsonl (via claude.ts)
 *   codex   -- ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 *   gemini  -- <tempDir>/logs/session-<id>.jsonl
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { TokenUsage } from "./pricing.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type ParserKind = "claude" | "codex" | "gemini";

export interface ParseResult {
  usage: TokenUsage;
  model?: string;
  transcript_path?: string;
}

// ── Codex parser ───────────────────────────────────────────────────────────

/**
 * Parse a Codex session transcript (JSONL).
 * Codex writes one file per session at:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
 *
 * Each line is a JSON event. Token usage is in events of shape:
 *   {type:"event_msg",payload:{type:"token_count",info:{total_token_usage:{...},last_token_usage:{...}}}}
 *
 * We read the LAST token_count event's `total_token_usage` because it's cumulative.
 */
export function parseCodexTranscript(transcriptPath: string): ParseResult {
  const usage: TokenUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  };

  if (!existsSync(transcriptPath)) return { usage };

  let content: string;
  try { content = readFileSync(transcriptPath, "utf-8"); }
  catch { return { usage }; }

  let model: string | undefined;
  let lastTotal: any = null;

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      // Capture model from turn_context events
      if (entry.type === "turn_context" && entry.payload?.model && !model) {
        model = entry.payload.model as string;
      }
      // Capture cumulative token usage from token_count events
      if (entry.type === "event_msg" && entry.payload?.type === "token_count") {
        const info = entry.payload.info;
        if (info?.total_token_usage) {
          lastTotal = info.total_token_usage;
        }
      }
    } catch { /* skip malformed lines */ }
  }

  if (lastTotal) {
    usage.input_tokens = lastTotal.input_tokens ?? 0;
    usage.output_tokens = (lastTotal.output_tokens ?? 0) + (lastTotal.reasoning_output_tokens ?? 0);
    usage.cache_read_tokens = lastTotal.cached_input_tokens ?? 0;
  }

  return { usage, model, transcript_path: transcriptPath };
}

/**
 * Find the most recent Codex session transcript (rollout-*.jsonl).
 * Used when we know a Codex session just ran but don't have a direct file path.
 */
export function findLatestCodexTranscript(startTime?: Date): string | null {
  const codexDir = join(homedir(), ".codex", "sessions");
  if (!existsSync(codexDir)) return null;

  let latest: { path: string; mtime: number } | null = null;

  function walk(dir: string): void {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        walk(full);
      } else if (name.startsWith("rollout-") && name.endsWith(".jsonl")) {
        if (startTime && st.mtime.getTime() < startTime.getTime()) continue;
        if (!latest || st.mtime.getTime() > latest.mtime) {
          latest = { path: full, mtime: st.mtime.getTime() };
        }
      }
    }
  }

  walk(codexDir);
  return latest?.path ?? null;
}

// ── Gemini parser ──────────────────────────────────────────────────────────

/**
 * Parse a Gemini CLI session transcript (JSONL).
 * Gemini writes session logs to:
 *   <tempDir>/logs/session-<sessionId>.jsonl
 *
 * Each line is a telemetry event. API response events carry token usage:
 *   {event.name:"api_response",usage:{input_token_count,output_token_count,cached_content_token_count,thoughts_token_count}}
 *
 * We sum usage across all api_response events for cumulative total.
 */
export function parseGeminiTranscript(transcriptPath: string): ParseResult {
  const usage: TokenUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  };

  if (!existsSync(transcriptPath)) return { usage };

  let content: string;
  try { content = readFileSync(transcriptPath, "utf-8"); }
  catch { return { usage }; }

  let model: string | undefined;

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry["event.name"] !== "api_response") continue;
      if (entry.model && !model) model = entry.model as string;
      const u = entry.usage;
      if (!u) continue;
      usage.input_tokens += u.input_token_count ?? 0;
      // Output = candidates + reasoning (thoughts)
      usage.output_tokens += (u.output_token_count ?? 0) + (u.thoughts_token_count ?? 0);
      usage.cache_read_tokens = (usage.cache_read_tokens ?? 0) + (u.cached_content_token_count ?? 0);
    } catch { /* skip malformed lines */ }
  }

  return { usage, model, transcript_path: transcriptPath };
}

/**
 * Find the Gemini session transcript for a given session ID.
 * Gemini stores at <tempDir>/logs/session-<id>.jsonl.
 * The tempDir is typically ~/.gemini/tmp or the system temp dir under a gemini subdir.
 */
export function findGeminiTranscript(sessionId: string): string | null {
  // Common locations Gemini may use
  const candidates = [
    join(homedir(), ".gemini", "tmp", "logs", `session-${sessionId}.jsonl`),
    join(homedir(), ".gemini", "logs", `session-${sessionId}.jsonl`),
    join("/tmp", "gemini", "logs", `session-${sessionId}.jsonl`),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

// ── Dispatcher ─────────────────────────────────────────────────────────────

/**
 * Parse a transcript using the parser for the given kind.
 * Throws if the kind is unknown.
 */
export function parseTranscript(kind: ParserKind, path: string): ParseResult {
  switch (kind) {
    case "codex": return parseCodexTranscript(path);
    case "gemini": return parseGeminiTranscript(path);
    case "claude":
      // Lazy-load to avoid circular dep
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      {
        const { parseTranscriptUsage } = require("../claude/claude.js");
        const u = parseTranscriptUsage(path);
        return {
          usage: {
            input_tokens: u.input_tokens,
            output_tokens: u.output_tokens,
            cache_read_tokens: u.cache_read_input_tokens,
            cache_write_tokens: u.cache_creation_input_tokens,
          },
          transcript_path: path,
        };
      }
    default:
      throw new Error(`Unknown transcript parser: ${kind}`);
  }
}
