# Hook-Based Agent Status Detection -- Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fragile tmux pane polling with Claude Code's native hook system for instant, reliable agent status detection.

**Architecture:** At dispatch time, `claude.ts` writes `.claude/settings.local.json` into the session working directory with HTTP hooks that POST status events to the conductor. The conductor maps hook events to session statuses in SQLite. Hooks are ONLY for status -- channels remain the agent↔human communication system.

**Tech Stack:** Claude Code hooks (HTTP type), Bun HTTP server (existing conductor), SQLite (existing store)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/core/claude.ts` | **Modify:** Add `writeHooksConfig()` and `removeHooksConfig()` -- write/clean `.claude/settings.local.json` with status hooks |
| `packages/core/conductor.ts` | **Modify:** Add `POST /hooks/status` endpoint -- tiny status receiver, maps hook events to session status |
| `packages/core/session.ts` | **Modify:** Call `writeHooksConfig()` in `launchAgentTmux()` after `writeChannelConfig()` (line 345) |
| `packages/core/__tests__/claude-hooks.test.ts` | **Create:** Tests for writeHooksConfig/removeHooksConfig |
| `packages/core/__tests__/conductor-hooks.test.ts` | **Create:** Tests for the /hooks/status endpoint |

No new files beyond tests. No schema changes. No new dependencies.

---

### Task 1: writeHooksConfig() -- generate .claude/settings.local.json

**Files:**
- Test: `packages/core/__tests__/claude-hooks.test.ts`
- Modify: `packages/core/claude.ts`

- [ ] **Step 1: Write the failing test**

```ts
/**
 * Tests for claude.ts hook config -- writeHooksConfig / removeHooksConfig.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import {
  createTestContext, setContext, resetContext,
  type TestContext,
} from "../context.js";
import { writeHooksConfig, removeHooksConfig } from "../claude.js";

let ctx: TestContext;

beforeEach(() => {
  if (ctx) ctx.cleanup();
  ctx = createTestContext();
  setContext(ctx);
});

afterAll(() => {
  if (ctx) ctx.cleanup();
  resetContext();
});

describe("writeHooksConfig", () => {
  it("creates .claude/settings.local.json in workdir", () => {
    const workdir = ctx.arkDir;
    writeHooksConfig("s-test123", "http://localhost:19100", workdir);
    const settingsPath = join(workdir, ".claude", "settings.local.json");
    expect(existsSync(settingsPath)).toBe(true);
  });

  it("contains hooks for all status events", () => {
    const workdir = ctx.arkDir;
    writeHooksConfig("s-test123", "http://localhost:19100", workdir);
    const settings = JSON.parse(
      readFileSync(join(workdir, ".claude", "settings.local.json"), "utf-8")
    );
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.Stop).toBeDefined();
    expect(settings.hooks.StopFailure).toBeDefined();
    expect(settings.hooks.SessionEnd).toBeDefined();
    expect(settings.hooks.Notification).toBeDefined();
    expect(settings.hooks.UserPromptSubmit).toBeDefined();
  });

  it("hooks use HTTP type with correct conductor URL", () => {
    const workdir = ctx.arkDir;
    writeHooksConfig("s-abc", "http://host.docker.internal:19100", workdir);
    const settings = JSON.parse(
      readFileSync(join(workdir, ".claude", "settings.local.json"), "utf-8")
    );
    const stopHook = settings.hooks.Stop[0].hooks[0];
    expect(stopHook.type).toBe("command");
    expect(stopHook.command).toContain("http://host.docker.internal:19100");
    expect(stopHook.command).toContain("s-abc");
  });

  it("all hooks are async", () => {
    const workdir = ctx.arkDir;
    writeHooksConfig("s-test", "http://localhost:19100", workdir);
    const settings = JSON.parse(
      readFileSync(join(workdir, ".claude", "settings.local.json"), "utf-8")
    );
    for (const [, matchers] of Object.entries(settings.hooks)) {
      for (const matcher of matchers as any[]) {
        for (const hook of matcher.hooks) {
          expect(hook.async).toBe(true);
        }
      }
    }
  });

  it("preserves existing non-hook settings", () => {
    const workdir = ctx.arkDir;
    const claudeDir = join(workdir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Bash"] } })
    );

    writeHooksConfig("s-test", "http://localhost:19100", workdir);

    const settings = JSON.parse(
      readFileSync(join(claudeDir, "settings.local.json"), "utf-8")
    );
    expect(settings.permissions.allow).toContain("Bash");
    expect(settings.hooks).toBeDefined();
  });

  it("is idempotent -- calling twice doesn't duplicate hooks", () => {
    const workdir = ctx.arkDir;
    writeHooksConfig("s-test", "http://localhost:19100", workdir);
    writeHooksConfig("s-test", "http://localhost:19100", workdir);

    const settings = JSON.parse(
      readFileSync(join(workdir, ".claude", "settings.local.json"), "utf-8")
    );
    // Each event should have exactly 1 matcher entry from ark
    expect(settings.hooks.Stop.length).toBe(1);
  });

  it("includes session ID in hook command for correlation", () => {
    const workdir = ctx.arkDir;
    writeHooksConfig("s-myid", "http://localhost:19100", workdir);
    const settings = JSON.parse(
      readFileSync(join(workdir, ".claude", "settings.local.json"), "utf-8")
    );
    const cmd = settings.hooks.Stop[0].hooks[0].command;
    expect(cmd).toContain("s-myid");
  });
});

describe("removeHooksConfig", () => {
  it("removes ark hooks but preserves other settings", () => {
    const workdir = ctx.arkDir;

    // First write hooks via the real function, then add other settings
    writeHooksConfig("s-test", "http://localhost:19100", workdir);
    const claudeDir = join(workdir, ".claude");
    const settingsPath = join(claudeDir, "settings.local.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    settings.permissions = { allow: ["Bash"] };
    writeFileSync(settingsPath, JSON.stringify(settings));

    removeHooksConfig(workdir);

    const cleaned = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(cleaned.permissions.allow).toContain("Bash");
    expect(cleaned.hooks).toBeUndefined();
  });

  it("does nothing if no settings file exists", () => {
    const workdir = ctx.arkDir;
    expect(() => removeHooksConfig(workdir)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/__tests__/claude-hooks.test.ts`
Expected: FAIL -- `writeHooksConfig` and `removeHooksConfig` not exported.

- [ ] **Step 3: Implement writeHooksConfig and removeHooksConfig**

Add to `packages/core/claude.ts` after the `writeChannelConfig` function:

```ts
// ── Hook-based status config ────────────────────────────────────────────────

const ARK_HOOK_MARKER = "# ark-status";

/**
 * Build the hook command string.
 * Uses curl to POST hook payload (piped from stdin) to the conductor.
 * Claude Code pipes hook JSON to stdin for command-type hooks.
 * The ARK_HOOK_MARKER is a comment prefix for identification/cleanup.
 */
function hookCommand(sessionId: string, conductorUrl: string): string {
  const curlCmd = `curl -sf -X POST -H 'Content-Type: application/json' -d @- '${conductorUrl}/hooks/status?session=${sessionId}' || true`;
  // Comment marker for idempotent cleanup, then the actual command
  return `${ARK_HOOK_MARKER} ${sessionId}\n${curlCmd}`;
}

/**
 * Build the hooks config object for Claude Code settings.local.json.
 * All hooks are async and use command type (curl POST to conductor).
 */
function buildHooksConfig(sessionId: string, conductorUrl: string): Record<string, unknown[]> {
  const cmd = hookCommand(sessionId, conductorUrl);
  const hook = { type: "command" as const, command: cmd, async: true };

  return {
    SessionStart: [{ matcher: "startup|resume", hooks: [hook] }],
    UserPromptSubmit: [{ hooks: [hook] }],
    Stop: [{ hooks: [hook] }],
    StopFailure: [{ hooks: [hook] }],
    SessionEnd: [{ hooks: [hook] }],
    Notification: [{ matcher: "permission_prompt|idle_prompt", hooks: [hook] }],
  };
}

/**
 * Write .claude/settings.local.json with status hooks.
 * Merges with existing settings -- preserves all non-hook keys.
 * Idempotent: replaces any existing ark hooks.
 */
export function writeHooksConfig(
  sessionId: string, conductorUrl: string, workdir: string,
): string {
  const claudeDir = join(workdir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, "settings.local.json");

  // Read existing settings
  let existing: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try { existing = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch {}
  }

  // Remove any previous ark hooks (idempotent)
  if (existing.hooks && typeof existing.hooks === "object") {
    const hooks = existing.hooks as Record<string, unknown[]>;
    for (const [event, matchers] of Object.entries(hooks)) {
      hooks[event] = (matchers as any[]).filter(
        (m: any) => !m.hooks?.some((h: any) => h.command?.startsWith(ARK_HOOK_MARKER))
      );
      if (hooks[event].length === 0) delete hooks[event];
    }
    if (Object.keys(hooks).length === 0) delete existing.hooks;
  }

  // Merge new hooks
  const newHooks = buildHooksConfig(sessionId, conductorUrl);
  const existingHooks = (existing.hooks ?? {}) as Record<string, unknown[]>;
  for (const [event, matchers] of Object.entries(newHooks)) {
    existingHooks[event] = [...(existingHooks[event] ?? []), ...matchers];
  }
  existing.hooks = existingHooks;

  // Atomic write (renameSync imported from "fs" at top of file)
  const tmpPath = settingsPath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(existing, null, 2));
  renameSync(tmpPath, settingsPath);

  return settingsPath;
}

/**
 * Remove ark hooks from .claude/settings.local.json.
 * Preserves all non-hook settings and any user hooks.
 */
export function removeHooksConfig(workdir: string): void {
  const settingsPath = join(workdir, ".claude", "settings.local.json");
  if (!existsSync(settingsPath)) return;

  let settings: Record<string, unknown>;
  try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch { return; }

  if (!settings.hooks || typeof settings.hooks !== "object") return;

  const hooks = settings.hooks as Record<string, unknown[]>;
  for (const [event, matchers] of Object.entries(hooks)) {
    hooks[event] = (matchers as any[]).filter(
      (m: any) => !m.hooks?.some((h: any) => h.command?.startsWith(ARK_HOOK_MARKER))
    );
    if (hooks[event].length === 0) delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}
```

Notes:
- Add `renameSync` to the existing `import { ... } from "fs"` at the top of `claude.ts` (line 10).
- We use `type: "command"` with `curl` rather than `type: "http"` because `curl` works on all compute targets (local, EC2, Docker) regardless of Claude Code version. The `# ark-status` comment prefix is a marker for idempotent cleanup -- it's a bash comment, so it doesn't execute or block the curl command.
- `SessionStart` is included to detect agent start before the first `UserPromptSubmit`.

- [ ] **Step 4: Run tests, fix issues until green**

Run: `bun test packages/core/__tests__/claude-hooks.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/core/claude.ts packages/core/__tests__/claude-hooks.test.ts
git commit -m "feat: writeHooksConfig generates .claude/settings.local.json for agent status hooks"
```

---

### Task 2: Conductor /hooks/status endpoint

**Files:**
- Test: `packages/core/__tests__/conductor-hooks.test.ts`
- Modify: `packages/core/conductor.ts`

- [ ] **Step 1: Write the failing test**

```ts
/**
 * Tests for conductor /hooks/status endpoint.
 * Validates hook event → session status mapping.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import {
  createTestContext, setContext, resetContext,
  type TestContext,
} from "../context.js";
import { createSession, getSession, updateSession, getEvents } from "../store.js";
import { startConductor } from "../conductor.js";

const TEST_PORT = 19198;
let ctx: TestContext;
let server: { stop(): void };

beforeEach(() => {
  if (ctx) ctx.cleanup();
  ctx = createTestContext();
  setContext(ctx);
  server = startConductor(TEST_PORT, { quiet: true });
});

afterEach(() => {
  try { server.stop(); } catch {}
});

afterAll(() => {
  if (ctx) ctx.cleanup();
  resetContext();
});

async function postHookStatus(sessionId: string, payload: Record<string, unknown>): Promise<Response> {
  return fetch(`http://localhost:${TEST_PORT}/hooks/status?session=${sessionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("Conductor /hooks/status", () => {
  it("UserPromptSubmit sets status to running", async () => {
    const session = createSession({ summary: "test" });
    updateSession(session.id, { status: "ready" });

    const resp = await postHookStatus(session.id, {
      hook_event_name: "UserPromptSubmit",
      session_id: "claude-uuid",
    });
    expect(resp.status).toBe(200);

    const updated = getSession(session.id);
    expect(updated!.status).toBe("running");
  });

  it("Stop sets status to ready (agent finished turn, waiting for input)", async () => {
    const session = createSession({ summary: "test" });
    updateSession(session.id, { status: "running" });

    await postHookStatus(session.id, {
      hook_event_name: "Stop",
      session_id: "claude-uuid",
    });

    const updated = getSession(session.id);
    expect(updated!.status).toBe("ready");
  });

  it("StopFailure sets status to failed with error details", async () => {
    const session = createSession({ summary: "test" });
    updateSession(session.id, { status: "running" });

    await postHookStatus(session.id, {
      hook_event_name: "StopFailure",
      error: "rate_limit",
      error_details: "Rate limited",
    });

    const updated = getSession(session.id);
    expect(updated!.status).toBe("failed");
    expect(updated!.error).toContain("rate_limit");
  });

  it("SessionEnd sets status to completed", async () => {
    const session = createSession({ summary: "test" });
    updateSession(session.id, { status: "running" });

    await postHookStatus(session.id, {
      hook_event_name: "SessionEnd",
      reason: "prompt_input_exit",
    });

    const updated = getSession(session.id);
    expect(updated!.status).toBe("completed");
  });

  it("Notification with permission_prompt sets status to waiting", async () => {
    const session = createSession({ summary: "test" });
    updateSession(session.id, { status: "running" });

    await postHookStatus(session.id, {
      hook_event_name: "Notification",
      matcher: "permission_prompt",
    });

    const updated = getSession(session.id);
    expect(updated!.status).toBe("waiting");
  });

  it("returns 404 for unknown session", async () => {
    const resp = await postHookStatus("s-nonexistent", {
      hook_event_name: "Stop",
    });
    expect(resp.status).toBe(404);
  });

  it("returns 200 for unknown event (no-op)", async () => {
    const session = createSession({ summary: "test" });
    updateSession(session.id, { status: "running" });

    const resp = await postHookStatus(session.id, {
      hook_event_name: "PreCompact",
    });
    expect(resp.status).toBe(200);

    // Status unchanged
    const updated = getSession(session.id);
    expect(updated!.status).toBe("running");
  });

  it("logs hook event to event audit trail", async () => {
    const session = createSession({ summary: "test" });
    updateSession(session.id, { status: "running" });

    await postHookStatus(session.id, {
      hook_event_name: "Stop",
      session_id: "claude-uuid",
    });

    const events = getEvents(session.id);
    const hookEvent = events.find((e: any) => e.type === "hook_status");
    expect(hookEvent).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/core/__tests__/conductor-hooks.test.ts`
Expected: FAIL -- /hooks/status endpoint returns 404.

- [ ] **Step 3: Add the /hooks/status endpoint to conductor.ts**

Add inside the `fetch` handler in `startConductor`, before the `return new Response("Not found")` line:

```ts
        // Hook-based agent status (separate from channel protocol)
        if (req.method === "POST" && path === "/hooks/status") {
          const sessionId = url.searchParams.get("session");
          if (!sessionId) return Response.json({ error: "missing session param" }, { status: 400 });

          const s = store.getSession(sessionId);
          if (!s) return Response.json({ error: "session not found" }, { status: 404 });

          const payload = await req.json() as Record<string, unknown>;
          const event = String(payload.hook_event_name ?? "");

          // Map hook event to session status (using existing valid statuses)
          const statusMap: Record<string, string> = {
            SessionStart: "running",
            UserPromptSubmit: "running",
            Stop: "ready",           // agent finished turn, waiting for input
            StopFailure: "failed",
            SessionEnd: "completed",
          };

          let newStatus = statusMap[event];

          // Notification events need matcher inspection
          if (event === "Notification") {
            const matcher = String(payload.matcher ?? "");
            if (matcher.includes("permission_prompt") || matcher.includes("idle_prompt")) {
              newStatus = "waiting";
            }
          }

          // Log the hook event regardless
          store.logEvent(sessionId, "hook_status", {
            actor: "hook",
            data: { event, ...payload } as Record<string, unknown>,
          });

          // Update status if we have a mapping
          if (newStatus) {
            const updates: Partial<store.Session> = { status: newStatus as any };
            if (newStatus === "error") {
              updates.error = String(payload.error ?? payload.error_details ?? "unknown error");
            }
            store.updateSession(sessionId, updates);

            // Emit to event bus
            eventBus.emit("hook_status", sessionId, {
              data: { event, status: newStatus, ...payload } as Record<string, unknown>,
            });
          }

          return Response.json({ status: "ok", mapped: newStatus ?? "no-op" });
        }
```

- [ ] **Step 4: Run tests, fix issues until green**

Run: `bun test packages/core/__tests__/conductor-hooks.test.ts`

Note: The `updateSession` CAS (compare-and-swap) may reject some status transitions. Check that `idle`, `error`, `waiting`, `completed` are valid values in the status enum. If the store rejects them, either:
- Add them to the valid status values
- Map to existing valid statuses (e.g., `idle` → `ready`, `error` → `failed`, `waiting` → `blocked`)

Check `store.ts` for the status constraint and adjust the mapping accordingly.

- [ ] **Step 5: Commit**

```bash
git add packages/core/conductor.ts packages/core/__tests__/conductor-hooks.test.ts
git commit -m "feat: conductor /hooks/status endpoint for agent status detection"
```

---

### Task 3: Wire into session dispatch

**Files:**
- Modify: `packages/core/session.ts:launchAgentTmux` (~line 345)

- [ ] **Step 1: Add writeHooksConfig call after writeChannelConfig**

In `launchAgentTmux()`, after line 345 (`const mcpConfigPath = claude.writeChannelConfig(...)`), add:

```ts
  // Status hooks -- write .claude/settings.local.json for agent status detection
  claude.writeHooksConfig(session.id, conductorUrl, effectiveWorkdir);
```

This is a one-line change. The `conductorUrl` variable is already computed on line 339-341.

- [ ] **Step 2: Add removeHooksConfig to session cleanup in session.ts**

In `session.ts`, in the `stop()` function and in `deleteSession()` (if it exists -- otherwise in whatever function handles session teardown), add after the tmux kill:

```ts
  // Clean up hook config from working directory
  if (session.workdir) {
    claude.removeHooksConfig(session.workdir);
  }
```

This goes in `session.ts` (not `store.ts`) to avoid circular dependencies -- `claude.ts` imports from `store.ts`, so `store.ts` cannot import from `claude.ts`.

- [ ] **Step 3: Run existing session tests to verify no regressions**

Run: `bun test packages/core/__tests__/session-compute.test.ts packages/core/__tests__/session-stop-resume.test.ts`

- [ ] **Step 4: Run the full test suite**

Run: `bun test packages/core/__tests__/ packages/tui/__tests__/`

- [ ] **Step 5: Commit**

```bash
git add packages/core/session.ts
git commit -m "feat: wire hook config into session dispatch and cleanup"
```

---

### Task 4: Verify status mapping + handle race conditions

**Files:**
- No file changes expected -- this is a verification task.

The hook status mapping is already aligned with existing statuses in Tasks 2-3:

| Hook Event | Maps To | Existing Status? |
|---|---|---|
| `SessionStart` | `running` | yes |
| `UserPromptSubmit` | `running` | yes |
| `Stop` | `ready` | yes |
| `StopFailure` | `failed` | yes |
| `SessionEnd` | `completed` | yes |
| `Notification` (permission/idle) | `waiting` | yes |

- [ ] **Step 1: Verify no conflicts with channel reports**

The conductor's `handleReport` function (channel protocol) also sets statuses:
- `completed` report → `ready` + `advance()`
- `error` report → `failed`
- `question` report → `waiting`

Hook events and channel reports may arrive for the same session. This is OK because:
- Channel reports are the **authoritative** state transitions (they trigger pipeline advancement)
- Hook status updates are **advisory** (they provide real-time UI feedback)
- If a hook sets `ready` and then a channel `completed` report arrives, the channel handler sets `ready` again and calls `advance()` -- idempotent
- The conductor endpoint should NOT call `advance()` on hook events -- only channel reports trigger pipeline progression

Verify that the conductor `/hooks/status` handler does NOT call `session.advance()`.

- [ ] **Step 2: Run all tests**

Run: `bun test packages/core/__tests__/`

- [ ] **Step 3: Commit (if any fixes needed)**

```bash
git commit -am "fix: verify hook/channel status interaction"
```

---

### Task 5: End-to-end manual verification

- [ ] **Step 1: Start the TUI**

```bash
bun run packages/cli/index.ts tui
```

- [ ] **Step 2: Create and dispatch a session**

Use the TUI to create a session with a simple task. Observe that `.claude/settings.local.json` is created in the working directory.

- [ ] **Step 3: Verify hook events arrive**

Check conductor logs or add temporary `console.log` to the `/hooks/status` handler. Verify that status changes appear in the TUI without relying on tmux polling.

- [ ] **Step 4: Verify cleanup on delete**

Delete the session. Verify `.claude/settings.local.json` no longer contains ark hooks.

- [ ] **Step 5: Final commit**

```bash
git commit -am "test: verify hook-based status detection end-to-end"
```
