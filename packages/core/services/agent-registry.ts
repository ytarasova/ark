/**
 * AgentRegistry -- the process-wide map of live AgentHandles, keyed by
 * session id.
 *
 * Populated the moment an agent is launched (executor/agent-launcher).
 * Depopulated when the handle's `onExit` fires OR its `stop()` resolves.
 *
 * `AppContext.shutdown()` iterates every live handle and calls `stop()` on
 * each; that's how we guarantee tmux sessions never outlive a test process.
 * The registry is the anti-regression net against the original bug
 * (142 orphaned tmux sessions per test run).
 */

import type { AgentHandle, AgentExitInfo } from "../../types/agent-handle.js";
import { logDebug } from "../observability/structured-log.js";

export class AgentRegistry {
  private handles = new Map<string, AgentHandle>();

  /** Register a live handle. Wires up removal on exit. */
  register(handle: AgentHandle): void {
    // If a previous handle exists for this session (e.g. stage handoff,
    // rework cycle), stop it first -- tmux name may differ, we don't want
    // a leak. Swallow errors; stop() is best-effort.
    const prev = this.handles.get(handle.sessionId);
    if (prev && prev !== handle) {
      prev.stop().catch(() => {});
    }
    this.handles.set(handle.sessionId, handle);
    handle.onExit(() => {
      // Only remove if the entry is still this handle -- avoid clobbering
      // a replacement that landed during the exit race.
      if (this.handles.get(handle.sessionId) === handle) {
        this.handles.delete(handle.sessionId);
      }
    });
  }

  /** Remove a handle without stopping it. Caller has already stopped it. */
  deregister(sessionId: string): void {
    this.handles.delete(sessionId);
  }

  /** Look up a handle by session id. Null if no live agent. */
  get(sessionId: string): AgentHandle | null {
    return this.handles.get(sessionId) ?? null;
  }

  /** Number of live handles. */
  size(): number {
    return this.handles.size;
  }

  /** List live session ids. */
  sessionIds(): string[] {
    return [...this.handles.keys()];
  }

  /** Stop every live handle in parallel. Used by AppContext.shutdown(). */
  async stopAll(): Promise<AgentExitInfo[]> {
    const handles = [...this.handles.values()];
    if (handles.length === 0) return [];
    logDebug("agent-registry", `stopAll: draining ${handles.length} live handles`);
    const results = await Promise.all(
      handles.map(async (h) => {
        try {
          await h.stop();
        } catch {
          // stop() is idempotent and swallows its own errors; just in case
        }
        return { code: 0, via: "shutdown" as const };
      }),
    );
    // Defensive: clear map even if onExit callbacks were slow.
    this.handles.clear();
    return results;
  }
}
