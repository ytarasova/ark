/**
 * Gemini CLI transcript parser.
 *
 * Gemini writes chat conversations to JSONL files at:
 *   ~/.gemini/tmp/<PROJECT_SLUG>/chats/session-<timestamp>-<shortId>.jsonl
 *
 * Each line is a JSON record of one of these shapes:
 *   - Initial metadata: {sessionId, projectHash, startTime, lastUpdated, kind, directories}
 *   - Message record:   {id, timestamp, type: "user"|"gemini"|"info"|"error"|"warning", content, tokens?}
 *   - Update record:    {$set: {...}}
 *   - Rewind record:    {$rewindTo: messageId}
 *
 * Identification: we match files by projectHash = sha256(session.workdir) against
 * the projectHash in the file's first line (initial metadata). This is exactly
 * how Gemini itself computes the hash (see gemini-cli/src/utils/paths.ts#getProjectHash).
 *
 * Token usage is embedded on messages of type "gemini" as:
 *   tokens: {input, output, cached, thoughts, tool, total}
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import type { TranscriptParser, ParseResult, FindOpts } from "../transcript-parser.js";
import { logDebug } from "../../observability/structured-log.js";

export class GeminiTranscriptParser implements TranscriptParser {
  readonly kind = "gemini";

  constructor(private tmpDir: string = join(homedir(), ".gemini", "tmp")) {}

  parse(transcriptPath: string): ParseResult {
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };

    if (!existsSync(transcriptPath)) return { usage };

    let content: string;
    try {
      content = readFileSync(transcriptPath, "utf-8");
    } catch {
      return { usage };
    }

    let model: string | undefined;

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "gemini") continue;
        if (entry.model && !model) model = entry.model as string;
        const t = entry.tokens;
        if (!t) continue;
        usage.input_tokens += t.input ?? 0;
        // Output = candidates (output) + thoughts (reasoning) + tool (tool use prompt)
        usage.output_tokens += (t.output ?? 0) + (t.thoughts ?? 0) + (t.tool ?? 0);
        usage.cache_read_tokens += t.cached ?? 0;
      } catch {
        logDebug("session", "skip malformed lines");
      }
    }

    return { usage, model, transcript_path: transcriptPath };
  }

  /**
   * Match a Gemini session file by computing projectHash = sha256(workdir)
   * and comparing it to the projectHash in the file's initial metadata line.
   */
  findForSession(opts: FindOpts): string | null {
    if (!existsSync(this.tmpDir)) return null;

    const targetHash = createHash("sha256").update(resolve(opts.workdir)).digest("hex");
    const startMs = opts.startTime?.getTime();

    const candidates: Array<{ path: string; mtime: number }> = [];

    let projects: string[];
    try {
      projects = readdirSync(this.tmpDir);
    } catch {
      return null;
    }

    for (const proj of projects) {
      const chatsDir = join(this.tmpDir, proj, "chats");
      let entries: string[];
      try {
        entries = readdirSync(chatsDir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.startsWith("session-") || !name.endsWith(".jsonl")) continue;
        const full = join(chatsDir, name);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (startMs && st.mtime.getTime() < startMs) continue;
        candidates.push({ path: full, mtime: st.mtime.getTime() });
      }
    }

    candidates.sort((a, b) => b.mtime - a.mtime);

    for (const { path } of candidates) {
      try {
        const firstLine = readFileSync(path, "utf-8").split("\n", 2)[0];
        if (!firstLine) continue;
        const entry = JSON.parse(firstLine);
        if (entry.projectHash === targetHash) {
          return path;
        }
      } catch {
        logDebug("session", "skip files we can't read/parse");
      }
    }

    return null;
  }
}
