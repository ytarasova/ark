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
import type { Executor, ExecutorStatus } from "../executor.js";
import { getExecutor } from "../executor.js";
import { logDebug, logInfo, logWarn } from "../observability/structured-log.js";
import { resolveProvider } from "../compute-resolver.js";

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

/**
 * Registry of active status-poll intervals, keyed by sessionId. One instance
 * per AppContext -- disposed on `shutdown()` so per-test / per-replica
 * cleanup doesn't leave intervals leaking against a stale executor registry.
 *
 * The previous module-level `activePollers` Map survived AppContext teardown,
 * which in parallel test execution meant one test's pollers could tick against
 * another's AppContext (usually harmless, but a latent cross-test leak).
 */
export class StatusPollerRegistry {
  private readonly intervals = new Map<string, ReturnType<typeof setInterval>>();

  has(sessionId: string): boolean {
    return this.intervals.has(sessionId);
  }

  set(sessionId: string, interval: ReturnType<typeof setInterval>): void {
    this.intervals.set(sessionId, interval);
  }

  stop(sessionId: string): void {
    const interval = this.intervals.get(sessionId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(sessionId);
    }
  }

  stopAll(): void {
    this.intervals.forEach((interval) => clearInterval(interval));
    this.intervals.clear();
  }

  /** Awilix disposer -- called on container.dispose(). */
  dispose(): void {
    this.stopAll();
  }
}

/**
 * Probe whether the agent's tmux session is still live.
 *
 * The naive `executor.status(handle)` only queries the conductor's local
 * tmux daemon, which is wrong for remote dispatches: the tmux session
 * lives on EC2 / k8s / Firecracker, not on the conductor. Local probe
 * always returns `not_found` for remote handles, and the poller flips
 * the session to `completed` ~3s after launch even though the agent is
 * happily running on the remote host.
 *
 * Fix: prefer the compute provider's `checkSession`, which is implemented
 * by `ArkdBackedProvider` in terms of arkd's `/agent/status` endpoint.
 * For remote dispatches that endpoint is reached over the SSM forward
 * tunnel and probes tmux on the remote host. For local dispatches it
 * probes the local arkd which already shares its tmux daemon with the
 * conductor, so the answer matches what `executor.status` would have
 * returned. Falls back to `executor.status` only when there is no
 * provider/compute on the session (e.g. dispatch without compute_name).
 *
 * Transient probe failures (arkd unreachable, network timeout) keep the
 * status as `running` rather than tripping a false `not_found` -- a
 * single failed probe must not flip a healthy session to completed.
 */
async function probeSessionStatus(
  app: AppContext,
  sessionId: string,
  handle: string,
  executor: Executor,
): Promise<ExecutorStatus> {
  const session = await app.sessions.get(sessionId);
  if (session?.compute_name) {
    try {
      const { provider, compute } = await resolveProvider(app, session);
      if (provider && compute) {
        // Pass the session through so the provider reads
        // session.config.arkd_local_forward_port (#423) instead of the
        // shared compute-level field.
        const running = await provider.checkSession(compute, handle, session);
        return running ? { state: "running" } : { state: "not_found" };
      }
    } catch (err: any) {
      logWarn("status", `provider.checkSession failed for ${sessionId}: ${err?.message ?? err}; keeping running`);
      return { state: "running" };
    }
  }
  return executor.status(handle);
}

export function startStatusPoller(app: AppContext, sessionId: string, handle: string, executorName: string): void {
  const pollers = app.statusPollers;
  // Don't double-poll
  if (pollers.has(sessionId)) return;

  let tick = 0;
  const interval = setInterval(async () => {
    tick++;
    try {
      const executor = app.pluginRegistry.executor(executorName) ?? getExecutor(executorName);
      if (!executor) {
        stopStatusPoller(app, sessionId);
        return;
      }

      // Exit-code sentinel: the launcher writes $ARK_SESSION_DIR/exit-code
      // when the agent process exits non-zero. `exec bash` keeps the tmux
      // pane alive for post-mortem inspection, so executor.status() still
      // reports "running" -- we need this side-channel to flip the Ark
      // session to "failed". Bug 3 in the session-dispatch cascade.
      const exitCode = readExitCodeSentinel(app.config.dirs.tracks, sessionId);
      if (exitCode !== null) {
        stopStatusPoller(app, sessionId);

        const session = await app.sessions.get(sessionId);
        if (!session || session.status !== "running") return;

        // Tail the stderr/log for a helpful reason, best-effort.
        let tail = "";
        try {
          const stderrPath = join(app.config.dirs.tracks, sessionId, "stderr.log");
          if (existsSync(stderrPath)) {
            tail = readFileSync(stderrPath, "utf-8").split("\n").slice(-20).join("\n").trim();
          }
        } catch {
          logDebug("status", "stderr tail best-effort");
        }

        const reason = tail ? `Claude exited with code ${exitCode}\n${tail}` : `Claude exited with code ${exitCode}`;
        await app.sessions.update(sessionId, {
          status: "failed",
          error: reason,
          session_id: null,
        });

        await app.events.log(sessionId, "session_failed", {
          stage: session.stage,
          actor: "system",
          data: { reason: "agent exit-code sentinel", exitCode },
        });

        logInfo("session", `status-poller: ${sessionId} -> failed (exit code ${exitCode})`);
        return;
      }

      const status = await probeSessionStatus(app, sessionId, handle, executor);

      // Every 5th tick (~15s), snapshot the process tree for observability
      if (tick % 5 === 0 && status.state === "running") {
        try {
          const { snapshotSessionTree } = await import("./process-tree.js");
          const tree = await snapshotSessionTree(handle);
          if (tree) {
            await app.sessions.mergeConfig(sessionId, { process_tree: tree });
          }
        } catch {
          logDebug("status", "best-effort");
        }
      }

      if (status.state === "completed" || status.state === "failed" || status.state === "not_found") {
        stopStatusPoller(app, sessionId);

        const session = await app.sessions.get(sessionId);
        if (!session || session.status !== "running") return;

        // Guard: verify the session's current tmux handle still matches the one
        // we are polling. After a stage handoff, the session gets a new agent
        // with a different handle. If they don't match, this poller is stale.
        if (session.session_id && session.session_id !== handle) return;

        // "not_found" means the tmux session exited (process finished) -- treat as completed
        const newStatus = status.state === "failed" ? "failed" : "completed";
        const error = status.state === "failed" ? (status as { error?: string }).error : null;

        await app.sessions.update(sessionId, {
          status: newStatus,
          error: error ?? null,
          session_id: null,
        });

        await app.events.log(sessionId, `session_${newStatus}`, {
          stage: session.stage,
          actor: "system",
          data: { reason: "agent process exited", exitCode: (status as { exitCode?: number }).exitCode },
        });

        logInfo("session", `status-poller: ${sessionId} -> ${newStatus}`);

        // Advance flow for multi-stage pipelines (same as Claude hook path).
        // Use mediateStageHandoff instead of raw advance() so auto-dispatch fires.
        if (newStatus === "completed") {
          // Clear error before advancing so auto-gate doesn't reject
          await app.sessions.update(sessionId, { status: "ready", error: null });
          try {
            await app.sessionHooks.mediateStageHandoff(sessionId, {
              autoDispatch: true,
              source: "status_poller",
            });
          } catch (err: any) {
            // advance may fail if flow is done
            logWarn("status", `mediateStageHandoff failed for ${sessionId}: ${err?.message ?? err}`);
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
    } catch (err: any) {
      // Don't crash the poller; surface the error in structured log.
      logWarn("status", `polling tick failed: ${err?.message ?? err}`);
    }
  }, 3000); // Check every 3 seconds

  pollers.set(sessionId, interval);
}

export function stopStatusPoller(app: AppContext, sessionId: string): void {
  app.statusPollers.stop(sessionId);
}

export function stopAllPollers(app: AppContext): void {
  app.statusPollers.stopAll();
}
