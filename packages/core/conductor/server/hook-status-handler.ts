/**
 * `/hooks/status` HTTP handler.
 *
 * Accepts two classes of payloads on the same endpoint:
 *   1. Classic hook events from the claude runtime (`hook_event_name` set).
 *   2. Channel-report passthrough from agent-sdk MCP `ask_user` and other
 *      non-hook emitters (`type: "question"|"progress"|"error"`) -- these
 *      are normalised into `OutboundMessage` and routed through the shared
 *      report pipeline so the UI sees one event shape regardless of source.
 *
 * The handler also evaluates guardrails on `PreToolUse` events and runs
 * the on-failure retry + terminal-cleanup side-effects for hook-driven
 * status transitions.
 */

import type { AppContext } from "../../app.js";
import { appForRequest } from "./tenant.js";
import type { OutboundMessage } from "../common/channel-types.js";
import { handleReport } from "./report-pipeline.js";
import { eventBus } from "../../hooks.js";
import { logDebug, logError, logInfo, logWarn } from "../../observability/structured-log.js";
import { emitStageSpanEnd, emitSessionSpanEnd, flushSpans } from "../../observability/otlp.js";

export async function handleHookStatus(app: AppContext, req: Request, url: URL): Promise<Response> {
  const sessionId = url.searchParams.get("session");
  if (!sessionId) return Response.json({ error: "missing session param" }, { status: 400 });

  const resolved = await appForRequest(app, req);
  if (resolved.ok === false) return resolved.response;
  const scoped = resolved.app;
  const s = await scoped.sessions.get(sessionId);
  if (!s) return Response.json({ error: "session not found" }, { status: 404 });

  const payload = (await req.json()) as Record<string, unknown>;
  const event = String(payload.hook_event_name ?? "");

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
      await handleReport(scoped, sessionId, report);
      return Response.json({ status: "ok", mapped: reportType });
    }
  }

  // Guard: ignore stale hook events from a previous stage's agent session.
  const hookAgentId = payload.session_id as string | undefined;
  if (hookAgentId && s.claude_session_id && hookAgentId !== s.claude_session_id) {
    return Response.json({ status: "ok", mapped: "ignored_stale" });
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
    await scoped.events.log(sessionId, "agent_message", {
      stage: hookStage,
      actor: "agent",
      data: {
        text: payload.text,
        ...(payload.thinking ? { thinking: true } : {}),
      },
    });
    return Response.json({ status: "ok", mapped: "agent_message" });
  }

  // Guardrail evaluation for PreToolUse events
  if (event === "PreToolUse") {
    const toolName = String(payload.tool_name ?? "");
    const toolInput = (payload.tool_input ?? {}) as Record<string, any>;
    const { evaluateToolCall } = await import("../../session/guardrails.js");
    const evalResult = evaluateToolCall(toolName, toolInput);

    if (evalResult.action === "block") {
      await scoped.events.log(sessionId, "guardrail_blocked", {
        actor: "system",
        data: { tool: toolName, pattern: evalResult.rule?.pattern, input: toolInput },
      });
    } else if (evalResult.action === "warn") {
      await scoped.events.log(sessionId, "guardrail_warning", {
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
      await scoped.sessions.update(sessionId, {
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
    await scoped.events.log(sessionId, "hook_status", {
      stage: hookStage,
      actor: "hook",
      data: { event, ...payload },
    });

    return Response.json({ status: "ok", guardrail: evalResult.action });
  }

  // Delegate business logic to session.ts
  const result = await scoped.sessionHooks.applyHookStatus(s, event, payload);

  // Apply events
  for (const evt of result.events ?? []) {
    await scoped.events.log(sessionId, evt.type, evt.opts);
  }

  // Apply store updates
  if (result.updates) {
    await scoped.sessions.update(sessionId, result.updates);
  }

  // Mark messages read on terminal states
  if (result.markRead) {
    await scoped.messages.markRead(sessionId);
  }

  // On-failure retry loop
  if (result.shouldRetry && result.newStatus === "failed") {
    const retryResult = await scoped.sessionHooks.retryWithContext(sessionId, {
      maxRetries: result.retryMaxRetries,
    });
    if (retryResult.ok) {
      logInfo("conductor", `on_failure retry (hook) triggered for ${sessionId}: ${retryResult.message}`);
      eventBus.emit("hook_status", sessionId, {
        data: { event, status: "ready", retry: true, ...payload } as Record<string, unknown>,
      });
      scoped.dispatchService.dispatch(sessionId).catch((err) => {
        logError("conductor", `on_failure retry dispatch (hook) failed for ${sessionId}: ${err?.message ?? err}`);
      });
      return Response.json({ status: "ok", mapped: "retry" });
    }
    logWarn("conductor", `on_failure retry (hook) exhausted for ${sessionId}: ${retryResult.message}`);
  }

  // Emit to event bus
  if (result.newStatus) {
    eventBus.emit("hook_status", sessionId, {
      data: { event, status: result.newStatus, ...payload } as Record<string, unknown>,
    });

    if (result.newStatus === "completed" || result.newStatus === "failed") {
      await scoped.sessionLifecycle.cleanupOnTerminal(sessionId);

      // Worktree removal + session_cleaned event (idempotent; safe to call
      // here without transactional coupling -- cleanup is external state only).
      try {
        const { cleanupSession } = await import("../../services/session/cleanup.js");
        const sessionForCleanup = await scoped.sessions.get(sessionId);
        if (sessionForCleanup) await cleanupSession(scoped, sessionForCleanup);
      } catch (err: any) {
        logDebug("conductor", `session cleanup non-fatal: ${err?.message ?? err}`);
      }

      emitStageSpanEnd(sessionId, { status: result.newStatus });
      emitSessionSpanEnd(sessionId, { status: result.newStatus });
      flushSpans();

      try {
        const { evaluateSession } = await import("../../knowledge/evals.js");
        const freshSession = await scoped.sessions.get(sessionId);
        if (freshSession) await evaluateSession(scoped, freshSession);
      } catch {
        logDebug("conductor", "skip eval on error");
      }
    }
  }

  if (result.shouldAdvance) {
    await scoped.sessionHooks.mediateStageHandoff(sessionId, {
      autoDispatch: result.shouldAutoDispatch,
      source: "hook_status",
    });
  }

  if (result.newStatus) {
    try {
      await scoped.ledger.addEntry(
        "default",
        "progress",
        `Session ${sessionId} status: ${result.newStatus}`,
        sessionId,
      );
    } catch {
      logDebug("conductor", "skip ledger on error");
    }
  }

  return Response.json({ status: "ok", mapped: result.newStatus ?? "no-op" });
}
