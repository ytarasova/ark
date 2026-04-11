/**
 * Codex transcript parser.
 *
 * Codex writes one session file per run at:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<YYYY-MM-DDThh-mm-ss>-<conversation_id>.jsonl
 *
 * The first line is a session_meta event whose payload.cwd carries the working
 * directory the tool ran in. We identify a session's file by matching that cwd
 * against the Ark session.workdir plus a start-time filter, so concurrent Ark
 * sessions and manual codex runs never cross-contaminate.
 *
 * Token usage arrives in later events of shape:
 *   {type:"event_msg",payload:{type:"token_count",info:{total_token_usage:{...}}}}
 *
 * total_token_usage is cumulative -- we read the LAST token_count event.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { realpathSync } from "fs";
import type { TranscriptParser, ParseResult, FindOpts } from "../transcript-parser.js";

function normalizePath(p: string): string {
  try { return realpathSync(resolve(p)); }
  catch { return resolve(p); }
}

export class CodexTranscriptParser implements TranscriptParser {
  readonly kind = "codex";

  constructor(private sessionsDir: string = join(homedir(), ".codex", "sessions")) {}

  parse(transcriptPath: string): ParseResult {
    const usage = {
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
        if (entry.type === "turn_context" && entry.payload?.model && !model) {
          model = entry.payload.model as string;
        }
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
   * Match a Codex session file by reading its session_meta (first line) and
   * comparing the cwd against the Ark session's workdir.
   */
  findForSession(opts: FindOpts): string | null {
    if (!existsSync(this.sessionsDir)) return null;

    const targetCwd = normalizePath(opts.workdir);
    const startMs = opts.startTime?.getTime();

    const candidates: Array<{ path: string; mtime: number }> = [];

    const walk = (dir: string): void => {
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return; }
      for (const name of entries) {
        const full = join(dir, name);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) {
          walk(full);
        } else if (name.startsWith("rollout-") && name.endsWith(".jsonl")) {
          if (startMs && st.mtime.getTime() < startMs) continue;
          candidates.push({ path: full, mtime: st.mtime.getTime() });
        }
      }
    };

    walk(this.sessionsDir);

    // Sort newest first so we find the most recent matching session quickly
    candidates.sort((a, b) => b.mtime - a.mtime);

    for (const { path } of candidates) {
      try {
        const firstLine = readFileSync(path, "utf-8").split("\n", 2)[0];
        if (!firstLine) continue;
        const entry = JSON.parse(firstLine);
        if (entry.type !== "session_meta") continue;
        const fileCwd = entry.payload?.cwd;
        if (typeof fileCwd !== "string") continue;
        if (normalizePath(fileCwd) === targetCwd) {
          return path;
        }
      } catch { /* skip files we can't read/parse */ }
    }

    return null;
  }
}
