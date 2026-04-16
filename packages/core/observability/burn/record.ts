/**
 * Shared helper for recording burn turns from the completion pipeline.
 *
 * Used by both session-hooks.ts (Claude hooks path) and
 * session-orchestration.ts (non-Claude runtimes path) to record burn
 * data alongside cost data at session completion.
 */

import type { AppContext } from "../../app.js";
import type { BurnTurnRow } from "../../repositories/burn.js";
import { classifiedTurnToRow } from "./sync.js";
import { logError } from "../../observability/structured-log.js";

/**
 * Parse a transcript file, classify turns, and upsert into burn_turns.
 * Silently skips if no burn parser is registered for the given kind.
 * Never throws -- logs errors and returns.
 */
export function recordBurnTurns(
  app: AppContext,
  sessionId: string,
  transcriptPath: string,
  parserKind: string,
  project: string,
): void {
  try {
    const burnParser = app.burnParsers?.get(parserKind);
    if (!burnParser) return;

    const { turns } = burnParser.parseTranscript(transcriptPath, project);
    if (turns.length === 0) return;

    // Use 0 for mtime -- completion pipeline doesn't need mtime-based dedup
    // since it runs exactly once per session completion
    const rows: BurnTurnRow[] = turns.map((turn, index) =>
      classifiedTurnToRow(sessionId, turn, index, project, 0, parserKind),
    );

    app.burn.upsertTurns(sessionId, rows);
  } catch (e: any) {
    logError("session", "burn turn recording failed", {
      sessionId,
      parserKind,
      error: String(e?.message ?? e),
    });
  }
}
