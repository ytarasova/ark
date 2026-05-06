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

    // Each runtime stamps the stage it was provisioned for onto its hook
    // payload. Prefer that over `session.stage` for any event we log in
    // response -- the latter flaps when the state machine advances
    // mid-flight (#435) and would re-stamp the runtime's traffic with
    // whichever stage happens to be current at write time.
    const hookStage = (typeof payload.stage === "string" && payload.stage) || session.stage || undefined;

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

      // Rescue path: agent exited without committing, but the worktree has
      // uncommitted changes. Don't waste the work -- auto-commit so the
      // flow can advance. This typically happens when the prompt gates
      // commits behind a check the agent decided didn't pass (e.g. lint
      // failed) and the model interprets that as "stop without committing"
      // rather than "fix lint and then commit".
      if (!hasNewCommits && session.workdir) {
        const rescue = autoCommitUncommittedChanges(session.workdir, session.stage ?? null);
        if (rescue.committed) {
          hasNewCommits = true;
          result.events!.push({
            type: "auto_commit",
            opts: {
              stage: hookStage,
              actor: "system",
              data: {
                reason: "agent exited with uncommitted changes",
                files_changed: rescue.filesChanged,
                head_sha: rescue.headSha,
              },
            },
          });
        }
      }

      if (hasNewCommits) {
        result.shouldAdvance = true;
        result.shouldAutoDispatch = true;
      } else if (
        session.config?.stage_complete_signaled &&
        session.config.stage_complete_signaled.stage === (hookStage || session.stage || "")
      ) {
        // Agent explicitly called `complete_stage` for this stage and just
        // had nothing to commit (e.g. a user steer that asked for a reply
        // with no code change, or a verify/review stage whose outcome is a
        // pass/fail decision rather than a diff). Trust the signal --
        // advance the flow instead of failing on the commit heuristic.
        result.shouldAdvance = true;
        result.shouldAutoDispatch = true;
        result.events!.push({
          type: "stage_complete_no_commits",
          opts: {
            stage: hookStage,
            actor: "agent",
            data: {
              reason: session.config.stage_complete_signaled.reason ?? "complete_stage signaled with no commits",
              signaled_at: session.config.stage_complete_signaled.ts,
            },
          },
        });
      } else {
        newStatus = "failed" as any;
        if (!result.updates) result.updates = {};
        result.updates.error = "Agent exited without committing any changes";
        result.events!.push({
          type: "completion_rejected",
          opts: { stage: hookStage, actor: "system", data: { reason: "no commits on SessionEnd" } },
        });
      }
    }

    // Don't override terminal status -- late hooks can fire after session is
    // done. Once a session is failed/completed/stopped/archived the only
    // legitimate transition out is `retryWithContext` / `restore` (which go
    // through their own paths and emit their own events); a late SessionEnd
    // / Stop / etc. must not flip the row back to `ready` or `running`
    // (#435: auto_merge fails -> status=failed, then a delayed SessionEnd
    // from the still-running EC2 agent maps SessionEnd to "ready" via
    // `statusMap[SessionEnd] = "ready"` and silently un-fails the row --
    // UI shows PENDING + dispatch_failed simultaneously).
    //
    // `archived` was originally not in this list -- but archive() does NOT
    // wait for the agent process to exit, so claude-agent processes can
    // outlive the archive write and emit a delayed SessionEnd that flips
    // status back to `ready` with no `session_*` event in the log (the
    // hook handler only emits `hook_status` for the inbound event).
    // Reproduced 2026-05-06 on the fleet -- two `archived` sessions came
    // back as `ready` ~7 minutes after archive, no daemon restart, no
    // intervening event. See memory: project_zombie_session_revival_bug.md.
    const TERMINAL_STATUSES = ["completed", "failed", "stopped", "archived"] as const;
    if (
      newStatus &&
      (TERMINAL_STATUSES as readonly string[]).includes(session.status) &&
      newStatus !== session.status
    ) {
      newStatus = undefined;
    }

    if (hookEvent === "Notification") {
      const matcher = String(payload.matcher ?? "");
      if (matcher.includes("permission_prompt") || matcher.includes("idle_prompt")) {
        newStatus = "waiting";
      }
    }

    // Always log the hook event. Stamp the runtime-provided stage rather
    // than session.stage so the timeline attribution survives any mid-flight
    // state-machine flap.
    result.events!.push({
      type: "hook_status",
      opts: { stage: hookStage, actor: "hook", data: { event: hookEvent, ...payload } as Record<string, unknown> },
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
            stage: hookStage,
            data: {
              error: errorMsg,
              agent: session.agent,
              stage: hookStage,
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
            usage.input_tokens + usage.output_tokens + (usage.cache_read_tokens ?? 0) + (usage.cache_write_tokens ?? 0);
          if (total > 0) {
            recordSessionUsage(session, usage, "anthropic", "transcript");
          }
        }
      } catch (e: any) {
        logError("session", "transcript parsing failed", { sessionId: session.id, error: String(e?.message ?? e) });
      }
    }

    // agent-sdk emits Stop / SessionEnd with the cost + usage attached
    // directly to the hook payload (no transcript file). Without this branch
    // every agent-sdk session showed `$0.00` and `0 tokens` in the
    // SessionSummary panel + Cost tab even though the cost was sitting in
    // the event row.
    //
    // Only record on `Stop`, not on `SessionEnd`. The agent-sdk launch
    // script emits *both* hooks for every result with identical
    // `total_cost_usd` / `usage` payloads (Stop is canonical, SessionEnd
    // is the synthetic transition hook the conductor's state machine
    // needs). Recording on both would double-count the ledger.
    if (!transcriptPath && hookEvent === "Stop" && payload.usage && typeof payload.usage === "object") {
      const u = payload.usage as Record<string, unknown>;
      const usage = {
        input_tokens: typeof u.input_tokens === "number" ? u.input_tokens : 0,
        output_tokens: typeof u.output_tokens === "number" ? u.output_tokens : 0,
        cache_read_tokens: typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0,
        cache_write_tokens: typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0,
      };
      const total = usage.input_tokens + usage.output_tokens + usage.cache_read_tokens + usage.cache_write_tokens;
      if (total > 0) {
        recordSessionUsage(session, usage, "anthropic", "agent-sdk-hook");
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

/**
 * Best-effort auto-commit of uncommitted worktree changes when an agent
 * exits without committing. Returns committed=true with a file count and
 * the new HEAD sha when something was committed; committed=false when the
 * worktree is clean or git refuses (which we treat as "the strict
 * no-commits failure path is correct after all").
 *
 * We pass user.name/user.email via -c flags so we don't depend on any
 * AppContext or local git config -- the values mirror the defaults from
 * services/worktree/setup.ts (applyWorktreeGitIdentity).
 */
function autoCommitUncommittedChanges(
  workdir: string,
  stage: string | null,
): { committed: boolean; filesChanged: number; headSha: string | null } {
  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: workdir,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    if (!status) return { committed: false, filesChanged: 0, headSha: null };

    const filesChanged = status.split("\n").filter((l) => l.trim().length > 0).length;

    execFileSync("git", ["add", "-A"], { cwd: workdir, encoding: "utf-8", timeout: 5000 });

    const stageLabel = stage ? ` (${stage})` : "";
    const message = `[ark] auto-commit: agent did not commit before exit${stageLabel}`;

    execFileSync(
      "git",
      ["-c", "user.name=Ark Agent", "-c", "user.email=agent@ark.local", "commit", "--no-verify", "-m", message],
      { cwd: workdir, encoding: "utf-8", timeout: 10_000 },
    );

    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workdir,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();

    return { committed: true, filesChanged, headSha };
  } catch (err) {
    logDebug("session", "auto-commit fallback failed -- leaving session in failed state", {
      workdir,
      error: err instanceof Error ? err.message : String(err),
    });
    return { committed: false, filesChanged: 0, headSha: null };
  }
}
