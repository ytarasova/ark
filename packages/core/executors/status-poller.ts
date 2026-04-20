/**
 * Status poller for non-Claude executors.
 *
 * Claude Code reports status via HTTP hooks. Other CLI tools don't.
 * This poller checks tmux session existence periodically and updates
 * session status when the process exits.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { AppContext } from "../app.js";
import { getExecutor } from "../executor.js";
import { logDebug, logInfo } from "../observability/structured-log.js";

/**
 * Read the exit-code sentinel for a session, if the launcher wrote one.
 * Returns the parsed non-zero exit code, or `null` when no sentinel is
 * present / the file is empty / the code is 0.
 *
 * The launcher (see claude.ts:buildLauncher) writes `$ARK_SESSION_DIR/exit-code`
 * when the agent exits non-zero. We treat this as the authoritative signal
 * that the session failed, even if tmux's `exec bash` keeps the pane alive.
 */
export function readExitCodeSentinel(tracksDir: string, sessionId: string): number | null {
  const path = join(tracksDir, sessionId, "exit-code");
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8").trim();
    if (!raw) return null;
    const code = Number.parseInt(raw, 10);
    if (!Number.isFinite(code) || code === 0) return null;
    return code;
  } catch {
    return null;
  }
}

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

      // Exit-code sentinel: the launcher writes $ARK_SESSION_DIR/exit-code
      // when the agent process exits non-zero. `exec bash` keeps the tmux
      // pane alive for post-mortem inspection, so executor.status() still
      // reports "running" -- we need this side-channel to flip the Ark
      // session to "failed". Bug 3 in the session-dispatch cascade.
      const exitCode = readExitCodeSentinel(app.config.tracksDir, sessionId);
      if (exitCode !== null) {
        stopStatusPoller(sessionId);

        const session = app.sessions.get(sessionId);
        if (!session || session.status !== "running") return;

        // Tail the stderr/log for a helpful reason, best-effort.
        let tail = "";
        try {
          const stderrPath = join(app.config.tracksDir, sessionId, "stderr.log");
          if (existsSync(stderrPath)) {
            tail = readFileSync(stderrPath, "utf-8").split("\n").slice(-20).join("\n").trim();
          }
        } catch {
          logDebug("status", "stderr tail best-effort");
        }

        const reason = tail ? `Claude exited with code ${exitCode}\n${tail}` : `Claude exited with code ${exitCode}`;
        app.sessions.update(sessionId, {
          status: "failed",
          error: reason,
          session_id: null,
        });

        app.events.log(sessionId, "session_failed", {
          stage: session.stage,
          actor: "system",
          data: { reason: "agent exit-code sentinel", exitCode },
        });

        logInfo("session", `status-poller: ${sessionId} -> failed (exit code ${exitCode})`);
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
          logDebug("status", "best-effort");
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
            logInfo("status", "advance may fail if flow is done");
          }
        }

        // Send OS notification
        try {
          const { sendOSNotification } = await import("../notify.js");
          const title = newStatus === "completed" ? "Agent completed" : "Agent failed";
          await sendOSNotification(`Ark: ${title}`, session.summary ?? sessionId);
        } catch {
          logDebug("status", "best-effort");
        }
      }
    } catch {
      logDebug("status", "ignore polling errors");
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
