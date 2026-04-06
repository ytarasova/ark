/**
 * Notification daemon — watches session status transitions
 * and sends bridge notifications with adaptive polling.
 */

import type { Session } from "../types/index.js";
import { getApp } from "./app.js";
import { listSessions as storeListSessions } from "./store.js";
import { Bridge, loadBridgeConfig } from "./bridge.js";

/** Safe session list — uses AppContext if available, falls back to store. */
function safeListSessions(opts?: { limit?: number }): any[] {
  try { return getApp().sessions.list(opts); }
  catch { return storeListSessions(opts); }
}

export interface NotifyDaemonOptions {
  /** Polling interval when sessions are running (ms). Default: 3000. */
  activeIntervalMs?: number;
  /** Polling interval when sessions are waiting (ms). Default: 10000. */
  waitingIntervalMs?: number;
  /** Polling interval when all idle (ms). Default: 30000. */
  idleIntervalMs?: number;
}

const DEFAULTS: Required<NotifyDaemonOptions> = {
  activeIntervalMs: 3_000,
  waitingIntervalMs: 10_000,
  idleIntervalMs: 30_000,
};

export class NotifyDaemon {
  private bridge: Bridge;
  private opts: Required<NotifyDaemonOptions>;
  private lastStatuses = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(bridge: Bridge, opts?: NotifyDaemonOptions) {
    this.bridge = bridge;
    this.opts = { ...DEFAULTS, ...opts };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      const sessions = safeListSessions({ limit: 200 });
      let hasRunning = false;
      let hasWaiting = false;

      for (const s of sessions) {
        const prev = this.lastStatuses.get(s.id);
        this.lastStatuses.set(s.id, s.status);

        if (s.status === "running") hasRunning = true;
        if (["waiting", "blocked"].includes(s.status)) hasWaiting = true;

        // Notify on meaningful transitions
        if (prev && prev !== s.status) {
          const shouldNotify =
            (prev === "running" && ["waiting", "blocked", "failed", "completed", "stopped"].includes(s.status)) ||
            (s.status === "failed");

          if (shouldNotify) {
            await this.bridge.notifySessionStatus(s, prev, s.status);
          }
        }
      }

      // Clean up stale entries
      const currentIds = new Set(sessions.map(s => s.id));
      for (const id of this.lastStatuses.keys()) {
        if (!currentIds.has(id)) this.lastStatuses.delete(id);
      }

      // Adaptive polling interval
      const interval = hasRunning ? this.opts.activeIntervalMs
        : hasWaiting ? this.opts.waitingIntervalMs
        : this.opts.idleIntervalMs;

      this.timer = setTimeout(() => this.poll(), interval);
    } catch (e: any) {
      console.error("notify-daemon: poll error:", e?.message ?? e);
      this.timer = setTimeout(() => this.poll(), this.opts.idleIntervalMs);
    }
  }
}

/** Create and start a notification daemon. Returns null if no bridge config. */
export function startNotifyDaemon(opts?: NotifyDaemonOptions): NotifyDaemon | null {
  const config = loadBridgeConfig();
  if (!config) return null;
  const bridge = new Bridge(config);
  const daemon = new NotifyDaemon(bridge, opts);
  daemon.start();
  return daemon;
}
