/**
 * MaintenancePollers -- recurring maintenance tasks that run for the
 * lifetime of the AppContext.
 *
 * Currently owns:
 *   - purge of expired soft-deleted sessions (every 30s)
 *   - tmux status bar refresh (every 5s)
 *   - notify daemon handle (long-lived process)
 *   - fire-and-forget log cleanup pass on boot
 */
import type { AppContext } from "../app.js";
import { updateTmuxStatusBar, clearTmuxStatusBar } from "./tmux-notify.js";
import { startNotifyDaemon } from "./notify-daemon.js";
import { safeAsync } from "../safe.js";
import { logDebug } from "../observability/structured-log.js";

export class MaintenancePollers {
  private purgeInterval: ReturnType<typeof setInterval> | null = null;
  private tmuxStatusInterval: ReturnType<typeof setInterval> | null = null;
  private notifyDaemon: { stop(): void } | null = null;

  constructor(private readonly app: AppContext) {}

  start(): void {
    // Purge expired soft-deletes every 30s
    this.purgeInterval = setInterval(() => {
      try {
        const deleted = this.app.sessions.listDeleted();
        const cutoff = Date.now() - 90 * 1000;
        for (const s of deleted) {
          const deletedAt = s.config?._deleted_at as string | undefined;
          if (deletedAt && new Date(deletedAt).getTime() < cutoff) {
            this.app.sessions.delete(s.id);
          }
        }
      } catch {
        logDebug("general", "container may be disposed during shutdown");
      }
    }, 30_000);

    // tmux status bar every 5s
    this.tmuxStatusInterval = setInterval(() => {
      updateTmuxStatusBar(this.app);
    }, 5_000);

    this.notifyDaemon = startNotifyDaemon(this.app);

    // Log cleanup is fire-and-forget
    safeAsync("boot: cleanup logs", async () => {
      const { cleanupLogs } = await import("../observability/log-manager.js");
      cleanupLogs(this.app);
    });
  }

  stop(): void {
    if (this.notifyDaemon) {
      this.notifyDaemon.stop();
      this.notifyDaemon = null;
    }
    if (this.tmuxStatusInterval) {
      clearInterval(this.tmuxStatusInterval);
      this.tmuxStatusInterval = null;
    }
    clearTmuxStatusBar();
    if (this.purgeInterval) {
      clearInterval(this.purgeInterval);
      this.purgeInterval = null;
    }
  }
}
