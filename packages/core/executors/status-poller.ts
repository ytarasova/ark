/**
 * Status poller for non-Claude executors.
 *
 * Claude Code reports status via HTTP hooks. Other CLI tools don't.
 * This poller checks tmux session existence periodically and updates
 * session status when the process exits.
 */

import { getApp } from "../app.js";
import { getExecutor } from "../executor.js";
import { logInfo } from "../structured-log.js";

const activePollers = new Map<string, ReturnType<typeof setInterval>>();

export function startStatusPoller(sessionId: string, handle: string, executorName: string): void {
  // Don't double-poll
  if (activePollers.has(sessionId)) return;

  const interval = setInterval(async () => {
    try {
      const executor = getExecutor(executorName);
      if (!executor) { stopStatusPoller(sessionId); return; }

      const status = await executor.status(handle);

      if (status.state === "completed" || status.state === "failed") {
        stopStatusPoller(sessionId);

        const session = getApp().sessions.get(sessionId);
        if (!session || session.status !== "running") return;

        const newStatus = status.state === "completed" ? "completed" : "failed";
        const error = status.state === "failed" ? (status as { error?: string }).error : null;

        getApp().sessions.update(sessionId, {
          status: newStatus,
          error: error ?? null,
          session_id: null,
        });

        getApp().events.log(sessionId, `session_${newStatus}`, {
          stage: session.stage, actor: "system",
          data: { reason: "agent process exited", exitCode: (status as { exitCode?: number }).exitCode },
        });

        logInfo("status-poller" as any, `${sessionId} -> ${newStatus}`);

        // Send OS notification
        try {
          const { sendOSNotification } = await import("../notify.js");
          const title = newStatus === "completed" ? "Agent completed" : "Agent failed";
          sendOSNotification(`Ark: ${title}`, session.summary ?? sessionId);
        } catch { /* best-effort */ }
      }
    } catch { /* ignore polling errors */ }
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
