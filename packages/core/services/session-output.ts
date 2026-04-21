/**
 * Session output and messaging -- capture tmux output, send messages to agents.
 *
 * Extracted from session-orchestration.ts. All functions take app: AppContext as first arg.
 */

import type { AppContext } from "../app.js";
import { resolveProvider } from "../provider-registry.js";
import { detectInjection } from "../session/prompt-guard.js";
import { logDebug } from "../observability/structured-log.js";

export async function getOutput(
  app: AppContext,
  sessionId: string,
  opts?: { lines?: number; ansi?: boolean },
): Promise<string> {
  const session = await app.sessions.get(sessionId);
  if (!session) return "";

  // For running sessions, capture live from tmux
  if (session.session_id) {
    const { provider, compute } = await resolveProvider(session);
    if (provider && compute) {
      const live = await provider.captureOutput(compute, session, opts);
      if (live) return live;
    }
  }

  // For completed/stopped sessions (or when live capture returns empty),
  // fall back to the recorded terminal output file.
  const { readRecording } = await import("../recordings.js");
  return readRecording(app.config.arkDir, sessionId) ?? "";
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

  const { sendReliable } = await import("../send-reliable.js");
  const result = await sendReliable(session.session_id, message, { waitForReady: false, maxRetries: 3 });
  return { ok: result.ok, message: result.message };
}
