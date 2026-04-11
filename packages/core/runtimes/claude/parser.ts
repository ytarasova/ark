/**
 * Claude Code transcript parser.
 *
 * Claude Code writes transcripts to:
 *   ~/.claude/projects/<project-slug>/<session-uuid>.jsonl
 *
 * Where <project-slug> is workdir with `/` and `.` replaced by `-`
 * (Claude's own encoding scheme, see claude.ts trustWorktree).
 *
 * Each assistant message carries its own usage field:
 *   {type:"assistant",message:{usage:{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}}}
 *
 * Identification: Ark launches Claude Code with an explicit `--session-id <uuid>`
 * so we know the exact filename upfront. We store it on session.claude_session_id
 * and look it up via the sessionIdLookup callback.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import type { TranscriptParser, ParseResult, FindOpts } from "../transcript-parser.js";

/** Encode a workdir path as a Claude project slug: replace / and . with -. */
function encodeProjectSlug(workdir: string): string {
  return resolve(workdir).replace(/\//g, "-").replace(/\./g, "-");
}

export class ClaudeTranscriptParser implements TranscriptParser {
  readonly kind = "claude";

  constructor(
    private projectsDir: string = join(homedir(), ".claude", "projects"),
    private sessionIdLookup?: (workdir: string) => string | null,
  ) {}

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

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "assistant") continue;
        const u = entry.message?.usage;
        if (!u) continue;
        usage.input_tokens += u.input_tokens ?? 0;
        usage.output_tokens += u.output_tokens ?? 0;
        usage.cache_read_tokens = (usage.cache_read_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        usage.cache_write_tokens = (usage.cache_write_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      } catch { /* skip malformed lines */ }
    }

    return { usage, transcript_path: transcriptPath };
  }

  /**
   * Claude: if the caller provides a sessionIdLookup (to find Ark's
   * session.claude_session_id for this workdir), use the exact path.
   * Otherwise fall back to the latest jsonl file in the matching project dir.
   */
  findForSession(opts: FindOpts): string | null {
    const slug = encodeProjectSlug(opts.workdir);
    const projectDir = join(this.projectsDir, slug);
    if (!existsSync(projectDir)) return null;

    const claudeSessionId = this.sessionIdLookup?.(opts.workdir);
    if (claudeSessionId) {
      const exact = join(projectDir, `${claudeSessionId}.jsonl`);
      if (existsSync(exact)) return exact;
    }

    const startMs = opts.startTime?.getTime();
    let latest: { path: string; mtime: number } | null = null;
    let entries: string[];
    try { entries = readdirSync(projectDir); } catch { return null; }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const full = join(projectDir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (startMs && st.mtime.getTime() < startMs) continue;
      if (!latest || st.mtime.getTime() > latest.mtime) {
        latest = { path: full, mtime: st.mtime.getTime() };
      }
    }
    return latest?.path ?? null;
  }
}
