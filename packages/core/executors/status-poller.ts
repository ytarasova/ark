/**
 * Status poller for non-Claude executors.
 *
 * Claude Code reports status via HTTP hooks. Other CLI tools don't.
 * This poller checks tmux session existence periodically and updates
 * session status when the process exits.
 *
 * For stream-json runtimes (goose), the poller also parses tmux output
 * and extracts assistant messages into the chat UI. These runtimes get
 * `remain-on-exit on` so the tmux pane survives after the process exits,
 * allowing a final capture of all output before we clean up the session.
 */

import type { AppContext } from "../app.js";
import { getExecutor } from "../executor.js";
import * as tmux from "../infra/tmux.js";
import { logInfo } from "../observability/structured-log.js";
import { parseStreamJsonOutput, clearStreamJsonCursor } from "./stream-json-parser.js";

// Runtimes whose stdout is stream-json and should be parsed into chat messages.
const STREAM_JSON_RUNTIMES = new Set(["goose"]);

const activePollers = new Map<string, ReturnType<typeof setInterval>>();

export function startStatusPoller(app: AppContext, sessionId: string, handle: string, executorName: string): void {
  // Don't double-poll
  if (activePollers.has(sessionId)) return;

  const parseChat = STREAM_JSON_RUNTIMES.has(executorName);

  // For stream-json runtimes, keep the tmux pane alive after the process exits
  // so we can capture all output in the final parse. Without this, the tmux
  // session is destroyed when goose exits, and capturePaneAsync returns "".
  if (parseChat) {
    tmux.setOptionAsync(handle, "remain-on-exit", "on").catch(() => {});
  }

  // Track whether the process has exited (pane is dead but session remains due to remain-on-exit).
  // Using an object so the closure can mutate it without reassigning.
  const exitState = { exited: false };

  let tick = 0;
  const interval = setInterval(async () => {
    tick++;
    try {
      const executor = app.pluginRegistry.executor(executorName) ?? getExecutor(executorName);
      if (!executor) {
        stopStatusPoller(sessionId);
        return;
      }

      // For stream-json runtimes with remain-on-exit, check if the pane is dead
      // by looking at the pane's dead flag rather than session existence.
      let isDead = false;
      if (parseChat && !exitState.exited) {
        try {
          isDead = await isPaneDead(handle);
        } catch {
          /* ignore */
        }
      }

      const status = exitState.exited || isDead ? { state: "not_found" as const } : await executor.status(handle);

      // Parse stream-json output into chat messages while the session runs
      if (parseChat && (status.state === "running" || isDead)) {
        try {
          await parseStreamJsonOutput(app, sessionId, handle);
        } catch {
          /* best-effort */
        }
      }

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

      if (isDead || status.state === "completed" || status.state === "failed" || status.state === "not_found") {
        // Final parse to catch any remaining output
        if (parseChat) {
          try {
            await parseStreamJsonOutput(app, sessionId, handle);
          } catch {
            /* best-effort */
          }
          clearStreamJsonCursor(sessionId);

          // Now kill the tmux session (it was kept alive by remain-on-exit)
          tmux.killSessionAsync(handle).catch(() => {});
        }

        stopStatusPoller(sessionId);

        const session = app.sessions.get(sessionId);
        if (!session || session.status !== "running") return;

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

        // Advance flow for multi-stage pipelines (same as Claude hook path)
        if (newStatus === "completed") {
          try {
            const { advance } = await import("../services/session-orchestration.js");
            await advance(app, sessionId);
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

/**
 * Check if a tmux pane is dead (process exited but pane kept by remain-on-exit).
 * Returns true when the pane exists but the process has exited.
 */
async function isPaneDead(handle: string): Promise<boolean> {
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(tmux.tmuxBin(), ["list-panes", "-t", handle, "-F", "#{pane_dead}"], {
      encoding: "utf-8",
    });
    return stdout.trim() === "1";
  } catch {
    return false;
  }
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
