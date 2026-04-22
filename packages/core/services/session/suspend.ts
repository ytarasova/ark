/**
 * SessionSuspender -- pause, archive, restore, interrupt, waitForCompletion.
 * Extracted from the old session-lifecycle.ts.
 */

import type { Session } from "../../../types/index.js";
import type { SessionLifecycleDeps } from "./types.js";

export class SessionSuspender {
  constructor(private readonly deps: SessionLifecycleDeps) {}

  async pause(sessionId: string, reason?: string): Promise<{ ok: boolean; message: string }> {
    const d = this.deps;
    const session = await d.sessions.get(sessionId);
    if (!session) return { ok: false, message: `Session ${sessionId} not found` };

    await d.sessions.update(sessionId, { status: "blocked", breakpoint_reason: reason ?? "User paused" });
    await d.events.log(sessionId, "session_paused", {
      stage: session.stage,
      actor: "user",
      data: { reason, was_status: session.status },
    });
    return { ok: true, message: "Paused" };
  }

  async archive(sessionId: string): Promise<{ ok: boolean; message: string }> {
    const d = this.deps;
    const session = await d.sessions.get(sessionId);
    if (!session) return { ok: false, message: `Session ${sessionId} not found` };

    if (session.session_id) {
      await d.getLauncher().kill(session.session_id);
    }

    await d.sessions.update(sessionId, { status: "archived", session_id: null });
    await d.events.log(sessionId, "session_archived", {
      stage: session.stage,
      actor: "user",
      data: { from_status: session.status },
    });
    return { ok: true, message: "Session archived" };
  }

  async restore(sessionId: string): Promise<{ ok: boolean; message: string }> {
    const d = this.deps;
    const session = await d.sessions.get(sessionId);
    if (!session) return { ok: false, message: `Session ${sessionId} not found` };
    if (session.status !== "archived") return { ok: false, message: `Session is ${session.status}, not archived` };

    await d.sessions.update(sessionId, { status: "stopped" });
    await d.events.log(sessionId, "session_restored", {
      stage: session.stage,
      actor: "user",
      data: {},
    });
    return { ok: true, message: "Session restored" };
  }

  async interrupt(sessionId: string): Promise<{ ok: boolean; message: string }> {
    const d = this.deps;
    const session = await d.sessions.get(sessionId);
    if (!session) return { ok: false, message: `Session ${sessionId} not found` };
    if (session.status !== "running" && session.status !== "waiting") {
      return { ok: false, message: `Session is ${session.status}, not running` };
    }
    if (!session.session_id) return { ok: false, message: "No tmux session" };

    await d.getLauncher().sendKeys(session.session_id, "C-c");

    await d.sessions.update(sessionId, { status: "waiting" });
    await d.events.log(sessionId, "session_interrupted", {
      stage: session.stage,
      actor: "user",
      data: { session_id: session.session_id },
    });

    return { ok: true, message: "Agent interrupted" };
  }

  /** Wait for a session to reach a terminal state. Returns the final session. */
  async waitForCompletion(
    sessionId: string,
    opts?: { timeoutMs?: number; pollMs?: number; onStatus?: (status: string) => void },
  ): Promise<{ session: Session | null; timedOut: boolean }> {
    const d = this.deps;
    const timeout = opts?.timeoutMs ?? 0;
    const pollMs = opts?.pollMs ?? 3000;
    const start = Date.now();

    while (true) {
      const session = await d.sessions.get(sessionId);
      if (!session) return { session: null, timedOut: false };

      const terminal = ["completed", "failed", "stopped"].includes(session.status);
      if (terminal) return { session, timedOut: false };

      opts?.onStatus?.(session.status);

      if (timeout > 0 && Date.now() - start > timeout) {
        return { session, timedOut: true };
      }

      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}
