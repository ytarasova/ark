/**
 * Agent SDK transcript parser.
 *
 * The agent-sdk executor writes one JSONL transcript per session at:
 *   ~/.ark/tracks/<sessionId>/transcript.jsonl
 *
 * Each line is one SDKMessage serialized verbatim with JSON.stringify.
 * We parse it structurally without importing the SDK so the parser stays
 * dep-free and forward-compatible with future SDK message additions.
 *
 * Identification: we scan the tracks dir looking for a transcript whose
 * first "system" message has info.cwd matching the session workdir.
 * Matches transcripts by the `system` init line's `info.cwd` field.
 * No cwd annotation -> no match.
 *
 * Usage is extracted from the terminal "result" message (cumulative totals).
 * All other message types (system, partial_assistant, hook_*, status, etc.)
 * are ignored -- they stay in the JSONL for observability.
 */

import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import type { TranscriptParser, ParseResult, FindOpts } from "../transcript-parser.js";
import { logDebug } from "../../observability/structured-log.js";

function normalizePath(p: string): string {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}

type SdkLine =
  | { type: "user"; message: { content: Array<any> } }
  | { type: "assistant"; message: { content: Array<any> } }
  | {
      type: "result";
      is_error: boolean;
      num_turns: number;
      duration_ms: number;
      total_cost_usd: number;
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      stop_reason: string | null;
      result: string;
    }
  | { type: string; [k: string]: unknown };

/** Extended ParseResult carrying agent-sdk-specific fields. */
export interface AgentSdkParseResult extends ParseResult {
  cost_usd: number;
  num_turns: number;
  stop_reason: string | null;
}

export class AgentSdkParser implements TranscriptParser {
  readonly kind = "agent-sdk";

  /**
   * @param tracksDir - root dir where per-session subdirs live.
   *   Defaults to ~/.ark/tracks (Ark's canonical tracks directory).
   */
  constructor(private tracksDir: string = join(homedir(), ".ark", "tracks")) {}

  parse(transcriptPath: string): AgentSdkParseResult {
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
    const empty: AgentSdkParseResult = { usage, cost_usd: 0, num_turns: 0, stop_reason: null };

    if (!existsSync(transcriptPath)) return empty;

    let content: string;
    try {
      content = readFileSync(transcriptPath, "utf-8");
    } catch {
      return empty;
    }

    let cost_usd = 0;
    let num_turns = 0;
    let stop_reason: string | null = null;

    for (const raw of content.split("\n")) {
      if (!raw.trim()) continue;
      let line: SdkLine;
      try {
        line = JSON.parse(raw) as SdkLine;
      } catch {
        logDebug("session", "agent-sdk parser: skip malformed line");
        continue;
      }

      if (line.type === "result") {
        const r = line as Extract<SdkLine, { type: "result" }>;
        const u = r.usage ?? {};
        usage.input_tokens = u.input_tokens ?? 0;
        usage.output_tokens = u.output_tokens ?? 0;
        usage.cache_read_tokens = u.cache_read_input_tokens ?? 0;
        usage.cache_write_tokens = u.cache_creation_input_tokens ?? 0;
        cost_usd = r.total_cost_usd ?? 0;
        num_turns = r.num_turns ?? 0;
        stop_reason = r.stop_reason ?? null;
        // A result line is terminal -- anything after it is noise.
        break;
      }
    }

    return { usage, cost_usd, num_turns, stop_reason, transcript_path: transcriptPath };
  }

  /**
   * Scan tracksDir for session subdirectories containing a transcript.jsonl
   * whose first "system" line has info.cwd matching opts.workdir.
   * Matches transcripts by the `system` init line's `info.cwd` field.
   * No cwd annotation -> no match.
   */
  findForSession(opts: FindOpts): string | null {
    if (!opts.workdir || opts.workdir.trim() === "") return null;
    if (!existsSync(this.tracksDir)) return null;

    const targetCwd = normalizePath(opts.workdir);
    const startMs = opts.startTime?.getTime();

    const candidates: Array<{ path: string; mtime: number }> = [];

    let entries: string[];
    try {
      entries = readdirSync(this.tracksDir);
    } catch {
      return null;
    }

    for (const sessionId of entries) {
      const candidate = join(this.tracksDir, sessionId, "transcript.jsonl");
      if (!existsSync(candidate)) continue;
      let st;
      try {
        st = statSync(candidate);
      } catch {
        continue;
      }
      if (startMs && st.mtime.getTime() < startMs) continue;
      candidates.push({ path: candidate, mtime: st.mtime.getTime() });
    }

    // Sort newest first -- most likely match
    candidates.sort((a, b) => b.mtime - a.mtime);

    for (const { path } of candidates) {
      try {
        const firstLine = readFileSync(path, "utf-8").split("\n", 2)[0];
        if (!firstLine) continue;
        const entry = JSON.parse(firstLine);
        // The system init message written by the executor carries cwd in info.cwd
        if (entry.type === "system" && typeof entry.info?.cwd === "string") {
          if (normalizePath(entry.info.cwd) === targetCwd) return path;
        }
      } catch {
        logDebug("session", "agent-sdk parser: skip unreadable transcript");
      }
    }

    return null;
  }
}
