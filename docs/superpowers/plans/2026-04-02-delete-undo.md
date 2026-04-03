# Delete Undo (Soft Delete with 90s TTL) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to undo session deletion within a 90-second window via Ctrl+Z in TUI or `ark session undelete` in CLI.

**Architecture:** Add a `deleted_at` column to sessions table. `deleteSessionAsync` kills tmux/provider but soft-deletes the DB row. A periodic sweep purges expired soft-deletes. TUI tracks the last deleted session ID in a ref and restores on Ctrl+Z.

**Tech Stack:** bun:sqlite (schema migration), React/Ink (TUI undo handler), bun:test

---

### Task 1: Add `deleted_at` column and soft-delete store functions

**Files:**
- Modify: `packages/core/store.ts`
- Test: `packages/core/__tests__/store-soft-delete.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/__tests__/store-soft-delete.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import {
  createSession, getSession, listSessions, updateSession,
  softDeleteSession, undeleteSession, listDeletedSessions,
  purgeExpiredDeletes, deleteSession,
} from "../store.js";
import { withTestContext } from "./test-helpers.js";

withTestContext();

describe("soft delete", () => {
  it("softDeleteSession sets status to 'deleting' and deleted_at", () => {
    const s = createSession({ summary: "test" });
    updateSession(s.id, { status: "running" });
    softDeleteSession(s.id);
    const after = getSession(s.id);
    expect(after!.status).toBe("deleting");
    expect(after!.config._pre_delete_status).toBe("running");
    expect(after!.config._deleted_at).toBeDefined();
  });

  it("softDeleteSession hides session from listSessions", () => {
    const s = createSession({ summary: "visible" });
    const s2 = createSession({ summary: "hidden" });
    softDeleteSession(s2.id);
    const list = listSessions();
    expect(list.find(x => x.id === s.id)).toBeDefined();
    expect(list.find(x => x.id === s2.id)).toBeUndefined();
  });

  it("undeleteSession restores previous status and clears delete state", () => {
    const s = createSession({ summary: "restore-me" });
    updateSession(s.id, { status: "stopped" });
    softDeleteSession(s.id);
    undeleteSession(s.id);
    const after = getSession(s.id);
    expect(after!.status).toBe("stopped");
    expect(after!.config._pre_delete_status).toBeUndefined();
    expect(after!.config._deleted_at).toBeUndefined();
  });

  it("listDeletedSessions returns only soft-deleted sessions", () => {
    const s1 = createSession({ summary: "alive" });
    const s2 = createSession({ summary: "dead" });
    softDeleteSession(s2.id);
    const deleted = listDeletedSessions();
    expect(deleted.find(x => x.id === s1.id)).toBeUndefined();
    expect(deleted.find(x => x.id === s2.id)).toBeDefined();
  });

  it("purgeExpiredDeletes removes sessions older than ttl", () => {
    const s = createSession({ summary: "expired" });
    // Manually set _deleted_at to 2 minutes ago
    const twoMinAgo = new Date(Date.now() - 120_000).toISOString();
    updateSession(s.id, {
      status: "deleting",
      config: { ...s.config, _deleted_at: twoMinAgo, _pre_delete_status: "running" },
    });
    const purged = purgeExpiredDeletes(90);
    expect(purged).toContain(s.id);
    expect(getSession(s.id)).toBeNull();
  });

  it("purgeExpiredDeletes skips sessions within ttl", () => {
    const s = createSession({ summary: "recent" });
    softDeleteSession(s.id);
    const purged = purgeExpiredDeletes(90);
    expect(purged).not.toContain(s.id);
    expect(getSession(s.id)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/__tests__/store-soft-delete.test.ts`
Expected: FAIL — `softDeleteSession` is not exported from `../store.js`

- [ ] **Step 3: Implement soft-delete functions in store.ts**

Add to `packages/core/store.ts` after the existing `deleteSession` function (around line 451):

```ts
/** Soft-delete: set status to "deleting", store previous status + timestamp in config. */
export function softDeleteSession(id: string): boolean {
  const session = getSession(id);
  if (!session) return false;
  const config = { ...session.config, _pre_delete_status: session.status, _deleted_at: new Date().toISOString() };
  updateSession(id, { status: "deleting", config });
  return true;
}

/** Restore a soft-deleted session to its previous status. */
export function undeleteSession(id: string): Session | null {
  const session = getSession(id);
  if (!session || session.status !== "deleting") return null;
  const prevStatus = (session.config._pre_delete_status as string) || "pending";
  const { _pre_delete_status, _deleted_at, ...cleanConfig } = session.config;
  updateSession(id, { status: prevStatus, config: cleanConfig });
  return getSession(id);
}

/** List sessions that are soft-deleted (status = "deleting"). */
export function listDeletedSessions(): Session[] {
  const db = getDb();
  return (db.prepare("SELECT * FROM sessions WHERE status = 'deleting' ORDER BY updated_at DESC").all() as SessionRow[]).map(rowToSession);
}

/**
 * Hard-delete sessions whose soft-delete timestamp exceeds ttlSeconds.
 * Returns array of purged session IDs.
 */
export function purgeExpiredDeletes(ttlSeconds: number = 90): string[] {
  const deleted = listDeletedSessions();
  const purged: string[] = [];
  const cutoff = Date.now() - ttlSeconds * 1000;

  for (const s of deleted) {
    const deletedAt = s.config._deleted_at as string | undefined;
    if (deletedAt && new Date(deletedAt).getTime() < cutoff) {
      deleteSession(s.id);
      purged.push(s.id);
    }
  }
  return purged;
}
```

Modify `listSessions` (line ~406) to exclude soft-deleted sessions. Change:

```ts
let sql = "SELECT * FROM sessions WHERE 1=1";
```

To:

```ts
let sql = "SELECT * FROM sessions WHERE status != 'deleting'";
```

- [ ] **Step 4: Export new functions from index.ts**

Add `softDeleteSession`, `undeleteSession`, `listDeletedSessions`, `purgeExpiredDeletes` to the re-exports in `packages/core/index.ts`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/core/__tests__/store-soft-delete.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 6: Run full core test suite for regressions**

Run: `bun test packages/core`
Expected: All existing tests still pass (listSessions now excludes "deleting" sessions, but no existing test creates sessions with that status)

- [ ] **Step 7: Commit**

```bash
git add packages/core/__tests__/store-soft-delete.test.ts packages/core/store.ts packages/core/index.ts
git commit -m "feat: add soft-delete store functions with 90s TTL"
```

---

### Task 2: Wire soft-delete into session.deleteSessionAsync

**Files:**
- Modify: `packages/core/session.ts`
- Modify: `packages/core/index.ts`
- Test: `packages/core/__tests__/store-soft-delete.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `packages/core/__tests__/store-soft-delete.test.ts`:

```ts
import { deleteSessionAsync, undeleteSessionAsync } from "../session.js";
import * as tmux from "../tmux.js";
import { mock } from "bun:test";

// Mock tmux to avoid real tmux calls
mock.module("../tmux.js", () => ({
  killSessionAsync: mock(() => Promise.resolve()),
  createSession: mock(() => {}),
  sendTextAsync: mock(() => Promise.resolve()),
  capturePaneAsync: mock(() => Promise.resolve("")),
  sessionExists: mock(() => false),
}));

describe("deleteSessionAsync with soft delete", () => {
  it("soft-deletes instead of hard-deleting", async () => {
    const s = createSession({ summary: "soft-kill" });
    updateSession(s.id, { status: "running", session_id: "test-tmux" });
    const result = await deleteSessionAsync(s.id);
    expect(result.ok).toBe(true);
    // Session still exists in DB but with "deleting" status
    const after = getSession(s.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe("deleting");
  });
});

describe("undeleteSessionAsync", () => {
  it("restores a soft-deleted session", async () => {
    const s = createSession({ summary: "restore" });
    updateSession(s.id, { status: "stopped" });
    await deleteSessionAsync(s.id);
    const result = await undeleteSessionAsync(s.id);
    expect(result.ok).toBe(true);
    const after = getSession(s.id);
    expect(after!.status).toBe("stopped");
  });

  it("fails for non-existent session", async () => {
    const result = await undeleteSessionAsync("nope");
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/__tests__/store-soft-delete.test.ts`
Expected: FAIL — `undeleteSessionAsync` not found

- [ ] **Step 3: Modify deleteSessionAsync to use soft delete**

In `packages/core/session.ts`, change `deleteSessionAsync` (line ~476):

```ts
export async function deleteSessionAsync(sessionId: string): Promise<{ ok: boolean; message: string }> {
  const session = store.getSession(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  // 1. Kill agent + clean up provider resources
  const handled = await withProvider(session, `delete ${sessionId}`, async (p, c) => {
    await p.killAgent(c, session);
    await p.cleanupSession(c, session);
  });
  if (!handled && session.session_id) {
    await tmux.killSessionAsync(session.session_id);
  }

  // 2. Clean up hook config (not provider-dependent)
  if (session.workdir) {
    try { claude.removeHooksConfig(session.workdir); } catch (e: any) {
      console.error(`delete ${sessionId}: removeHooksConfig:`, e?.message ?? e);
    }
  }

  // 3. Soft-delete (keeps DB row for 90s undo window)
  store.softDeleteSession(sessionId);

  store.logEvent(sessionId, "session_deleted", { actor: "user" });

  return { ok: true, message: "Session deleted (undo available for 90s)" };
}
```

Add new `undeleteSessionAsync`:

```ts
export async function undeleteSessionAsync(sessionId: string): Promise<{ ok: boolean; message: string }> {
  const restored = store.undeleteSession(sessionId);
  if (!restored) return { ok: false, message: `Session ${sessionId} not found or not deleted` };

  store.logEvent(sessionId, "session_undeleted", { actor: "user" });

  return { ok: true, message: `Session restored (status: ${restored.status})` };
}
```

- [ ] **Step 4: Export undeleteSessionAsync from index.ts**

Add `undeleteSessionAsync` to `packages/core/index.ts` exports.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/core/__tests__/store-soft-delete.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/session.ts packages/core/index.ts packages/core/__tests__/store-soft-delete.test.ts
git commit -m "feat: deleteSessionAsync uses soft-delete, add undeleteSessionAsync"
```

---

### Task 3: Add periodic purge sweep

**Files:**
- Modify: `packages/core/app.ts`

- [ ] **Step 1: Read app.ts to find the metrics polling interval setup**

Locate the `boot()` method and the existing interval/timer patterns.

- [ ] **Step 2: Add purge sweep to AppContext**

In `packages/core/app.ts`, inside the `boot()` method (or wherever periodic timers are set up), add:

```ts
// Purge expired soft-deletes every 30s
this._purgeInterval = setInterval(() => {
  store.purgeExpiredDeletes(90);
}, 30_000);
```

In the `shutdown()` method, add:

```ts
if (this._purgeInterval) clearInterval(this._purgeInterval);
```

Add the field to the class:

```ts
private _purgeInterval: ReturnType<typeof setInterval> | null = null;
```

- [ ] **Step 3: Run full test suite**

Run: `bun test packages/core`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/core/app.ts
git commit -m "feat: periodic purge of expired soft-deleted sessions"
```

---

### Task 4: Add Ctrl+Z undo in TUI

**Files:**
- Modify: `packages/tui/tabs/SessionsTab.tsx`
- Modify: `packages/tui/hooks/useSessionActions.ts`

- [ ] **Step 1: Add undo tracking to useSessionActions**

Modify `packages/tui/hooks/useSessionActions.ts` to track last deleted session and expose an undo function:

```ts
import { useRef, useCallback } from "react";
import * as core from "../../core/index.js";
import type { AsyncState } from "./useAsync.js";

export function useSessionActions(asyncState: AsyncState) {
  const run = asyncState.run;
  const lastDeletedRef = useRef<string | null>(null);

  const actions = {
    dispatch: (id: string) => {
      run(`Dispatching ${id}`, async (updateLabel) => {
        await core.dispatch(id, {
          onLog: (msg) => {
            updateLabel(msg);
            core.logEvent(id, "dispatch_progress", { actor: "system", data: { message: msg } });
          },
        });
      });
    },

    restart: (id: string) => {
      run(`Restarting ${id}`, async (updateLabel) => {
        await core.resume(id, { onLog: (msg) => updateLabel(msg) });
      });
    },

    stop: (id: string) => {
      run(`Stopping ${id}`, async () => { await core.stop(id); });
    },

    complete: (id: string) => {
      run(`Completing ${id}`, () => { core.complete(id); });
    },

    delete: (id: string) => {
      run(`Deleting ${id}`, async () => {
        await core.deleteSessionAsync(id);
        lastDeletedRef.current = id;
      });
    },

    undoDelete: () => {
      const id = lastDeletedRef.current;
      if (!id) return false;
      run("Restoring session", async () => {
        const result = await core.undeleteSessionAsync(id);
        if (result.ok) lastDeletedRef.current = null;
      });
      return true;
    },

    fork: (sourceId: string, groupName?: string | null) => {
      run(`Forking session`, async (updateLabel) => {
        const result = core.forkSession(sourceId);
        if (!result.ok) return;
        if (groupName) core.updateSession(result.sessionId, { group_name: groupName });
        await core.dispatch(result.sessionId, { onLog: (msg) => updateLabel(msg) });
      });
    },

    clone: (sourceId: string, name: string, groupName?: string | null) => {
      run(`Cloning → ${name}`, async (updateLabel) => {
        const result = core.cloneSession(sourceId, name);
        if (!result.ok) return;
        if (groupName) core.updateSession(result.sessionId, { group_name: groupName });
        await core.dispatch(result.sessionId, { onLog: (msg) => updateLabel(msg) });
      });
    },

    move: (id: string, group: string | null) => {
      run("Moving session", () => { core.updateSession(id, { group_name: group }); });
    },

    stopGroup: (sessions: core.Session[]) => {
      run("Stopping group", () => {
        for (const s of sessions) {
          if (!["completed", "failed", "stopped"].includes(s.status)) core.stop(s.id);
        }
      });
    },

    resumeGroup: (sessions: core.Session[]) => {
      run("Resuming group", async () => {
        for (const s of sessions) {
          if (["blocked", "waiting", "failed", "stopped", "completed"].includes(s.status)) {
            await core.resume(s.id);
          }
        }
      });
    },

    deleteGroup: (sessions: core.Session[]) => {
      run("Deleting group", async () => {
        for (const s of sessions) {
          await core.deleteSessionAsync(s.id);
        }
        // Track last deleted for potential undo (last session in group)
        if (sessions.length > 0) lastDeletedRef.current = sessions[sessions.length - 1].id;
      });
    },
  };

  return actions;
}
```

- [ ] **Step 2: Add Ctrl+Z handler to SessionsTab**

In `packages/tui/tabs/SessionsTab.tsx`, inside the `useInput` callback, add after the overlay/global checks (around line 99, before the `if (!selected) return` guard):

```ts
    // Ctrl+Z: undo last delete
    if (input === "z" && key.ctrl) {
      if (actions.undoDelete()) {
        status.show("Session restored");
      }
      return;
    }
```

- [ ] **Step 3: Update delete status message**

In `SessionsTab.tsx`, update the delete confirm handler (line ~142) to show the undo hint:

```ts
    } else if (input === "x") {
      if (confirmation.confirm("delete", `Delete '${selected.summary ?? selected.id}'? Press x again to confirm`)) {
        actions.delete(selected.id);
        status.show("Deleted. Ctrl+Z to undo (90s)");
      }
```

- [ ] **Step 4: Run TUI manually to verify**

Run: `make dev && ark tui`
- Create a test session
- Press x, x to delete → should see "Deleted. Ctrl+Z to undo (90s)"
- Press Ctrl+Z → should see "Session restored", session reappears in list

- [ ] **Step 5: Commit**

```bash
git add packages/tui/tabs/SessionsTab.tsx packages/tui/hooks/useSessionActions.ts
git commit -m "feat: Ctrl+Z undo delete in TUI with 90s window"
```

---

### Task 5: Add CLI `ark session undelete` command

**Files:**
- Modify: `packages/cli/index.ts`

- [ ] **Step 1: Add undelete subcommand**

In `packages/cli/index.ts`, after the existing `session.command("send")` block (around line 257), add:

```ts
session.command("undelete")
  .description("Restore a recently deleted session (within 90s)")
  .argument("<id>")
  .action(async (id) => {
    const result = await core.undeleteSessionAsync(id);
    console.log(result.ok ? chalk.green(result.message) : chalk.red(result.message));
  });
```

- [ ] **Step 2: Update delete command to show undo hint**

Modify the existing `ark session delete` output (find the delete command in the CLI) to show the undo window hint. If the delete command just calls `deleteSessionAsync`, update its action to:

```ts
    const result = await core.deleteSessionAsync(id);
    if (result.ok) {
      console.log(chalk.green(result.message));
      console.log(chalk.dim(`  Run 'ark session undelete ${id}' within 90s to undo`));
    } else {
      console.log(chalk.red(result.message));
    }
```

- [ ] **Step 3: Build and test CLI**

Run: `make dev`
Then:
```bash
ark session start --summary "undo-test" --repo .
ark session delete <id>
# Should show: Session deleted (undo available for 90s)
#              Run 'ark session undelete <id>' within 90s to undo
ark session undelete <id>
# Should show: Session restored (status: pending)
```

- [ ] **Step 4: Commit**

```bash
git add packages/cli/index.ts
git commit -m "feat: add 'ark session undelete' CLI command"
```

---

### Task 6: Ensure conductor and pollers skip soft-deleted sessions

**Files:**
- Modify: `packages/core/conductor.ts` (if needed)

- [ ] **Step 1: Verify listSessions exclusion covers all callers**

Search for all `listSessions()` and `getSession()` calls in conductor, pollers, and session.ts. Since `listSessions` already excludes `status = 'deleting'`, most callers are safe. The key ones to verify:

- `conductor.ts` schedule/PR/issue pollers use `listSessions()` → already safe
- `checkpoint.ts` `findOrphanedSessions()` uses `listSessions()` → already safe
- `getSession()` still returns soft-deleted sessions (needed for undelete) → this is correct

- [ ] **Step 2: Check that advance/dispatch reject "deleting" sessions**

In `session.ts`, `dispatch()` checks `session.status` before proceeding. Since "deleting" is not in any valid transition set, dispatch/advance/resume will all reject it naturally. No changes needed.

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 4: Commit (if any changes were needed)**

```bash
git add -A && git commit -m "chore: verify soft-delete safety across conductor and pollers"
```
