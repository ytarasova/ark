# Plan: Process Tree Tracking When an Executor Launches an Agent

## Summary

When Ark dispatches an agent via any executor, the system currently records only the tmux session handle (`session_id`) but has no knowledge of the actual OS processes spawned -- their PIDs, parent-child relationships, CPU/memory usage, or whether child processes (MCP servers, tools) survive after the agent exits. This feature adds process-tree recording at launch time and periodic snapshotting so Ark can: (1) diagnose hung/leaked processes, (2) show per-session resource usage in TUI/web, and (3) perform targeted cleanup on stop instead of blunt `tmux kill-session`.

## Files to modify/create

| File | Change |
|------|--------|
| `packages/core/executor.ts` | Add `ProcessInfo` interface for typed process tree snapshots |
| `packages/core/executors/process-tree.ts` | **New** -- utilities to discover process tree from a tmux handle or PID (`getProcessTree`, `killProcessTree`) |
| `packages/core/executors/claude-code.ts` | After tmux launch (~line 126), capture root PID and return it in `LaunchResult.pid` |
| `packages/core/executors/cli-agent.ts` | After tmux launch (~line 104), capture root PID and return it in `LaunchResult.pid` |
| `packages/core/executors/goose.ts` | After tmux launch (~line 179), capture root PID and return it in `LaunchResult.pid` |
| `packages/core/executors/subprocess.ts` | Return `proc.pid` in `LaunchResult` (~line 88) |
| `packages/core/executors/status-poller.ts` | Add process tree snapshot on every 5th tick (~15s) |
| `packages/core/services/session-orchestration.ts` | Persist `LaunchResult.pid` into session config at dispatch (~line 527); use tree-kill in `stop()` (~line 752) |
| `packages/core/infra/tmux.ts` | Add `getPanePidAsync(name)` helper function |
| `packages/types/session.ts` | Document new optional config fields (`launch_pid`, `process_tree`) |
| `packages/compute/providers/local/metrics.ts` | Refactor inline pgrep/ps logic (lines 136-183) to use shared `process-tree.ts` |
| `packages/core/__tests__/process-tree.test.ts` | **New** -- unit tests for process tree discovery and cleanup |

## Implementation steps

### Step 1: Add `ProcessInfo` type and `getPanePidAsync` helper

**File: `packages/core/executor.ts`** -- Add after line 56 (after `ExecutorStatus`):

```ts
export interface ProcessInfo {
  rootPid: number;
  children: Array<{
    pid: number;
    ppid: number;
    command: string;
    cpu?: number;
    mem?: number;
  }>;
  capturedAt: string;
}
```

`LaunchResult` already has `pid?: number` (line 47). No change needed -- just ensure executors populate it.

**File: `packages/core/infra/tmux.ts`** -- Add new async function:

```ts
export async function getPanePidAsync(name: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(tmuxBin(),
      ["list-panes", "-t", name, "-F", "#{pane_pid}"],
      { encoding: "utf-8" });
    const pid = parseInt(stdout.trim().split("\n")[0], 10);
    return isNaN(pid) ? null : pid;
  } catch { return null; }
}
```

### Step 2: Create process tree discovery module

**New file: `packages/core/executors/process-tree.ts`**

Three functions:

1. **`getProcessTree(rootPid: number): Promise<ProcessInfo>`**
   - Call `pgrep -P <pid>` recursively (max depth 4 to avoid runaway traversal)
   - Collect all descendant PIDs
   - Run `ps -p <all-pids> -o pid=,ppid=,pcpu=,pmem=,args=` in a single call
   - Parse output into `ProcessInfo.children` array
   - Set `capturedAt` to current ISO timestamp
   - Handle macOS vs Linux `ps` flag differences (both support `-o pid=,...` format)

2. **`killProcessTree(rootPid: number): Promise<void>`**
   - Discover full tree via `getProcessTree(rootPid)`
   - Sort children deepest-first (leaves before parents)
   - Send SIGTERM to each, wait 2 seconds, SIGKILL survivors
   - Swallow ESRCH errors (process already dead)
   - Finally kill root PID

3. **`snapshotSessionTree(tmuxHandle: string): Promise<ProcessInfo | null>`**
   - Convenience wrapper: calls `getPanePidAsync(handle)` then `getProcessTree(pid)`
   - Returns null if tmux session doesn't exist or has no pane PID

This module replaces the ad-hoc process walking in:
- `packages/compute/providers/local/metrics.ts` lines 136-183 (inline `pgrep -P` + `ps` in `getTmuxSessions()`)
- `packages/arkd/server.ts` line 646 (same pattern)
- `packages/core/__tests__/test-helpers.ts` lines 52-57 (test cleanup)

### Step 3: Update tmux-based executors to capture PID

**File: `packages/core/executors/claude-code.ts`** -- After line 126 (`tmux.createSessionAsync`):

```ts
const rootPid = await tmux.getPanePidAsync(tmuxName);
// ... existing code (autoAcceptChannelPrompt, update session) ...
return { ok: true, handle: tmuxName, pid: rootPid ?? undefined, claudeSessionId };
```

**File: `packages/core/executors/cli-agent.ts`** -- After line 104 (`tmux.createSessionAsync`):

```ts
const rootPid = await tmux.getPanePidAsync(tmuxName);
return { ok: true, handle: tmuxName, pid: rootPid ?? undefined };
```

**File: `packages/core/executors/goose.ts`** -- After line 179 (`tmux.createSessionAsync`):

```ts
const rootPid = await tmux.getPanePidAsync(tmuxName);
return { ok: true, handle: tmuxName, pid: rootPid ?? undefined };
```

**File: `packages/core/executors/subprocess.ts`** -- Line 88:

```ts
return { ok: true, handle, pid: proc.pid };
```

### Step 4: Persist PID in session config on dispatch

**File: `packages/core/services/session-orchestration.ts`** -- After line 514 (after `launchResult.ok` check), before the session update on line 527:

```ts
// Persist launch PID for process-tree tracking
if (launchResult.pid) {
  app.sessions.mergeConfig(sessionId, {
    launch_pid: launchResult.pid,
    launch_executor: runtime,
    launched_at: new Date().toISOString(),
  });
}
```

Then the existing `app.sessions.update(sessionId, { status: "running", ... })` proceeds normally.

### Step 5: Periodic process tree snapshots in status poller

**File: `packages/core/executors/status-poller.ts`** -- Restructure the `setInterval` callback:

```ts
let tick = 0;
const interval = setInterval(async () => {
  tick++;
  try {
    // ... existing status check logic (lines 21-56, unchanged) ...

    // Every 5th tick (~15s), snapshot the process tree for observability
    if (tick % 5 === 0 && status.state === "running") {
      try {
        const { snapshotSessionTree } = await import("./process-tree.js");
        const tree = await snapshotSessionTree(handle);
        if (tree) {
          app.sessions.mergeConfig(sessionId, { process_tree: tree });
        }
      } catch { /* best-effort */ }
    }
  } catch { /* ignore polling errors */ }
}, 3000);
```

### Step 6: Use tree-kill on session stop

**File: `packages/core/services/session-orchestration.ts`** -- In `stop()` at ~line 752, before the provider kill:

```ts
// Attempt graceful tree-kill before blunt tmux/provider kill
const launchPid = session.config?.launch_pid as number | undefined;
if (launchPid) {
  try {
    const { killProcessTree } = await import("../executors/process-tree.js");
    await killProcessTree(launchPid);
  } catch { /* fall through to tmux kill */ }
}
```

The existing `withProvider()` kill and tmux `killSession` fallback remain as safety nets.

### Step 7: Refactor local metrics to use shared module

**File: `packages/compute/providers/local/metrics.ts`** -- Replace lines 136-183 in `getTmuxSessions()`:

Replace the inline `pgrep -P` / `ps -p` logic with:

```ts
import { getProcessTree } from "../../../core/executors/process-tree.js";

// Inside getTmuxSessions(), after getting panePid:
if (panePid) {
  const firstPid = parseInt(panePid.split("\n")[0].trim(), 10);
  if (!isNaN(firstPid)) {
    const tree = await getProcessTree(firstPid);
    // Find the claude/agent process in the tree
    const agentProc = tree.children.find(c => c.command.toLowerCase().includes("claude"));
    if (agentProc) {
      cpu = agentProc.cpu ?? 0;
      mem = agentProc.mem ?? 0;
      mode = agentProc.command.includes("dangerously") ? "development" : "normal";
    }
    // ... rest of projectPath logic stays the same
  }
}
```

### Step 8: Document new SessionConfig fields

**File: `packages/types/session.ts`** -- Add JSDoc comments to the `SessionConfig` interface (lines 11-33). These are extensible fields via `[key: string]: unknown`, so no structural change -- just documentation:

```ts
// Add above the [key: string]: unknown line:
/** PID of the root process in the agent's tmux pane (set at dispatch). */
// launch_pid?: number;
/** Name of the executor that launched the agent (e.g. "claude-code", "goose"). */
// launch_executor?: string;
/** ISO timestamp when the agent process was launched. */
// launched_at?: string;
/** Latest process tree snapshot (updated every ~15s by status poller). */
// process_tree?: ProcessInfo;
```

These are comments-only since `SessionConfig` already has `[key: string]: unknown`.

### Step 9: Write tests

**New file: `packages/core/__tests__/process-tree.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { getProcessTree, killProcessTree, snapshotSessionTree } from "../executors/process-tree.js";

describe("process-tree", () => {
  it("discovers children of the current process", async () => {
    // The bun test runner itself has child threads/processes
    const tree = await getProcessTree(process.pid);
    expect(tree.rootPid).toBe(process.pid);
    expect(tree.capturedAt).toBeTruthy();
  });

  it("returns empty children for non-existent PID", async () => {
    const tree = await getProcessTree(999999);
    expect(tree.children).toEqual([]);
  });

  it("kills a spawned child process", async () => {
    const child = Bun.spawn(["sleep", "60"], { stdio: ["ignore", "ignore", "ignore"] });
    const childPid = child.pid;
    expect(childPid).toBeGreaterThan(0);

    await killProcessTree(childPid);

    // Verify the process is dead
    try { process.kill(childPid, 0); expect(false).toBe(true); }
    catch { /* expected: process is dead */ }
  });

  it("snapshotSessionTree returns null for non-existent tmux session", async () => {
    const result = await snapshotSessionTree("ark-nonexistent-session");
    expect(result).toBeNull();
  });
});
```

## Testing strategy

1. **Unit tests** (`process-tree.test.ts`): Test `getProcessTree`, `killProcessTree`, `snapshotSessionTree` using the test runner's own PID and spawned child processes.
2. **Regression suite**: `make test` to verify no breakage. Key files:
   - `e2e-exec.test.ts` -- exercises executor dispatch end-to-end
   - `stage-isolation.test.ts` -- verifies session_id clearing on advance
   - `completion-paths.test.ts` -- exercises stop/complete lifecycle
3. **Manual verification**:
   - Dispatch a session via TUI (`ark session start --recipe quick-fix --repo . --dispatch`)
   - While running, check `app.sessions.get(id).config.process_tree` -- should have rootPid + children
   - Stop the session, verify no orphan processes via `ps aux | grep claude`
4. **Edge cases**:
   - Agent crashes (SIGKILL/OOM) -- poller detects exit, last snapshot preserved
   - Rapid stop after dispatch -- tree-kill handles ESRCH gracefully
   - Subprocess executor -- PID tracked without tmux
   - Multiple concurrent sessions -- each has its own process tree in config

## Risk assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Platform `ps` flag differences** | Low | Both macOS BSD `ps` and Linux procps support `-o pid=,ppid=,...` format. Tested on macOS (primary dev) and Linux (CI). |
| **PID recycling** | Low | Snapshots include `capturedAt` timestamp and command name. `killProcessTree` validates the PID tree belongs to expected process before killing. |
| **Performance of polling** | Low | Tree walk is 2-3 `execFile` calls (~30ms total) every 15s per session. With 10 sessions: ~300ms/15s = 2% overhead. |
| **Schema changes** | None | All data stored in existing `config` JSON blob. No migration needed. `rm ~/.ark/ark.db` not required. |
| **Breaking changes** | None | `LaunchResult.pid` is already optional. All new SessionConfig fields are optional and dynamic. |
| **Orphan kill regression** | Low | `killProcessTree` runs before the existing tmux kill and provider cleanup, which remain as fallbacks. |
| **Circular imports** | None | `process-tree.ts` only imports from `infra/tmux.ts`. No dependency on app, services, or orchestration. |

## Open questions

1. **Should process tree history be stored in events?** Currently only the latest snapshot lives in session config. Storing each snapshot as a `process_tree_snapshot` event would give a timeline for debugging but increases DB writes. Recommendation: start with config-only (latest), add event logging as a follow-up if debugging requires history.

2. **Remote compute support?** For EC2/Docker agents, the PID lives on the remote host. ArkD already has `collectTmuxSessions()` in `server.ts` that walks process trees. A future `/processes/<handle>/tree` endpoint on arkd would enable remote tree tracking. For v1, this feature is local-only.

3. **TUI display?** The `process_tree` data in session config naturally surfaces in the detail pane. A dedicated "Processes" sub-panel could show the tree visually. Recommendation: defer TUI work to a separate ticket; the data plumbing is the priority.
