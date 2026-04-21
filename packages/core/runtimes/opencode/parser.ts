/**
 * OpenCode transcript parser.
 *
 * OpenCode stores session data in a SQLite database at:
 *   <workdir>/.opencode/opencode.db
 *
 * The database has three relevant tables:
 *   - sessions: id, title, prompt_tokens, completion_tokens, cost, created_at, updated_at
 *   - messages: id, session_id, role, parts (JSON), model, created_at, finished_at
 *
 * Token usage is stored directly on the sessions table as prompt_tokens and
 * completion_tokens (cumulative per session). We identify the correct session
 * by matching the database path (derived from workdir) and filtering by
 * creation time.
 */

import { existsSync } from "fs";
import { join, resolve } from "path";
import { Database } from "bun:sqlite";
import type { TranscriptParser, ParseResult, FindOpts } from "../transcript-parser.js";
import { logDebug } from "../../observability/structured-log.js";

export class OpenCodeTranscriptParser implements TranscriptParser {
  readonly kind = "opencode";

  parse(transcriptPath: string): ParseResult {
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };

    if (!existsSync(transcriptPath)) return { usage };

    try {
      const db = new Database(transcriptPath, { readonly: true });

      const row = db
        .query(
          `SELECT prompt_tokens, completion_tokens, cost
           FROM sessions
           ORDER BY updated_at DESC
           LIMIT 1`,
        )
        .get() as { prompt_tokens: number; completion_tokens: number; cost: number } | null;

      const msgRow = db
        .query(
          `SELECT model FROM messages
           WHERE role = 'assistant' AND model IS NOT NULL
           ORDER BY created_at DESC
           LIMIT 1`,
        )
        .get() as { model: string } | null;

      db.close();

      if (row) {
        usage.input_tokens = row.prompt_tokens ?? 0;
        usage.output_tokens = row.completion_tokens ?? 0;
      }

      return {
        usage,
        model: msgRow?.model ?? undefined,
        transcript_path: transcriptPath,
      };
    } catch (e: any) {
      logDebug("session", `opencode parser error: ${e?.message ?? e}`);
      return { usage };
    }
  }

  findForSession(opts: FindOpts): string | null {
    const dbPath = join(resolve(opts.workdir), ".opencode", "opencode.db");
    if (!existsSync(dbPath)) return null;

    if (!opts.startTime) return dbPath;

    try {
      const db = new Database(dbPath, { readonly: true });
      const startIso = opts.startTime.toISOString();

      const row = db
        .query(
          `SELECT id FROM sessions
           WHERE created_at >= ?
           ORDER BY created_at DESC
           LIMIT 1`,
        )
        .get(startIso) as { id: string } | null;

      db.close();
      return row ? dbPath : null;
    } catch {
      return dbPath;
    }
  }
}
