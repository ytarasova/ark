/**
 * AgentHandle -- the single source of truth for a running agent's lifecycle.
 *
 * Returned by the agent-launching layer (claude-code / cli-agent / goose
 * executor today; compute providers later). Owners of a handle can:
 *
 *   - `waitForExit()` to block until the agent process dies, with the reason
 *   - `onExit(cb)` to subscribe without blocking
 *   - `stop()` to force-kill the agent (idempotent)
 *
 * The registry (packages/core/services/agent-registry.ts) holds one handle
 * per live session. Status-poller is still the single source of truth for
 * exit detection -- it watches the exit-code sentinel + tmux pane liveness
 * and resolves the handle when either fires.
 */
export type AgentExitVia = "sentinel" | "pane-death" | "signal" | "shutdown";

export interface AgentExitInfo {
  code: number;
  reason?: string;
  via: AgentExitVia;
}

export interface AgentHandle {
  readonly sessionId: string;
  readonly tmuxName: string;
  readonly workdir: string;

  /** Resolves when the agent process has exited. Never rejects. */
  waitForExit(): Promise<AgentExitInfo>;

  /** Force-kill the agent + tear down tmux. Idempotent. Resolves after cleanup. */
  stop(): Promise<void>;

  /** Subscribe to exit. Fires at most once per handle. Safe after exit. */
  onExit(cb: (info: AgentExitInfo) => void): void;
}
