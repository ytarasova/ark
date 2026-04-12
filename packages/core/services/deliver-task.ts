/**
 * Initial task delivery for autonomous dispatch.
 *
 * Background: Claude Code's system prompt (set via --append-system-prompt)
 * only primes the assistant with context -- it does NOT trigger a turn.
 * Claude waits for a first USER MESSAGE before it begins work. In manual
 * mode the human types that message. In autonomous `--dispatch` mode
 * there's no human, so the session boots and sits idle.
 *
 * This module sends the first user message programmatically after tmux
 * + Claude Code are up and Claude has finished its boot sequence. It
 * reuses the hardened `sendReliable` send path (paste-marker retry).
 *
 * The operation is idempotent per session -- if called twice for the
 * same session, only the first invocation sends.
 */

import type { AppContext } from "../app.js";
import type { Session } from "../../types/index.js";
import { logError, logWarn } from "../observability/structured-log.js";

/** In-flight delivery tracker -- prevents double-send on retry/race. */
const deliveryInFlight = new Set<string>();
/** Completed deliveries -- prevents re-send on manual re-dispatch. */
const deliveryCompleted = new Set<string>();

/**
 * Build the autonomous first-user-message prompt for a session.
 * Always includes the task summary and workdir. This is what Claude
 * will see as its first user turn.
 */
export function buildAutonomousPrompt(session: Session): string {
  const summary = session.summary?.trim() || session.ticket?.trim() || "(no summary provided)";
  const workdir = session.workdir ?? session.repo ?? "(unknown)";

  return [
    `Begin working on the following task immediately. Do not ask for confirmation.`,
    `When you are finished, call the \`report\` tool (from the ark-channel MCP) with type='completed' and a concise summary of what you accomplished (files changed, tests added, key decisions). If you hit a blocker you can't resolve, call \`report\` with type='question'.`,
    ``,
    `Task: ${summary}`,
    `Workdir: ${workdir}`,
    session.repo ? `Repo: ${session.repo}` : "",
    session.branch ? `Branch: ${session.branch}` : "",
  ].filter(Boolean).join("\n");
}

/**
 * Deliver the initial user message to a just-launched Claude session.
 *
 * Safe to call multiple times -- idempotent per session.id. Fire-and-forget
 * friendly: the returned promise resolves when delivery is complete or fails,
 * but callers don't need to await it (it logs errors internally).
 *
 * Steps:
 *   1. Guard against double-delivery (deliveryInFlight + deliveryCompleted).
 *   2. Wait for Claude Code to finish its boot sequence (poll tmux pane
 *      for "working" markers the same way autoAcceptChannelPrompt does).
 *   3. Send the message via sendReliable (hardened paste-marker retry).
 *   4. Record the event to the session log.
 */
export async function deliverInitialPrompt(
  app: AppContext,
  session: Session,
  message: string,
  opts?: { readyTimeoutMs?: number },
): Promise<{ ok: boolean; message: string }> {
  const sessionId = session.id;
  const tmuxName = session.session_id;
  if (!tmuxName) {
    return { ok: false, message: "no tmux handle on session" };
  }

  if (deliveryCompleted.has(sessionId)) {
    return { ok: true, message: "already delivered" };
  }
  if (deliveryInFlight.has(sessionId)) {
    return { ok: true, message: "delivery in flight" };
  }
  deliveryInFlight.add(sessionId);

  try {
    // Wait for Claude Code to boot. We reuse the same tmux-pane markers as
    // autoAcceptChannelPrompt: when "esc to interrupt" / "ctrl+o to expand"
    // appear, Claude has finished startup and is sitting at its main prompt.
    // If the markers never appear (e.g. Claude failed to start), fall through
    // after the timeout and let sendReliable do its own readiness gating.
    const tmux = await import("../infra/tmux.js");
    const deadline = Date.now() + (opts?.readyTimeoutMs ?? 45_000);
    const workingMarkers = ["ctrl+o to expand", "esc to interrupt"];
    let ready = false;
    while (Date.now() < deadline) {
      // Bail early if the session was stopped/deleted while we were polling.
      // Without this, a killed session leaves a ghost fire-and-forget polling
      // loop that eventually fires sendText against a dead tmux target.
      const fresh = app.sessions.get(sessionId);
      if (!fresh || fresh.status === "stopped" || fresh.status === "failed" || fresh.status === "deleting") {
        return { ok: false, message: `session no longer running (${fresh?.status ?? "missing"})` };
      }
      try {
        const pane = await tmux.capturePaneAsync(tmuxName, { lines: 40 });
        if (workingMarkers.some(m => pane.toLowerCase().includes(m))) {
          ready = true;
          break;
        }
      } catch { /* pane may not exist yet */ }
      await new Promise(r => setTimeout(r, 500));
    }
    if (!ready) {
      logWarn("session", `deliver-task ${sessionId}: Claude boot markers never appeared, proceeding anyway`);
    }

    // Small grace period so Claude's input box is definitely idle/focused
    // (the channel prompt acceptance happens in parallel -- give it a beat
    // to finish pressing "1 + Enter" if that's still in flight).
    await new Promise(r => setTimeout(r, 1000));

    const { sendReliable } = await import("../send-reliable.js");
    const result = await sendReliable(tmuxName, message, {
      waitForReady: false,   // we already waited above
      maxRetries: 5,
      retryDelayMs: 1500,
    });

    if (result.ok) {
      deliveryCompleted.add(sessionId);
      try {
        app.events.log(sessionId, "initial_prompt_delivered", {
          actor: "system",
          data: { attempts: result.attempts, length: message.length },
        });
      } catch { /* event log is best-effort */ }
      return { ok: true, message: `delivered in ${result.attempts} attempt(s)` };
    }

    logError("session", `deliver-task ${sessionId}: sendReliable failed after ${result.attempts} attempts: ${result.message}`);
    try {
      app.events.log(sessionId, "initial_prompt_failed", {
        actor: "system",
        data: { attempts: result.attempts, error: result.message },
      });
    } catch { /* event log is best-effort */ }
    return { ok: false, message: result.message };
  } catch (e: any) {
    logError("session", `deliver-task ${sessionId}: unexpected error: ${e?.message ?? e}`);
    return { ok: false, message: e?.message ?? String(e) };
  } finally {
    deliveryInFlight.delete(sessionId);
  }
}

/** Test helper -- reset delivery tracking state between tests. */
export function __resetDeliveryState(): void {
  deliveryInFlight.clear();
  deliveryCompleted.clear();
}
