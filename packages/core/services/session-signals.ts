/**
 * Shared hook/report cascade logic.
 *
 * Extracted from the conductor HTTP handlers so that Temporal signal/activity
 * handlers can invoke the same business logic without going through HTTP.
 * The conductor files are now thin forwarders that delegate here after
 * parsing their request context.
 */

import type { AppContext } from "../app.js";
import type { OutboundMessage } from "../conductor/common/channel-types.js";
import { createWorktreePR } from "./worktree/index.js";
import { eventBus } from "../hooks.js";
import { safeAsync } from "../safe.js";
import { logDebug, logError, logInfo, logWarn } from "../observability/structured-log.js";
import { sendOSNotification } from "../notify.js";
import { markDispatchFailedShared } from "./session-dispatch-listeners.js";
import { emitStageSpanEnd, emitSessionSpanEnd, flushSpans } from "../observability/otlp.js";

/**
 * Handle an incoming hook status event from the conductor.
 * Called by the conductor and (in future) by Temporal signal handlers.
 *
 * @param app - AppContext scoped to the tenant (already resolved by the caller)
 * @param sessionId - Target session ID
 * @param event - The `hook_event_name` string from the payload
 * @param payload - Raw hook payload
 * @returns A short mapped string describing what was done (mirrors the HTTP response body's `mapped` field)
 */
export async function handleHookStatus(
  app: AppContext,
  sessionId: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const s = await app.sessions.get(sessionId);
  if (!s) return "session_not_found";

  // Channel-report passthrough: the agent-sdk `ask_user` MCP (and any future
  // non-hook emitters) POST `{type: "question"|"progress"|"error"}` payloads
  // here without a `hook_event_name`. Route them through the same report
  // pipeline the claude runtime's conductor-channel uses so the UI sees one
  // event shape regardless of source.
  if (!payload.hook_event_name && typeof payload.type === "string") {
    const reportType = payload.type as string;
    if (reportType === "question" || reportType === "progress" || reportType === "error") {
      const msgText = (payload.message ?? payload.question ?? payload.error ?? "") as string;
      const report = {
        type: reportType,
        sessionId,
        stage: (payload.stage as string) ?? "",
        ...(reportType === "question" ? { question: msgText } : {}),
        ...(reportType === "error" ? { error: msgText } : {}),
        ...(reportType === "progress" ? { message: msgText } : {}),
        ...(payload.context != null ? { context: payload.context } : {}),
        ...(payload.source ? { source: payload.source } : {}),
      } as unknown as OutboundMessage;
      await handleReport(app, sessionId, report);
      return `mapped:${reportType}`;
    }
  }

  // Guard: ignore stale hook events from a previous stage's agent session.
  const hookAgentId = payload.session_id as string | undefined;
  if (hookAgentId && s.claude_session_id && hookAgentId !== s.claude_session_id) {
    return "ignored_stale";
  }

  // Each runtime stamps the stage it was provisioned for onto every hook.
  // Prefer the payload's stage over `session.stage` -- the latter flaps
  // when the state machine advances mid-flight (#435: status-poller
  // false-positive advanced session.stage while the agent kept running),
  // which would re-stamp historical events with the wrong stage.
  const hookStage = (typeof payload.stage === "string" && payload.stage) || s.stage || undefined;

  // Agent narration / extended-thinking text blocks. These are not hooks in
  // the conductor state-machine sense -- they don't transition status, they
  // don't pair with anything, they're just human-readable progress for the
  // UI. Log under a dedicated event type so the timeline-builder can render
  // them inline with tool blocks without going through the hook_status
  // pairing path.
  if (event === "AgentMessage") {
    await app.events.log(sessionId, "agent_message", {
      stage: hookStage,
      actor: "agent",
      data: {
        text: payload.text,
        ...(payload.thinking ? { thinking: true } : {}),
      },
    });
    return "agent_message";
  }

  // Guardrail evaluation for PreToolUse events
  if (event === "PreToolUse") {
    const toolName = String(payload.tool_name ?? "");
    const toolInput = (payload.tool_input ?? {}) as Record<string, any>;
    const { evaluateToolCall } = await import("../session/guardrails.js");
    const evalResult = evaluateToolCall(toolName, toolInput);

    if (evalResult.action === "block") {
      await app.events.log(sessionId, "guardrail_blocked", {
        actor: "system",
        data: { tool: toolName, pattern: evalResult.rule?.pattern, input: toolInput },
      });
    } else if (evalResult.action === "warn") {
      await app.events.log(sessionId, "guardrail_warning", {
        actor: "system",
        data: { tool: toolName, pattern: evalResult.rule?.pattern },
      });
    }

    // Persist the agent's explicit stage-completion signal. Without this,
    // SessionEnd's commit-verifier cannot distinguish "agent deliberately
    // ended the stage with nothing to commit" from "agent drifted and
    // exited" -- it falls back to no-commits=failure and incorrectly fails
    // sessions where complete_stage was the right outcome (e.g. the user
    // steered "answer this question and stop").
    if (toolName === "mcp__ark-stage-control__complete_stage") {
      const reason = typeof toolInput.reason === "string" ? toolInput.reason : undefined;
      const stageForSignal = (typeof hookStage === "string" && hookStage) || s.stage || "";
      await app.sessions.update(sessionId, {
        config: {
          ...s.config,
          stage_complete_signaled: {
            stage: stageForSignal,
            ...(reason ? { reason } : {}),
            ts: new Date().toISOString(),
          },
        },
      });
    }

    // Log the PreToolUse hook itself so the timeline can render the tool
    // call as soon as it's invoked (not just after PostToolUse lands).
    // Without this, every Pre is dropped and the matching Post becomes an
    // orphan in `buildConversationTimeline`. PreToolUse doesn't transition
    // session state, so we don't route it through applyHookStatus. Shape
    // matches what applyHookStatus writes: { event: hookEventName, ...rest }.
    await app.events.log(sessionId, "hook_status", {
      stage: hookStage,
      actor: "hook",
      data: { event, ...payload },
    });

    return `guardrail:${evalResult.action}`;
  }

  // Delegate business logic to session.ts
  const result = await app.sessionHooks.applyHookStatus(s, event, payload);

  // Apply events
  for (const evt of result.events ?? []) {
    await app.events.log(sessionId, evt.type, evt.opts);
  }

  // Apply store updates
  if (result.updates) {
    await app.sessions.update(sessionId, result.updates);
  }

  // Mark messages read on terminal states
  if (result.markRead) {
    await app.messages.markRead(sessionId);
  }

  // On-failure retry loop
  if (result.shouldRetry && result.newStatus === "failed") {
    const retryResult = await app.sessionHooks.retryWithContext(sessionId, {
      maxRetries: result.retryMaxRetries,
    });
    if (retryResult.ok) {
      logInfo("conductor", `on_failure retry (hook) triggered for ${sessionId}: ${retryResult.message}`);
      eventBus.emit("hook_status", sessionId, {
        data: { event, status: "ready", retry: true, ...payload } as Record<string, unknown>,
      });
      app.dispatchService.dispatch(sessionId).catch((err) => {
        logError("conductor", `on_failure retry dispatch (hook) failed for ${sessionId}: ${err?.message ?? err}`);
      });
      return "retry";
    }
    logWarn("conductor", `on_failure retry (hook) exhausted for ${sessionId}: ${retryResult.message}`);
  }

  // Emit to event bus
  if (result.newStatus) {
    eventBus.emit("hook_status", sessionId, {
      data: { event, status: result.newStatus, ...payload } as Record<string, unknown>,
    });

    if (result.newStatus === "completed" || result.newStatus === "failed") {
      await app.sessionLifecycle.cleanupOnTerminal(sessionId);

      // Worktree removal + session_cleaned event (idempotent; safe to call
      // here without transactional coupling -- cleanup is external state only).
      try {
        const { cleanupSession } = await import("./session/cleanup.js");
        const sessionForCleanup = await app.sessions.get(sessionId);
        if (sessionForCleanup) await cleanupSession(app, sessionForCleanup);
      } catch (err: any) {
        logDebug("conductor", `session cleanup non-fatal: ${err?.message ?? err}`);
      }

      emitStageSpanEnd(sessionId, { status: result.newStatus });
      emitSessionSpanEnd(sessionId, { status: result.newStatus });
      flushSpans();
    }
  }

  if (result.shouldAdvance) {
    await app.sessionHooks.mediateStageHandoff(sessionId, {
      autoDispatch: result.shouldAutoDispatch,
      source: "hook_status",
    });
  }

  if (result.newStatus) {
    try {
      await app.ledger.addEntry("default", "progress", `Session ${sessionId} status: ${result.newStatus}`, sessionId);
    } catch {
      logDebug("conductor", "skip ledger on error");
    }
  }

  return result.newStatus ?? "no-op";
}

/**
 * Handle an incoming channel CompletionReport.
 * Called by the conductor and (in future) by Temporal activities.
 */
export async function handleReport(app: AppContext, sessionId: string, report: OutboundMessage): Promise<void> {
  const result = await app.sessionHooks.applyReport(sessionId, report);

  for (const evt of result.logEvents ?? []) {
    await app.events.log(sessionId, evt.type, evt.opts);
  }

  if (result.message) {
    await app.messages.send(sessionId, result.message.role, result.message.content, result.message.type);
  }

  for (const evt of result.busEvents ?? []) {
    eventBus.emit(evt.type, evt.sessionId, evt.data);
  }

  if (Object.keys(result.updates).length > 0) {
    await app.sessions.update(sessionId, result.updates);
  }

  if (result.shouldAdvance) {
    try {
      const handoff = await app.sessionHooks.mediateStageHandoff(sessionId, {
        autoDispatch: result.shouldAutoDispatch,
        source: "channel_report",
        outcome: result.outcome,
      });
      if (!handoff.ok && !handoff.blockedByVerification) {
        logWarn("conductor", `stage handoff failed for ${sessionId}: ${handoff.message}`);
      }
      if (handoff.blockedByVerification) {
        const s = await app.sessions.get(sessionId);
        await sendOSNotification(
          "Ark: Verification failed",
          `${s?.summary ?? sessionId} - ${handoff.message.slice(0, 100)}`,
        );
        return;
      }
    } catch (handoffErr: any) {
      logError("conductor", `mediateStageHandoff failed for ${sessionId}: ${handoffErr?.message ?? handoffErr}`);
    }
  }

  if (result.shouldRetry) {
    const retryResult = await app.sessionHooks.retryWithContext(sessionId, {
      maxRetries: result.retryMaxRetries,
    });
    if (retryResult.ok) {
      logInfo("conductor", `on_failure retry triggered for ${sessionId}: ${retryResult.message}`);
      // Inspect the resolved DispatchResult so non-throwing failures
      // (`{ok:false}`) are surfaced too. Pre-fix only `.catch` ran, and
      // `{ok:false}` was silently dropped -- the on_failure retry would
      // appear "scheduled" but the session never made progress. Now both
      // throw and ok:false flip the session to failed.
      app.dispatchService
        .dispatch(sessionId)
        .then(async (r) => {
          if (r && r.ok === false) {
            const reason = r.message ?? "on_failure retry returned ok:false";
            logWarn("conductor", `on_failure retry dispatch returned ok:false for ${sessionId}: ${reason}`);
            await markDispatchFailedShared(app.sessions, app.events, sessionId, reason);
          }
        })
        .catch(async (err) => {
          const reason = err instanceof Error ? err.message : String(err);
          logError("conductor", `on_failure retry dispatch failed for ${sessionId}: ${reason}`);
          await markDispatchFailedShared(app.sessions, app.events, sessionId, reason);
        });
      return;
    }
    logWarn("conductor", `on_failure retry exhausted for ${sessionId}: ${retryResult.message}`);
  }

  const finalSession = await app.sessions.get(sessionId);
  if (finalSession && (report.type === "completed" || report.type === "error")) {
    const notifyTitle = report.type === "completed" ? "Stage completed" : "Session failed";
    const notifyBody = `${finalSession.summary ?? sessionId} - ${finalSession.stage ?? ""}`;
    await sendOSNotification(`Ark: ${notifyTitle}`, notifyBody);
  }

  if (result.prUrl) {
    await app.events.log(sessionId, "pr_detected", {
      actor: "agent",
      data: { pr_url: result.prUrl },
    });
  }

  try {
    const r = report as unknown as Record<string, unknown>;
    if (result.prUrl) {
      await app.artifacts.add(sessionId, "pr", [result.prUrl]);
    }
    if (Array.isArray(r.filesChanged) && r.filesChanged.length > 0) {
      await app.artifacts.add(sessionId, "file", r.filesChanged as string[]);
    }
    if (Array.isArray(r.commits) && r.commits.length > 0) {
      await app.artifacts.add(sessionId, "commit", r.commits as string[]);
    }
    const s = await app.sessions.get(sessionId);
    if (s?.branch && report.type === "completed") {
      await app.artifacts.add(sessionId, "branch", [s.branch]);
    }
  } catch {
    logDebug("conductor", "best-effort artifact tracking");
  }

  if (report.type === "completed" && !result.prUrl) {
    const s = await app.sessions.get(sessionId);
    if (s && !s.pr_url && s.config?.github_url && s.branch) {
      const { loadRepoConfig } = await import("../repo-config.js");
      const repoConfig = s.workdir ? loadRepoConfig(s.workdir) : {};
      const autoPR = repoConfig.auto_pr !== false;

      if (autoPR) {
        await safeAsync(`auto-pr: ${sessionId}`, async () => {
          const prResult = await createWorktreePR(app, sessionId, {
            title: s.summary ?? undefined,
          });
          if (prResult.ok && prResult.pr_url) {
            logInfo("conductor", `auto-PR created for ${sessionId}: ${prResult.pr_url}`);
          }
        });
      }
    }
  }
}
