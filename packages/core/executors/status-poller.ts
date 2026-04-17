/**
 * Status poller for non-Claude executors.
 *
 * Claude Code reports status via HTTP hooks. Other CLI tools don't.
 * This poller checks tmux session existence periodically and updates
 * session status when the process exits.
 */

import type { AppContext } from "../app.js";
import { getExecutor } from "../executor.js";
import { logInfo } from "../observability/structured-log.js";

const activePollers = new Map<string, ReturnType<typeof setInterval>>();

export function startStatusPoller(app: AppContext, sessionId: string, handle: string, executorName: string): void {
  // Don't double-poll
  if (activePollers.has(sessionId)) return;

  let tick = 0;
  const interval = setInterval(async () => {
    tick++;
    try {
      const executor = app.pluginRegistry.executor(executorName) ?? getExecutor(executorName);
      if (!executor) {
        stopStatusPoller(sessionId);
        return;
      }

      const status = await executor.status(handle);

      // Every 5th tick (~15s), snapshot the process tree for observability
      if (tick % 5 === 0 && status.state === "running") {
        try {
          const { snapshotSessionTree } = await import("./process-tree.js");
          const tree = await snapshotSessionTree(handle);
          if (tree) {
            app.sessions.mergeConfig(sessionId, { process_tree: tree });
          }
        } catch {
          /* best-effort */
        }
      }

      if (status.state === "completed" || status.state === "failed" || status.state === "not_found") {
        stopStatusPoller(sessionId);

        const session = app.sessions.get(sessionId);
        if (!session || session.status !== "running") return;

        // Guard: verify the session's current tmux handle still matches the one
        // we are polling. After a stage handoff, the session gets a new agent
        // with a different handle. If they don't match, this poller is stale.
        if (session.session_id && session.session_id !== handle) return;

        // "not_found" means the tmux session exited (process finished) -- treat as completed
        const newStatus = status.state === "failed" ? "failed" : "completed";
        const error = status.state === "failed" ? (status as { error?: string }).error : null;

        app.sessions.update(sessionId, {
          status: newStatus,
          error: error ?? null,
          session_id: null,
        });

        app.events.log(sessionId, `session_${newStatus}`, {
          stage: session.stage,
          actor: "system",
          data: { reason: "agent process exited", exitCode: (status as { exitCode?: number }).exitCode },
        });

        logInfo("session", `status-poller: ${sessionId} -> ${newStatus}`);

        // Advance flow for multi-stage pipelines (same as Claude hook path).
        // Use mediateStageHandoff instead of raw advance() so auto-dispatch fires.
        if (newStatus === "completed") {
          // Clear error before advancing so auto-gate doesn't reject
          app.sessions.update(sessionId, { status: "ready", error: null });
          try {
            const { mediateStageHandoff } = await import("../services/session-orchestration.js");
            await mediateStageHandoff(app, sessionId, {
              autoDispatch: true,
              source: "status_poller",
            });
          } catch {
            /* advance may fail if flow is done */
          }
        }

        // Send OS notification
        try {
          const { sendOSNotification } = await import("../notify.js");
          const title = newStatus === "completed" ? "Agent completed" : "Agent failed";
          await sendOSNotification(`Ark: ${title}`, session.summary ?? sessionId);
        } catch {
          /* best-effort */
        }
      }
    } catch {
      /* ignore polling errors */
    }
  }, 3000); // Check every 3 seconds

  activePollers.set(sessionId, interval);
}

export function stopStatusPoller(sessionId: string): void {
  const interval = activePollers.get(sessionId);
  if (interval) {
    clearInterval(interval);
    activePollers.delete(sessionId);
  }
}

export function stopAllPollers(): void {
  activePollers.forEach((interval) => {
    clearInterval(interval);
  });
  activePollers.clear();
}
