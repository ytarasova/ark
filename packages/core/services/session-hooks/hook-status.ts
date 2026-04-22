/**
 * Hook status pipeline -- processes inbound hook events (SessionStart,
 * UserPromptSubmit, StopFailure, SessionEnd, Notification, Stop) and produces
 * a `HookStatusResult` describing status transitions, events, and side-effects
 * the caller should apply.
 */

import { execFileSync } from "child_process";

import type { Session } from "../../../types/index.js";
import { detectHandoff } from "../../handoff.js";
import { logDebug, logError } from "../../observability/structured-log.js";
import { evaluateTermination, parseTermination, type TerminationContext } from "../../termination.js";
import type { HookStatusResult, SessionHooksDeps } from "./types.js";
import { parseOnFailure } from "./types.js";

export class HookStatusApplier {
  constructor(private readonly deps: SessionHooksDeps) {}

  /** Detect session status from tmux content (fallback when hooks don't fire). */
  async detectStatus(sessionId: string): Promise<string | null> {
    const session = await this.deps.sessions.get(sessionId);
    if (!session?.session_id) return null;
    const { detectSessionStatus } = await import("../../observability/status-detect.js");
    const detected = await detectSessionStatus(session.session_id);
    return detected === "unknown" ? null : detected;
  }

  /**
   * Business logic for processing a hook status event.
   * Determines status transitions, events to log, and side effects.
   *
   * NOTE: *mostly* pure, but has one fire-and-forget side effect on
   * SessionEnd/Stop that runs handoff detection asynchronously (writes
   * events and config via deps). Best-effort -- should not block the
   * hook response.
   */
  async apply(session: Session, hookEvent: string, payload: Record<string, unknown>): Promise<HookStatusResult> {
    const { getStage, flows, usageRecorder, transcriptParsers, recordSessionUsage, getOutput, sessions, events } =
      this.deps;
    const result: HookStatusResult = { events: [] };

    // Check if this session uses manual gate (interactive - user controls lifecycle)
    const stageDef = session.stage ? getStage(session.flow, session.stage) : null;
    const isManualGate = stageDef?.gate === "manual";

    const isAutoGate = stageDef && stageDef.gate !== "manual";

    const statusMap: Record<string, string> = {
      SessionStart: "running",
      UserPromptSubmit: "running",
      StopFailure: isManualGate ? "running" : "failed",
      // Auto-gate SessionEnd: set "ready" so advance() can route to next stage or complete
      // Manual-gate: stay running. No stage defined: fall back to "completed".
      SessionEnd: isManualGate ? "running" : isAutoGate ? "ready" : "completed",
    };

    let newStatus = statusMap[hookEvent];

    // Auto-gate SessionEnd fallback: trigger advance so the flow can progress
    // (handles case where agent finished but channel report was unavailable).
    // Verify new commits exist first -- agents that "explored" without committing
    // should NOT auto-advance (same enforcement as applyReport).
    if (hookEvent === "SessionEnd" && isAutoGate && session.status === "running") {
      let hasNewCommits = false;
      if (session.workdir) {
        try {
          const startSha = (session.config as any)?.stage_start_sha as string | undefined;
          if (startSha) {
            const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
              cwd: session.workdir,
              encoding: "utf-8",
              timeout: 5000,
            }).trim();
            hasNewCommits = headSha !== startSha;
          } else {
            const log = execFileSync("git", ["log", "--oneline", "origin/main..HEAD"], {
              cwd: session.workdir,
              encoding: "utf-8",
              timeout: 5000,
            }).trim();
            hasNewCommits = !!log;
          }
        } catch {
          hasNewCommits = true; /* allow on git error */
        }
      } else {
        hasNewCommits = true; /* no workdir = skip check */
      }

      if (hasNewCommits) {
        result.shouldAdvance = true;
        result.shouldAutoDispatch = true;
      } else {
        newStatus = "failed" as any;
        if (!result.updates) result.updates = {};
        result.updates.error = "Agent exited without committing any changes";
        result.events!.push({
          type: "completion_rejected",
          opts: { stage: session.stage ?? undefined, actor: "system", data: { reason: "no commits on SessionEnd" } },
        });
      }
    }

    // Don't override terminal status -- late hooks can fire after session is done or manually stopped
    if (newStatus && session.status === "completed" && newStatus !== "completed") {
      newStatus = undefined;
    }
    if (newStatus && session.status === "failed" && newStatus === "running") {
      newStatus = undefined;
    }
    if (newStatus && session.status === "stopped" && newStatus !== "stopped") {
      newStatus = undefined;
    }

    if (hookEvent === "Notification") {
      const matcher = String(payload.matcher ?? "");
      if (matcher.includes("permission_prompt") || matcher.includes("idle_prompt")) {
        newStatus = "waiting";
      }
    }

    // Always log the hook event
    result.events!.push({
      type: "hook_status",
      opts: { actor: "hook", data: { event: hookEvent, ...payload } as Record<string, unknown> },
    });

    // For manual gate: log errors/completions as events but don't change status
    if (isManualGate && (hookEvent === "StopFailure" || hookEvent === "SessionEnd")) {
      const errorMsg = payload.error ?? payload.error_details;
      if (errorMsg) {
        result.events!.push({
          type: "agent_error",
          opts: { actor: "agent", data: { error: String(errorMsg), event: hookEvent } },
        });
      }
    }

    if (newStatus) {
      const updates: Partial<Session> = { ...result.updates, status: newStatus as Session["status"] };
      if (newStatus === "failed" && !updates.error) {
        updates.error = String(payload.error ?? payload.error_details ?? "unknown error");
      }
      // Enrich failure events with actionable context
      if (newStatus === "failed") {
        const errorMsg = updates.error ?? String(payload.error ?? payload.error_details ?? "unknown error");
        const suggestions: string[] = [];
        if (errorMsg.includes("permission") || errorMsg.includes("denied")) {
          suggestions.push("Check file permissions and tool access settings");
        }
        if (errorMsg.includes("timeout") || errorMsg.includes("timed out")) {
          suggestions.push("Consider increasing the timeout or breaking the task into smaller steps");
        }
        if (errorMsg.includes("commit")) {
          suggestions.push("Ensure the agent commits changes before completing");
        }
        if (errorMsg.includes("OOM") || errorMsg.includes("memory")) {
          suggestions.push("Reduce context size or use a smaller model");
        }
        if (suggestions.length === 0) {
          suggestions.push("Check terminal output for details", "Try restarting the session");
        }
        result.events!.push({
          type: "session_failed",
          opts: {
            actor: "system",
            stage: session.stage ?? undefined,
            data: {
              error: errorMsg,
              agent: session.agent,
              stage: session.stage,
              hook_event: hookEvent,
              command: payload.command ?? null,
              suggestions,
            },
          },
        });
      }
      // Mark messages as read on terminal states so badges clear
      if (newStatus === "completed" || newStatus === "failed" || newStatus === "stopped") {
        result.markRead = true;
      }
      // Clear stale breakpoint when resuming from waiting
      if (newStatus === "running" && session.status === "waiting") {
        updates.breakpoint_reason = null;
      }
      result.updates = updates;
      result.newStatus = newStatus;

      // Check on_failure directive for automatic retry on failure
      if (newStatus === "failed" && session.stage && session.flow) {
        const failStageDef = getStage(session.flow, session.stage);
        const retryDirective = parseOnFailure(failStageDef?.on_failure);
        if (retryDirective) {
          result.shouldRetry = true;
          result.retryMaxRetries = retryDirective.maxRetries;
        }
      }
    }

    // Check termination conditions from flow stage config
    try {
      const flowDef = flows.get(session.flow) as any;
      const termStageDef = flowDef?.stages?.find((s: { name?: string }) => s.name === session.stage);
      const termConfig = (termStageDef as { termination?: unknown })?.termination;
      if (termConfig) {
        const condition = parseTermination(termConfig);
        if (condition) {
          const ctx: TerminationContext = {
            session,
            turnCount: (session.config?.turns as number | undefined) ?? 0,
            tokenCount: (await usageRecorder.getSessionCost(session.id)).total_tokens,
            elapsedMs: Date.now() - new Date(session.updated_at).getTime(),
            lastOutput: "",
          };
          if (evaluateTermination(condition, ctx)) {
            result.newStatus = "completed";
            result.events = [
              ...(result.events ?? []),
              { type: "termination_triggered", opts: { actor: "system", data: { condition: termConfig } } },
            ];
          }
        }
      }
    } catch {
      logDebug("session", "skip termination check on error");
    }

    // Track token usage from transcript on Stop and SessionEnd
    const transcriptPath = payload.transcript_path as string | undefined;
    if (transcriptPath && (hookEvent === "Stop" || hookEvent === "SessionEnd")) {
      try {
        const parser = transcriptParsers.get("claude");
        if (parser) {
          const { usage } = parser.parse(transcriptPath);
          const total =
            usage.input_tokens +
            usage.output_tokens +
            (usage.cache_read_tokens ?? 0) +
            (usage.cache_write_tokens ?? 0);
          if (total > 0) {
            recordSessionUsage(session, usage, "anthropic", "transcript");
          }
        }
      } catch (e: any) {
        logError("session", "transcript parsing failed", { sessionId: session.id, error: String(e?.message ?? e) });
      }

      // Index transcript for FTS5 search -- only if the transcript belongs to THIS session's agent
      const hookClaudeSession = payload.session_id as string | undefined;
      if (hookClaudeSession && session.claude_session_id && transcriptPath.includes(hookClaudeSession)) {
        result.shouldIndex = true;
        result.indexTranscript = { transcriptPath, sessionId: session.id };
      }
    }

    // Check for agent-initiated handoff on session end (fire-and-forget async)
    if (hookEvent === "SessionEnd" || hookEvent === "Stop") {
      getOutput(session.id, { lines: 50 })
        .then(async (output) => {
          try {
            const handoff = detectHandoff(output);
            if (handoff) {
              await events.log(session.id, "handoff_detected", {
                actor: "system",
                data: { targetAgent: handoff.targetAgent, reason: handoff.reason },
              });
              await sessions.mergeConfig(session.id, {
                _pending_handoff: { agent: handoff.targetAgent, instructions: handoff.reason },
              });
            }
          } catch {
            logDebug("session", "skip handoff detection on error");
          }
        })
        .catch(() => {
          /* skip if output unavailable */
        });
    }

    return result;
  }
}
