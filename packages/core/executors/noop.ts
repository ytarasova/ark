/**
 * No-op executor for tests.
 *
 * Replaces every real executor (claude-code / agent-sdk / goose / codex /
 * gemini / cli-agent / subprocess) with a stub that never spawns tmux or a
 * real agent binary. `launch()` returns a synthetic handle immediately,
 * `status()` reports completed, `kill` / `send` / `capture` are no-ops.
 *
 * Installed by `AppContext.forTestAsync()` via the per-AppContext
 * PluginRegistry. `resolveExecutor` checks the registry before the global
 * fallback, so the real executors are never reached during tests. Without
 * this, any test that dispatches a session (the `completion-paths` HTTP
 * hook tests, the for_each spawn tests, etc.) would shell out to the real
 * `claude` binary and leak tmux sessions.
 */

import type { Executor } from "../executor.js";

export const noopExecutor: Executor = {
  name: "noop",
  async launch(opts) {
    return {
      ok: true,
      handle: `noop-${opts.sessionId}`,
      claudeSessionId: `noop-${opts.sessionId}`,
      pid: 0,
    };
  },
  async kill() {},
  async terminate() {},
  async status() {
    // Tests that `await dispatch(...)` and then poll status expect eventual
    // completion. Return `completed` so status pollers terminate cleanly
    // and tests don't hang waiting for a real agent.
    return { state: "completed" as const, exitCode: 0 };
  },
  async send() {},
  async capture() {
    return "";
  },
};

/** Names the test-mode registry must override with the noop stub. */
export const NOOP_EXECUTOR_NAMES = ["claude-code", "agent-sdk", "goose", "cli-agent", "subprocess"] as const;
