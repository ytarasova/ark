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

  // Audit: log user message sent
  await app.events.log(sessionId, "message_sent", {
    actor: "user",
    stage: session.stage ?? undefined,
    data: { length: message.length, preview: message.slice(0, 100) },
  });

  // Persist user message to conversation history before sending to agent
  await app.messages.send(sessionId, "user", message, "text");

  // Runtime polymorphism: each executor owns its own send strategy. The
  // dispatcher writes session.config.launch_executor when it resolves the
  // runtime for launch (post-launch.ts). claude-agent posts to arkd's user-
  // message queue; claude-code uses tmux send-keys; goose / cli-agent / etc.
  // implement whatever transport their runtime exposes.
  //
  // We deliberately delegate via the registry rather than branching here so
  // adding a new runtime (e.g. opencode, codex) is purely an executor change
  // -- session-output stays runtime-agnostic.
  const launchExecutor = (session.config?.launch_executor as string | undefined) ?? "claude-code";
  const { getExecutor } = await import("../executor.js");
  const executor = getExecutor(launchExecutor);
  if (executor?.sendUserMessage) {
    try {
      return await executor.sendUserMessage({ app, session, message });
    } catch (e: any) {
      return { ok: false, message: `executor send failed: ${e?.message ?? e}` };
    }
  }

  // Legacy fallback for executors that haven't implemented sendUserMessage
  // yet (goose / cli-agent / subprocess) -- their existing tmux send is
  // local-only; remote-dispatch is tracked separately under the #418/#422
  // family.
  const { sendReliable } = await import("../send-reliable.js");
  const result = await sendReliable(session.session_id, message, { waitForReady: false, maxRetries: 3 });
  return { ok: result.ok, message: result.message };
}
