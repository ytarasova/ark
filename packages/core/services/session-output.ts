/**
 * Session output and messaging -- capture tmux output, send messages to agents.
 *
 * Extracted from session-orchestration.ts. All functions take app: AppContext as first arg.
 */

import type { AppContext } from "../app.js";
import { detectInjection } from "../session/prompt-guard.js";
import { logDebug } from "../observability/structured-log.js";

export async function getOutput(
  app: AppContext,
  sessionId: string,
  opts?: { lines?: number; ansi?: boolean },
): Promise<string> {
  const session = await app.sessions.get(sessionId);
  if (!session) return "";

  // For running sessions, capture live from tmux. Resolve the provider via the
  // session's tenant-scoped AppContext so that compute lookup respects the
  // (name, tenant_id) primary key on the compute table -- otherwise two tenants
  // with the same compute name would collide.
  if (session.session_id) {
    const tenantApp = session.tenant_id ? app.forTenant(session.tenant_id) : app;
    const { provider, compute } = await tenantApp.resolveProvider(session);
    if (provider && compute) {
      const live = await provider.captureOutput(compute, session, opts);
      if (live) return live;
    }
  }

  // For completed/stopped sessions (or when live capture returns empty),
  // fall back to the recorded terminal output file.
  const { readRecording } = await import("../recordings.js");
  return readRecording(app.config.dirs.ark, sessionId) ?? "";
}

export async function send(
  app: AppContext,
  sessionId: string,
  message: string,
): Promise<{ ok: boolean; message: string }> {
  const session = await app.sessions.get(sessionId);
  if (!session?.session_id) return { ok: false, message: "No active session" };

  // Check for prompt injection in user messages
  try {
    const injection = detectInjection(message);
    if (injection.severity === "high") {
      await app.events.log(sessionId, "prompt_injection_blocked", {
        actor: "system",
        data: { patterns: injection.patterns },
      });
      return { ok: false, message: "Message blocked: potential prompt injection detected" };
    }
    if (injection.detected) {
      await app.events.log(sessionId, "prompt_injection_warning", {
        actor: "system",
        data: { patterns: injection.patterns, severity: injection.severity },
      });
    }
  } catch {
    logDebug("session", "skip prompt guard on error");
  }

  // Audit: log user message sent (pre-delivery). Paired with `message_delivered`
  // or `message_delivery_failed` below so the timeline shows the full attempt,
  // not just the intent.
  await app.events.log(sessionId, "message_sent", {
    actor: "user",
    stage: session.stage ?? undefined,
    data: { length: message.length, preview: message.slice(0, 100) },
  });

  // Persist user message to conversation history before sending to agent
  await app.messages.send(sessionId, "user", message, "text");

  // Runtime polymorphism: each executor owns its own send strategy. We
  // delegate via the registry rather than branching here so adding a new
  // runtime (e.g. opencode, codex) is purely an executor change --
  // session-output stays runtime-agnostic.
  const { resolveSessionExecutor } = await import("../executors/resolve.js");
  const launchExecutor = await resolveSessionExecutor(app, session);
  if (!launchExecutor) {
    return {
      ok: false,
      message: `cannot resolve runtime for session ${sessionId}: launch_executor missing and agent has no runtime field`,
    };
  }
  const { getExecutor } = await import("../executor.js");
  const executor = getExecutor(launchExecutor);
  const tSend = Date.now();
  if (executor?.sendUserMessage) {
    try {
      const result = await executor.sendUserMessage({ app, session, message });
      await logSendOutcome(app, sessionId, session.stage ?? undefined, message, launchExecutor, tSend, result);
      return result;
    } catch (e: any) {
      const msg = `executor send failed: ${e?.message ?? e}`;
      await logSendOutcome(app, sessionId, session.stage ?? undefined, message, launchExecutor, tSend, {
        ok: false,
        message: msg,
      });
      return { ok: false, message: msg };
    }
  }

  // Legacy fallback for executors that haven't implemented sendUserMessage
  // yet (goose / cli-agent / subprocess) -- their existing tmux send is
  // local-only; remote-dispatch is tracked separately under the #418/#422
  // family.
  const { sendReliable } = await import("../send-reliable.js");
  const result = await sendReliable(session.session_id, message, { waitForReady: false, maxRetries: 3 });
  const normalized = { ok: result.ok, message: result.message };
  await logSendOutcome(app, sessionId, session.stage ?? undefined, message, launchExecutor, tSend, normalized);
  return normalized;
}

/**
 * Emit the paired outcome event for a user-message send attempt. Called from
 * both the executor-polymorphic path and the legacy sendReliable fallback so
 * every `message_sent` audit row is followed by either `message_delivered`
 * (ok=true) or `message_delivery_failed` (ok=false). Failures never throw --
 * the session is healthier without an observability entry than crashed by one.
 */
async function logSendOutcome(
  app: AppContext,
  sessionId: string,
  stage: string | undefined,
  message: string,
  executor: string,
  tStart: number,
  result: { ok: boolean; message: string; delivered?: boolean },
): Promise<void> {
  try {
    if (result.ok) {
      await app.events.log(sessionId, "message_delivered", {
        actor: "system",
        stage,
        data: {
          length: message.length,
          executor,
          // `delivered` comes from arkd's publish response for wire-based
          // runtimes (claude-agent). Undefined for tmux-based runtimes where
          // the concept doesn't map -- the UI can fall back to "delivered"
          // for those.
          delivered: result.delivered,
          elapsedMs: Date.now() - tStart,
        },
      });
    } else {
      await app.events.log(sessionId, "message_delivery_failed", {
        actor: "system",
        stage,
        data: {
          length: message.length,
          executor,
          reason: result.message,
          elapsedMs: Date.now() - tStart,
        },
      });
    }
  } catch {
    // Swallow: a failed audit-event write must not mask the actual send result.
    logDebug("session", "logSendOutcome: event write failed");
  }
}
