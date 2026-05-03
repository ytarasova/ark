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

  // Dispatch on runtime kind:
  //   - claude-agent: in-process Anthropic SDK with its own PromptQueue, fed
  //     by the arkd intervention stream. Send via provider.sendIntervention
  //     so remote-dispatch sessions reach the worker's arkd queue, not the
  //     conductor's tmux. Local claude-agent uses local-arkd, same code path.
  //   - claude-code (legacy CLI in tmux): keep the tmux send-keys path. Only
  //     works when the pane is on the conductor host -- remote claude-code is
  //     a separate ticket (#418/#422 family) and out of scope here.
  // The dispatcher writes session.config.launch_executor when it resolves the
  // runtime for launch (post-launch.ts). Older sessions store the legacy
  // "agent-sdk" name; both map to the in-process SDK runtime.
  const launchExecutor = (session.config?.launch_executor as string | undefined) ?? "";
  const isClaudeAgent = launchExecutor === "claude-agent" || launchExecutor === "agent-sdk";

  if (isClaudeAgent) {
    const { provider, compute } = await app.resolveProvider(session);
    if (provider?.sendIntervention && compute) {
      try {
        await provider.sendIntervention(compute, session, message);
        return { ok: true, message: "Delivered" };
      } catch (e: any) {
        return { ok: false, message: `intervention publish failed: ${e?.message ?? e}` };
      }
    }
    // No provider with sendIntervention -- claude-agent without arkd is a
    // dev-mode-only configuration; nothing to send to.
    return { ok: false, message: "claude-agent has no reachable arkd to publish to" };
  }

  // claude-code path: tmux send-keys via sendReliable.
  const { sendReliable } = await import("../send-reliable.js");
  const result = await sendReliable(session.session_id, message, { waitForReady: false, maxRetries: 3 });
  return { ok: result.ok, message: result.message };
}
