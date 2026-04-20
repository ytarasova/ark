/**
 * TmuxAgentHandle -- concrete AgentHandle backed by a tmux session + the
 * exit-code sentinel file that `buildLauncher` writes.
 *
 * The handle owns a single exit promise. `waitForExit` + `onExit` subscribers
 * all resolve against the same outcome. `stop()` is idempotent: it kills
 * tmux (no-op if already dead) and resolves the exit promise with
 * `via: "signal"` if the natural-exit watcher hasn't fired yet.
 *
 * The natural-exit watcher (poll loop) fires when EITHER:
 *   1. `$tracksDir/$sessionId/exit-code` is written by the launcher, OR
 *   2. `tmux has-session` returns false (pane died, no sentinel).
 *
 * The first wins; later triggers are ignored.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { AgentHandle, AgentExitInfo } from "../../types/agent-handle.js";
import * as tmux from "../infra/tmux.js";
import { logDebug } from "../observability/structured-log.js";

export interface TmuxAgentHandleOpts {
  sessionId: string;
  tmuxName: string;
  workdir: string;
  /** Directory where the launcher writes `exit-code`. Usually `{tracksDir}/{sessionId}`. */
  sessionDir: string;
  /** How often to poll for exit. Defaults to 500ms. */
  pollIntervalMs?: number;
  /** Poll immediately on construction. Defaults to true. */
  autoStart?: boolean;
}

export class TmuxAgentHandle implements AgentHandle {
  readonly sessionId: string;
  readonly tmuxName: string;
  readonly workdir: string;
  private readonly sessionDir: string;
  private readonly pollMs: number;
  private poller: ReturnType<typeof setInterval> | null = null;
  private resolveExit!: (info: AgentExitInfo) => void;
  private readonly exitPromise: Promise<AgentExitInfo>;
  private exited = false;
  private exitListeners: Array<(info: AgentExitInfo) => void> = [];
  private exitedInfo: AgentExitInfo | null = null;

  constructor(opts: TmuxAgentHandleOpts) {
    this.sessionId = opts.sessionId;
    this.tmuxName = opts.tmuxName;
    this.workdir = opts.workdir;
    this.sessionDir = opts.sessionDir;
    this.pollMs = opts.pollIntervalMs ?? 500;

    this.exitPromise = new Promise<AgentExitInfo>((resolve) => {
      this.resolveExit = resolve;
    });

    if (opts.autoStart !== false) {
      this.startWatching();
    }
  }

  /**
   * Start the natural-exit watcher. Exposed so callers that want to wire
   * the handle into the registry before starting the poll can do so in a
   * deterministic order.
   */
  startWatching(): void {
    if (this.poller || this.exited) return;
    this.poller = setInterval(() => {
      this.tick().catch(() => {
        // tick swallows everything; this catch exists for safety.
      });
    }, this.pollMs);
  }

  private async tick(): Promise<void> {
    if (this.exited) return;

    // 1. Exit-code sentinel: authoritative for non-zero exits.
    const sentinelPath = join(this.sessionDir, "exit-code");
    if (existsSync(sentinelPath)) {
      const code = this.readExitCode(sentinelPath);
      this.finalize({ code, via: "sentinel" });
      return;
    }

    // 2. Pane liveness: if the tmux session is gone, the agent exited
    //    cleanly (no sentinel => exit 0, the launcher only writes on
    //    non-zero) OR the process was killed externally. Either way the
    //    tmux pane is dead, so the agent is done.
    const alive = await tmux.sessionExistsAsync(this.tmuxName);
    if (!alive) {
      this.finalize({ code: 0, via: "pane-death" });
    }
  }

  private readExitCode(path: string): number {
    try {
      const raw = readFileSync(path, "utf-8").trim();
      if (!raw) return 0;
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }

  private finalize(info: AgentExitInfo): void {
    if (this.exited) return;
    this.exited = true;
    this.exitedInfo = info;
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
    // Idempotent kill. If the tmux session is already gone, this is a no-op.
    // If it's alive (e.g. we finalised via sentinel but exec-bash-style
    // post-mortem shells are no longer used -- see buildLauncher), kill it
    // so nothing outlives the agent.
    tmux.killSession(this.tmuxName);
    this.resolveExit(info);
    for (const cb of this.exitListeners) {
      try {
        cb(info);
      } catch (e: any) {
        logDebug("agent-handle", `onExit listener threw: ${e?.message ?? e}`);
      }
    }
    this.exitListeners = [];
  }

  waitForExit(): Promise<AgentExitInfo> {
    return this.exitPromise;
  }

  onExit(cb: (info: AgentExitInfo) => void): void {
    if (this.exitedInfo) {
      try {
        cb(this.exitedInfo);
      } catch (e: any) {
        logDebug("agent-handle", `onExit (post-exit) listener threw: ${e?.message ?? e}`);
      }
      return;
    }
    this.exitListeners.push(cb);
  }

  async stop(): Promise<void> {
    if (this.exited) return;
    // Mark as exited first so any concurrent tick() or killSession from
    // finalize is a no-op after we kill the tmux session ourselves.
    this.finalize({ code: 130, via: "signal" });
  }
}
