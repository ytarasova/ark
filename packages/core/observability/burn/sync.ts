/**
 * Burn sync pipeline -- walks sessions, parses transcripts, upserts burn_turns.
 *
 * The sync function resolves each session's transcript via the existing
 * TranscriptParser registry, runs the classified parser, and upserts
 * burn_turns rows. Designed to be called from syncCosts() or manually
 * via the burn/sync RPC handler.
 */

import { statSync } from "fs";
import type { AppContext } from "../../app.js";
import type { BurnTurnRow } from "../../repositories/burn.js";
import { parseClaudeTranscript } from "./parser.js";
import type { ClassifiedTurn } from "./types.js";

export interface SyncResult {
  synced: number;
  skipped: number;
  errors: Array<{ sessionId: string; error: string }>;
}

/**
 * Sync burn data from transcripts into the burn_turns table.
 * Walks all (or specified) sessions, finds transcripts via the
 * TranscriptParser registry, and upserts classified turn rows.
 */
export function syncBurn(
  app: AppContext,
  opts?: { sessionIds?: string[]; force?: boolean },
): SyncResult {
  let sessions;
  if (opts?.sessionIds?.length) {
    sessions = opts.sessionIds
      .map((id) => app.sessions.get(id))
      .filter((s) => s != null);
  } else {
    sessions = app.sessions.list({ limit: 1000 });
  }

  let synced = 0;
  let skipped = 0;
  const errors: Array<{ sessionId: string; error: string }> = [];

  for (const session of sessions) {
    try {
      if (!session.workdir) {
        skipped++;
        continue;
      }

      // Resolve runtime and transcript parser kind
      const runtimeName =
        (session.config?.runtime as string | undefined) ??
        session.agent ??
        "claude";
      const runtime = app.runtimes.get(runtimeName);
      const kind = runtime?.billing?.transcript_parser ?? "claude";
      const parser = app.transcriptParsers.get(kind);
      if (!parser) {
        skipped++;
        continue;
      }

      // Find transcript file
      const transcriptPath = parser.findForSession({
        workdir: session.workdir,
        startTime: session.created_at
          ? new Date(session.created_at)
          : undefined,
      });
      if (!transcriptPath) {
        skipped++;
        continue;
      }

      // Check mtime for skip (unless force)
      let mtime: number;
      try {
        mtime = statSync(transcriptPath).mtime.getTime();
      } catch {
        skipped++;
        continue;
      }

      if (!opts?.force) {
        // Check if we already have turns with this mtime
        const existingTurns = app.burn.getTurns(session.id);
        if (
          existingTurns.length > 0 &&
          existingTurns[0].transcript_mtime != null &&
          existingTurns[0].transcript_mtime >= mtime
        ) {
          skipped++;
          continue;
        }
      }

      // Parse transcript and classify turns
      const project =
        session.repo ?? session.workdir?.split("/").pop() ?? "unknown";
      const { turns } = parseClaudeTranscript(transcriptPath, project);
      if (turns.length === 0) {
        skipped++;
        continue;
      }

      // Map ClassifiedTurns to DB rows
      const rows: BurnTurnRow[] = turns.map((turn, index) =>
        classifiedTurnToRow(session.id, turn, index, project, mtime),
      );

      // Upsert into burn_turns
      app.burn.upsertTurns(session.id, rows);
      synced++;
    } catch (err: any) {
      errors.push({
        sessionId: session.id,
        error: err?.message ?? String(err),
      });
    }
  }

  return { synced, skipped, errors };
}

/**
 * Convert a ClassifiedTurn into a BurnTurnRow for database insertion.
 */
function classifiedTurnToRow(
  sessionId: string,
  turn: ClassifiedTurn,
  turnIndex: number,
  project: string,
  transcriptMtime: number,
): BurnTurnRow {
  // Aggregate token counts across all API calls in the turn
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalCost = 0;
  let model: string | null = null;
  let provider: string | null = null;
  let speed = "standard";

  const allTools: string[] = [];
  const allMcpTools: string[] = [];
  const allBashCmds: string[] = [];

  for (const call of turn.assistantCalls) {
    inputTokens += call.usage.inputTokens;
    outputTokens += call.usage.outputTokens;
    cacheReadTokens += call.usage.cacheReadInputTokens;
    cacheWriteTokens += call.usage.cacheCreationInputTokens;
    totalCost += call.costUSD;
    if (!model) model = call.model;
    if (!provider) provider = call.provider;
    if (call.speed === "fast") speed = "fast";
    allTools.push(...call.tools);
    allMcpTools.push(...call.mcpTools);
    allBashCmds.push(...call.bashCommands);
  }

  return {
    session_id: sessionId,
    tenant_id: "default",
    turn_index: turnIndex,
    project,
    timestamp: turn.timestamp || new Date().toISOString(),
    user_message_preview: turn.userMessage.slice(0, 200) || null,
    category: turn.category,
    model,
    provider,
    runtime: "claude-code",
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    cost_usd: totalCost,
    api_calls: turn.assistantCalls.length,
    has_edits: turn.hasEdits ? 1 : 0,
    retries: turn.retries,
    is_one_shot: turn.isOneShot ? 1 : 0,
    tools_json: JSON.stringify([...new Set(allTools)]),
    mcp_tools_json: JSON.stringify([...new Set(allMcpTools)]),
    bash_cmds_json: JSON.stringify([...new Set(allBashCmds)]),
    speed,
    transcript_mtime: transcriptMtime,
  };
}
