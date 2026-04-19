/**
 * Inbound event processing -- hook status, channel reports, and stage handoffs.
 *
 * Extracted from session-orchestration.ts. These functions form the conductor-facing
 * business logic: they process hook events and agent reports, determine state
 * transitions, and orchestrate stage-to-stage handoffs.
 */

import { execFileSync } from "child_process";

import type { AppContext } from "../app.js";
import type { Session, MessageRole, MessageType } from "../../types/index.js";
import type { OutboundMessage } from "../conductor/channel-types.js";
import * as flow from "../state/flow.js";
import { detectHandoff } from "../handoff.js";
import { logDebug, logError, logInfo, logWarn } from "../observability/structured-log.js";
import { evaluateTermination, parseTermination, type TerminationContext } from "../termination.js";
import { loadRepoConfig } from "../repo-config.js";
import { safeAsync } from "../safe.js";

// Cross-module imports from session-orchestration.ts (one-way dependency -- no circular)
import {
  advance,
  runVerification,
  dispatch,
  getOutput,
  executeAction,
  recordSessionUsage,
} from "./session-orchestration.js";

// ── Hook status logic ─────────────────────────────────────────────────────────

export interface HookStatusResult {
  newStatus?: string;
  shouldIndex?: boolean;
  claudeSessionId?: string;
  /** Store updates to apply */
  updates?: Partial<Session>;
  /** Events to log */
  events?: Array<{ type: string; opts: { actor?: string; stage?: string; data?: Record<string, unknown> } }>;
  /** Transcript indexing info */
  indexTranscript?: { transcriptPath: string; sessionId: string };
  /** Whether to call advance() after applying updates (auto-gate SessionEnd fallback) */
  shouldAdvance?: boolean;
  /** Whether to auto-dispatch next stage after advance */
  shouldAutoDispatch?: boolean;
  /** Whether the failure should trigger an on_failure retry loop */
  shouldRetry?: boolean;
  /** Max retries from the on_failure directive (e.g. retry(3) -> 3) */
  retryMaxRetries?: number;
  /** Mark all messages as read (terminal states) */
  markRead?: boolean;
}

/** Detect session status from tmux content (fallback when hooks don't fire). */
export async function detectStatus(app: AppContext, sessionId: string): Promise<string | null> {
  const session = app.sessions.get(sessionId);
  if (!session?.session_id) return null;
  const { detectSessionStatus } = await import("../observability/status-detect.js");
  const detected = await detectSessionStatus(session.session_id);
  return detected === "unknown" ? null : detected;
}

/**
 * Business logic for processing a hook status event.
 * Determines status transitions, events to log, and side effects.
 *
 * NOTE: This function is *mostly* pure, but has one fire-and-forget side effect:
 * on SessionEnd/Stop, it runs handoff detection asynchronously (lines below),
 * which writes events and config to the store via app. This is intentional --
 * handoff detection is best-effort and should not block the hook response.
 */
export function applyHookStatus(
  app: AppContext,
  session: Session,
  hookEvent: string,
  payload: Record<string, unknown>,
): HookStatusResult {
  const result: HookStatusResult = { events: [] };

  // Check if this session uses manual gate (interactive - user controls lifecycle)
  const stageDef = session.stage ? flow.getStage(app, session.flow, session.stage) : null;
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
          // Per-stage check: compare HEAD against the sha recorded when this stage started
          const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: session.workdir,
            encoding: "utf-8",
            timeout: 5000,
          }).trim();
          hasNewCommits = headSha !== startSha;
        } else {
          // Fallback: check for any commits on branch vs origin/main
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
      // Agent exited without committing -- don't advance, mark as failed
      newStatus = "failed" as any;
      if (!result.updates) result.updates = {};
      result.updates.error = "Agent exited without committing any changes";
      if (!result.logEvents) result.logEvents = [];
      result.logEvents.push({
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
      const failStageDef = flow.getStage(app, session.flow, session.stage);
      const retryDirective = parseOnFailure(failStageDef?.on_failure);
      if (retryDirective) {
        result.shouldRetry = true;
        result.retryMaxRetries = retryDirective.maxRetries;
      }
    }
  }

  // Check termination conditions from flow stage config
  try {
    const flowDef = app.flows.get(session.flow);
    const termStageDef = flowDef?.stages?.find((s) => s.name === session.stage);
    const termConfig = (termStageDef as { termination?: unknown })?.termination;
    if (termConfig) {
      const condition = parseTermination(termConfig);
      if (condition) {
        const ctx: TerminationContext = {
          session,
          turnCount: (session.config?.turns as number | undefined) ?? 0,
          tokenCount: app.usageRecorder.getSessionCost(session.id).total_tokens,
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
      const parser = app.transcriptParsers.get("claude");
      if (parser) {
        const { usage } = parser.parse(transcriptPath);
        const total =
          usage.input_tokens + usage.output_tokens + (usage.cache_read_tokens ?? 0) + (usage.cache_write_tokens ?? 0);
        if (total > 0) {
          recordSessionUsage(app, session, usage, "anthropic", "transcript");
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
    getOutput(app, session.id, { lines: 50 })
      .then((output) => {
        try {
          const handoff = detectHandoff(output);
          if (handoff) {
            app.events.log(session.id, "handoff_detected", {
              actor: "system",
              data: { targetAgent: handoff.targetAgent, reason: handoff.reason },
            });
            app.sessions.mergeConfig(session.id, {
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

// ── Report handling logic ─────────────────────────────────────────────────────

export interface ReportResult {
  /** Store updates to apply to the session */
  updates: Partial<Session>;
  /** Whether to call session.advance() after applying updates */
  shouldAdvance?: boolean;
  /** Whether to auto-dispatch next stage after advance */
  shouldAutoDispatch?: boolean;
  /** Stage outcome label for on_outcome routing (from CompletionReport.outcome) */
  outcome?: string;
  /** Events to emit on the event bus */
  busEvents?: Array<{ type: string; sessionId: string; data: Record<string, unknown> }>;
  /** Events to log to the store */
  logEvents?: Array<{ type: string; opts: { stage?: string; actor?: string; data?: Record<string, unknown> } }>;
  /** Message to store for chat view */
  message?: { role: MessageRole; content: string; type: MessageType };
  /** PR URL detected from report */
  prUrl?: string;
  /** Whether the error should trigger an on_failure retry loop */
  shouldRetry?: boolean;
  /** Max retries from the on_failure directive (e.g. retry(3) -> 3) */
  retryMaxRetries?: number;
}

/**
 * Pure business logic for processing an agent channel report.
 * Determines state transitions, messages, and events without
 * touching the store, event bus, or session lifecycle directly.
 */
export function applyReport(app: AppContext, sessionId: string, report: OutboundMessage): ReportResult {
  const session = app.sessions.get(sessionId);
  if (!session) {
    return { updates: {}, logEvents: [], busEvents: [] };
  }
  const result: ReportResult = { updates: {}, logEvents: [], busEvents: [] };

  // Log event
  result.logEvents!.push({
    type: `agent_${report.type}`,
    opts: {
      stage: report.stage,
      actor: "agent",
      data: report as unknown as Record<string, unknown>,
    },
  });

  // Build message content for chat view
  const r = report as unknown as Record<string, unknown>;
  const contentByType: Record<string, string | undefined> = {
    completed: (r.summary || r.message) as string | undefined,
    question: (r.question || r.message) as string | undefined,
    error: (r.error || r.message) as string | undefined,
    progress: (r.message || r.summary) as string | undefined,
  };
  let content = contentByType[report.type] || JSON.stringify(report);

  // Enrich with files, commits, PR URL when available
  const extras: string[] = [];
  if (r.pr_url) extras.push(`PR: ${r.pr_url}`);
  if (Array.isArray(r.filesChanged) && r.filesChanged.length > 0) {
    extras.push(`Files: ${(r.filesChanged as string[]).join(", ")}`);
  }
  if (Array.isArray(r.commits) && r.commits.length > 0) {
    extras.push(`Commits: ${(r.commits as string[]).join(", ")}`);
  }
  if (extras.length > 0) content += "\n" + extras.join("\n");
  result.message = { role: "agent", content, type: report.type };

  // Emit to event bus
  result.busEvents!.push({
    type: `agent_${report.type}`,
    sessionId,
    data: { stage: report.stage, data: report as unknown as Record<string, unknown> },
  });

  // Handle by type
  switch (report.type) {
    case "completed": {
      // Save completion data to session config for display in detail pane
      const rr = report as unknown as Record<string, unknown>;
      result.updates.config = {
        ...session.config,
        completion_summary: rr.summary as string | undefined,
        filesChanged: rr.filesChanged as string[] | undefined,
        commits: rr.commits as string[] | undefined,
      };

      // Capture outcome for on_outcome routing
      if (rr.outcome) {
        result.outcome = rr.outcome as string;
      }

      // Hard enforcement: reject completion if no new commits exist for the current stage.
      // Uses stage_start_sha (recorded at dispatch) for per-stage verification.
      // Falls back to origin/main..HEAD when stage_start_sha is unavailable.
      if (session.workdir && session.branch) {
        try {
          const startSha = (session.config as any)?.stage_start_sha as string | undefined;
          let hasNewCommits = false;
          if (startSha) {
            // Per-stage check: compare HEAD against the sha recorded when this stage started
            const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
              cwd: session.workdir,
              encoding: "utf-8",
              timeout: 5000,
            }).trim();
            hasNewCommits = headSha !== startSha;
          } else {
            // Fallback: check for any commits on branch vs origin/main
            const newCommits = execFileSync("git", ["log", "--oneline", `origin/main..HEAD`], {
              cwd: session.workdir,
              encoding: "utf-8",
              timeout: 5000,
            }).trim();
            hasNewCommits = !!newCommits;
          }
          if (!hasNewCommits) {
            // No commits during this stage -- reject completion
            result.logEvents!.push({
              type: "completion_rejected",
              opts: {
                stage: session.stage ?? undefined,
                actor: "system",
                data: { reason: "no new commits in worktree", stage_start_sha: startSha },
              },
            });
            result.message = {
              role: "system",
              content:
                "Completion rejected: no new commits found for this stage. You must commit your changes, push, and create a PR before reporting completed.",
              type: "error",
            };
            // Don't advance -- session stays running so agent can finish
            break;
          }
        } catch {
          logInfo("session", "git check failed (e.g. no remote) -- continue to next check");
        }

        // Check for uncommitted changes -- agent must commit ALL work before completing.
        // Catches staged-but-uncommitted and modified-but-unstaged tracked files.
        try {
          const status = execFileSync("git", ["status", "--porcelain"], {
            cwd: session.workdir,
            encoding: "utf-8",
            timeout: 5000,
          }).trim();
          if (status) {
            // Filter out untracked files (??) -- only reject for tracked file changes
            const uncommitted = status.split("\n").filter((l) => {
              if (!l || l.startsWith("??")) return false;
              // Ignore Ark infrastructure files modified at dispatch
              const file = l.slice(3).trim();
              if (file === ".mcp.json" || file.startsWith(".claude/")) return false;
              return true;
            });
            if (uncommitted.length > 0) {
              result.logEvents!.push({
                type: "completion_rejected",
                opts: {
                  stage: session.stage ?? undefined,
                  actor: "system",
                  data: { reason: "uncommitted changes in worktree", files: uncommitted.slice(0, 10) },
                },
              });
              const fileList = uncommitted.slice(0, 5).join("\n");
              result.message = {
                role: "system",
                content: `Completion rejected: ${uncommitted.length} file(s) have uncommitted changes. Stage and commit all changes before reporting completed.\n${fileList}`,
                type: "error",
              };
              // Don't advance -- session stays running so agent can commit remaining changes
              break;
            }
          }
        } catch {
          logInfo("session", "git check failed -- allow completion to proceed");
        }
      }

      // Check gate type -- manual gates keep session running (user decides when done)
      const stageDef = flow.getStage(app, session.flow, session.stage ?? "");
      const isManualGate = stageDef?.gate === "manual";

      if (isManualGate) {
        // Manual gate: agent completed its task but session stays running
        result.logEvents!.push({
          type: "agent_completed",
          opts: {
            stage: session.stage ?? undefined,
            actor: "agent",
            data: { summary: (report as unknown as Record<string, unknown>).summary },
          },
        });
        // Don't change status -- session stays running, agent stays alive
      } else {
        // Auto gate: advance to next stage or complete the session
        result.updates.status = "ready";
        result.updates.session_id = null;
        // Clear any stale error from a previous failed attempt (e.g. on_failure retry).
        // Without this, evaluateGate("auto") rejects advancement because session.error is truthy.
        result.updates.error = null;
        result.shouldAdvance = true;
        result.shouldAutoDispatch = true;
      }
      break;
    }
    case "question": {
      const qr = report as unknown as Record<string, unknown>;
      result.updates.status = "waiting";
      result.updates.breakpoint_reason = (qr.question ?? qr.message) as string | null;
      break;
    }
    case "error": {
      const er = report as unknown as Record<string, unknown>;
      const errorMsg = String(er.error ?? er.message ?? "unknown error");
      result.updates.status = "failed";
      result.updates.error = errorMsg;

      // Build actionable suggestions based on error content
      const suggestions: string[] = [];
      if (errorMsg.includes("permission") || errorMsg.includes("denied")) {
        suggestions.push("Check file permissions and tool access settings");
      }
      if (errorMsg.includes("timeout") || errorMsg.includes("timed out")) {
        suggestions.push("Consider increasing the timeout or breaking the task into smaller steps");
      }
      if (errorMsg.includes("rate limit") || errorMsg.includes("429")) {
        suggestions.push("Wait a few minutes and retry, or switch to a different model provider");
      }
      if (suggestions.length === 0) {
        suggestions.push("Check terminal output for details", "Try restarting the session");
      }

      result.logEvents!.push({
        type: "session_failed",
        opts: {
          stage: session.stage ?? undefined,
          actor: "agent",
          data: {
            error: errorMsg,
            agent: session.agent,
            stage: session.stage,
            command: er.command ?? null,
            suggestions,
          },
        },
      });

      // Check on_failure directive for automatic retry
      if (session.stage && session.flow) {
        const errStageDef = flow.getStage(app, session.flow, session.stage);
        const retryDirective = parseOnFailure(errStageDef?.on_failure);
        if (retryDirective) {
          result.shouldRetry = true;
          result.retryMaxRetries = retryDirective.maxRetries;
        }
      }
      break;
    }
    case "progress": {
      // Agent is actively reporting -- ensure status reflects that.
      if (session.status === "waiting") {
        result.updates.status = "running";
        result.updates.breakpoint_reason = null;
      }
      break;
    }
  }

  // PR URL from agent report -- must be in updates so it's persisted
  // BEFORE mediateStageHandoff runs (the create_pr action checks s.pr_url).
  const prUrl = (report as unknown as Record<string, unknown>).pr_url as string | undefined;
  if (prUrl && !session.pr_url) {
    result.prUrl = prUrl;
    result.updates.pr_url = prUrl;
  }

  return result;
}

// ── Orchestrator-Mediated Stage Handoff ──────────────────────────────────────

export interface StageHandoffResult {
  /** Whether the handoff completed successfully */
  ok: boolean;
  /** Human-readable outcome message */
  message: string;
  /** The stage we advanced from (null if handoff was skipped) */
  fromStage?: string | null;
  /** The stage we advanced to (null if flow completed) */
  toStage?: string | null;
  /** Whether dispatch was triggered for the next stage */
  dispatched?: boolean;
  /** Whether the handoff was blocked by verification */
  blockedByVerification?: boolean;
  /** Whether the flow completed (no more stages) */
  flowCompleted?: boolean;
}

/**
 * Orchestrator-mediated stage handoff.
 *
 * This is the single entry point for advancing a session from one stage to the
 * next after an agent completes. It consolidates the verify -> advance -> dispatch
 * chain that was previously duplicated in the conductor's handleReport() and
 * handleHookStatus() handlers.
 *
 * The handoff sequence:
 *   1. Pre-advance verification (verify scripts + unresolved todos)
 *   2. advance() to transition to the next stage (or complete the flow)
 *   3. Auto-dispatch of the next stage (agent, fork, or action)
 *   4. Emit stage_handoff event for observability
 *
 * Callers: conductor handleReport(), conductor handleHookStatus(), or any
 * code path where shouldAdvance + shouldAutoDispatch are both true.
 */
export async function mediateStageHandoff(
  app: AppContext,
  sessionId: string,
  opts?: { autoDispatch?: boolean; source?: string; outcome?: string },
): Promise<StageHandoffResult> {
  const autoDispatch = opts?.autoDispatch ?? true;
  const source = opts?.source ?? "unknown";

  const session = app.sessions.get(sessionId);
  if (!session) {
    return { ok: false, message: `Session ${sessionId} not found` };
  }

  const fromStage = session.stage;

  // Step 1: Pre-advance verification (verify scripts + unresolved todos)
  if (fromStage && session.flow) {
    const stageDef = flow.getStage(app, session.flow, fromStage);
    const hasTodos = app.todos.list(sessionId).some((t) => !t.done);
    const repoVerify = session.workdir ? loadRepoConfig(session.workdir).verify : undefined;
    if (stageDef?.verify?.length || repoVerify?.length || hasTodos) {
      const verify = await runVerification(app, sessionId);
      if (!verify.ok) {
        logWarn("handoff", `stage handoff blocked by verification for ${sessionId}/${fromStage}: ${verify.message}`);
        app.sessions.update(sessionId, {
          status: "blocked",
          breakpoint_reason: `Verification failed before advancing: ${verify.message.slice(0, 200)}`,
        });
        app.messages.send(
          sessionId,
          "system",
          `Advance blocked: verification failed for stage '${fromStage}'. ${verify.message}`,
          "error",
        );
        app.events.log(sessionId, "stage_handoff_blocked", {
          actor: "system",
          stage: fromStage,
          data: { reason: "verification_failed", source, message: verify.message.slice(0, 500) },
        });
        return {
          ok: false,
          message: `Verification failed: ${verify.message}`,
          fromStage,
          blockedByVerification: true,
        };
      }
    }
  }

  // Step 2: Advance to the next stage (or complete the flow)
  const advResult = await advance(app, sessionId, false, opts?.outcome);
  if (!advResult.ok) {
    return { ok: false, message: advResult.message, fromStage };
  }

  const updated = app.sessions.get(sessionId);

  // Check if the flow completed (no more stages)
  if (updated?.status === "completed") {
    app.events.log(sessionId, "stage_handoff", {
      actor: "system",
      stage: fromStage ?? undefined,
      data: { from_stage: fromStage, to_stage: null, flow_completed: true, source },
    });
    return {
      ok: true,
      message: "Flow completed",
      fromStage,
      toStage: null,
      flowCompleted: true,
    };
  }

  const toStage = updated?.stage ?? null;

  // Step 3: Auto-dispatch the next stage if requested
  let dispatched = false;
  if (autoDispatch && updated?.status === "ready" && toStage) {
    const nextAction = flow.getStageAction(app, updated.flow, toStage);
    if (nextAction.type === "agent" || nextAction.type === "fork") {
      const dispatchResult = await safeAsync(`handoff: auto-dispatch ${sessionId}/${toStage}`, () =>
        dispatch(app, sessionId),
      );
      dispatched = dispatchResult;
    } else if (nextAction.type === "action") {
      await safeAsync(`auto-action: ${sessionId}/${nextAction.action}`, async () => {
        const verify = await runVerification(app, sessionId);
        if (!verify.ok) {
          logWarn("handoff", `action stage blocked by verification for ${sessionId}/${toStage}: ${verify.message}`);
          app.sessions.update(sessionId, {
            status: "blocked",
            breakpoint_reason: `Verification failed: ${verify.message.slice(0, 200)}`,
          });
          return;
        }
        const result = await executeAction(app, sessionId, nextAction.action ?? "");
        if (!result.ok) {
          logWarn("handoff", `action '${nextAction.action}' failed for ${sessionId}: ${result.message}`);
          app.sessions.update(sessionId, {
            status: "failed",
            error: `Action '${nextAction.action}' failed: ${result.message.slice(0, 200)}`,
          });
          return;
        }
        // Action succeeded -- chain into next stage unless the action
        // set a non-ready status (e.g. auto_merge sets "waiting").
        const postAction = app.sessions.get(sessionId);
        if (postAction?.status === "ready") {
          await mediateStageHandoff(app, sessionId, {
            autoDispatch: true,
            source: "action_chain",
          });
        }
      });
      dispatched = true;
    }
  }

  // Step 4: Emit handoff event for observability
  app.events.log(sessionId, "stage_handoff", {
    actor: "system",
    stage: toStage ?? undefined,
    data: {
      from_stage: fromStage,
      to_stage: toStage,
      dispatched,
      source,
    },
  });

  return {
    ok: true,
    message: dispatched
      ? `Handed off from '${fromStage}' to '${toStage}' (dispatched)`
      : `Advanced from '${fromStage}' to '${toStage}'`,
    fromStage,
    toStage,
    dispatched,
  };
}

// ── Fail-Loopback ────────────────────────────────────────────────────────────

/**
 * Parse an on_failure directive string.
 * Supports: "retry(N)" where N is max retry count, or "notify" (no retry).
 * Returns null if the directive doesn't indicate retry.
 */
export function parseOnFailure(directive: string | undefined): { retry: true; maxRetries: number } | null {
  if (!directive) return null;
  const match = directive.match(/^retry\((\d+)\)$/);
  if (!match) return null;
  return { retry: true, maxRetries: parseInt(match[1], 10) };
}

export function retryWithContext(
  app: AppContext,
  sessionId: string,
  opts?: { maxRetries?: number },
): { ok: boolean; message: string } {
  const s = app.sessions.get(sessionId);
  if (!s) return { ok: false, message: "Session not found" };
  if (s.status !== "failed") return { ok: false, message: "Session is not in failed state" };

  const maxRetries = opts?.maxRetries ?? 3;
  const priorRetries = app.events.list(sessionId).filter((e) => e.type === "retry_with_context").length;
  if (priorRetries >= maxRetries) {
    return { ok: false, message: `Max retries (${maxRetries}) reached` };
  }

  // Log the retry event with error context
  app.events.log(sessionId, "retry_with_context", {
    actor: "system",
    data: {
      attempt: priorRetries + 1,
      error: s.error,
      stage: s.stage,
    },
  });

  // Reset to ready for re-dispatch
  app.sessions.update(sessionId, { status: "ready", error: null });

  return { ok: true, message: `Retry ${priorRetries + 1}/${maxRetries} queued` };
}
