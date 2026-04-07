# Product Excellence Plan

**Date:** 2026-04-07
**Goal:** Turn Ark from a feature-complete tool into a product that is a pleasure to use.

---

## Current State

Ark has comprehensive features: multi-compute, flows, verification gates, auto-PR, search, cost tracking, guardrails, OTLP, etc. But the UX has friction that makes it feel like a powerful engine with a rough dashboard. The gap is not features -- it's polish, feedback, and trust.

### What works well
- TUI real-time feedback via in-memory RPC + 500ms tmux capture
- Contextual status bar hints (the right action is always visible)
- Soft-delete with 90s undo
- Three-tier resolution for skills/recipes/agents
- Auto-dispatch loop for gate:auto stages

### What hurts
- No onboarding (empty TUI, no guided setup)
- Silent failures (auto-dispatch errors go to stderr, not UI)
- No completion notifications (30-min task finishes, nobody knows)
- Action stages in flows don't auto-execute (YAML implies automation, reality requires manual clicks)
- No flow pipeline visualization (user can't see where they are)
- Error messages are internal state dumps, not recovery guidance
- Web requires pre-built dist with no fallback
- No prerequisite checks (tmux/claude/git missing = cryptic failures)

---

## Phase 1: First Impressions (make the first 60 seconds work)

### 1.1 Prerequisite checker at startup

`ark tui` and `ark session start` should check for required tools before doing anything:

```
Checking prerequisites...
  bun     v1.3.11  OK
  tmux    3.4      OK
  git     2.44     OK
  claude  1.0.8    OK
  gh      2.45     OK (optional - needed for PR creation)
```

If tmux or claude are missing, print a clear error with install instructions and exit. Don't let the user get 5 steps in before failing.

**Where:** Add `checkPrereqs()` to `app.ts` boot sequence. Call from CLI entry before any command that needs them.

### 1.2 First-run welcome in TUI

When the TUI starts with 0 sessions and no `~/.ark/config.yaml`, show a welcome overlay instead of an empty list:

```
Welcome to Ark

  Quick start:
    n     Create your first session
    ?     See all keyboard shortcuts
    q     Quit

  Or from the terminal:
    ark session start --repo . --summary "Fix a bug" --dispatch
```

**Where:** `App.tsx` -- detect first run (0 sessions + no config), render welcome overlay.

### 1.3 `ark init` setup wizard

```bash
ark init
```

Interactive setup that:
1. Checks prerequisites (1.1)
2. Detects Claude auth status
3. Creates `~/.ark/config.yaml` with sensible defaults
4. Optionally creates `.ark.yaml` in the current repo
5. Offers to create a first session

**Where:** New CLI command in `cli/index.ts`.

### 1.4 Web auto-build fallback

When `ark web` serves and `packages/web/dist/` doesn't exist, auto-run the build:

```ts
if (!existsSync(WEB_DIST)) {
  console.log("Building web frontend...");
  execFileSync("bun", ["run", "packages/web/build.ts"]);
}
```

**Where:** `web.ts` startWebServer, before Bun.serve().

---

## Phase 2: Trust the System (make async work visible)

### 2.1 OS notifications on stage completion

When a session stage completes or fails, send a macOS notification:

```ts
import { execFile } from "child_process";
// macOS
execFile("osascript", ["-e", `display notification "Stage ${stage} completed" with title "Ark: ${summary}"`]);
```

Enable/disable in config: `notifications: true`. This is the single most impactful change for long-running tasks.

**Where:** `conductor.ts` handleReport, after status transition to completed/failed.

### 2.2 Auto-execute action stages

The `default` flow has action stages (`create_pr`, `merge_pr`, `close_ticket`) that look automatic but require manual intervention. Fix the conductor's auto-dispatch to handle action stages:

```ts
// In conductor.ts handleReport, after advance:
if (updated?.status === "ready" && updated.stage) {
  const nextAction = flow.getStageAction(updated.flow, updated.stage);
  if (nextAction.type === "agent" || nextAction.type === "fork") {
    session.dispatch(sessionId);
  } else if (nextAction.type === "action") {
    session.executeAction(sessionId, nextAction);  // NEW
  }
}
```

Add `executeAction()` that handles: `create_pr` (calls createWorktreePR), `merge_pr` (calls finishWorktree), `close_ticket` (marks complete).

**Where:** `session-orchestration.ts` new function, `conductor.ts` auto-dispatch block.

### 2.3 Flow pipeline visualization in TUI

Show the full flow pipeline in SessionDetail with the current stage highlighted:

```
Flow: default
  plan > [implement] > pr > review > merge
         ^^^^^^^^^^^
```

Simple text rendering using the flow definition. Green for completed stages, yellow+brackets for current, dim for future.

**Where:** `SessionDetail.tsx`, new section between Info and Todos.

### 2.4 Dispatch progress streaming

Replace the single "Dispatching..." spinner with stage-by-stage progress. The JSON-RPC doesn't support streaming, but we can use server-push notifications:

1. `dispatch()` logs events: `dispatch_progress` with data `{ step: "Building task..." }`
2. TUI subscribes to session events and shows them in real-time

**Where:** `session-orchestration.ts` dispatch, `conductor.ts` event emission, `SessionsTab.tsx` status display.

---

## Phase 3: Recover Gracefully (make errors helpful)

### 3.1 Structured error messages with recovery hints

Replace bare strings with structured errors:

```ts
interface ArkError {
  message: string;       // What happened
  hint?: string;         // What to do about it
  recoverable: boolean;  // Can the user retry?
}
```

Examples:
- "Session not running" -> hint: "Dispatch it first with Enter or `ark session dispatch <id>`"
- "No tmux session" -> hint: "The agent may have crashed. Check events with `e` or restart with Enter"
- "Compute not found" -> hint: "Create one with `ark compute create <name> --provider ec2`"

**Where:** `session-orchestration.ts` all return paths, new `ArkError` type in `types/`.

### 3.2 Stale session detection on TUI startup

When the TUI starts, check for sessions with `status: "running"` whose tmux session no longer exists:

```ts
for (const s of sessions.filter(s => s.status === "running" && s.session_id)) {
  if (!tmux.sessionExists(s.session_id)) {
    // Mark as failed with explanation
    sessions.update(s.id, { status: "failed", error: "Agent process died while TUI was closed" });
  }
}
```

**Where:** `app.ts` boot sequence, after DB init.

### 3.3 Persistent error log

Add a `~/.ark/logs/errors.jsonl` file that captures all errors with timestamps, session context, and stack traces. The TUI EventLog should show errors from this file, not just DB events.

**Where:** `structured-log.ts` (already has logError), `EventLog.tsx` (add error source).

---

## Phase 4: Visual Polish (make it feel good)

### 4.1 Session list responsive layout

Adapt column widths to terminal width instead of fixed padding:

```
Terminal 120 cols: {icon} {summary:40} {stage:14} {branch:20} {age:6}
Terminal 80 cols:  {icon} {summary:25} {stage:12} {age:4}
```

**Where:** `SessionsTab.tsx` renderRow, use `process.stdout.columns`.

### 4.2 Success toasts for async operations

After dispatch/stop/complete/archive succeeds, show a brief green confirmation:

```
Session dispatched  agent: implementer  stage: plan
```

Currently only errors trigger status messages. Add success messages to all `useSessionActions` completions.

**Where:** `useSessionActions.ts`, add `status.show()` calls on success.

### 4.3 Empty state guidance per section

When SessionDetail sections have no data, show helpful placeholders:

```
Todos: No todos yet. Add with `ark session todo add <id> "text"`
Conversation: Waiting for agent to start...
Live Output: Session not running
```

**Where:** `SessionDetail.tsx`, each section's empty branch.

### 4.4 Stale hooks cleanup on startup

Check for `.claude/settings.local.json` in the current repo at TUI startup. If it exists and contains ark hooks for a session that no longer exists, remove it:

```ts
if (existsSync(".claude/settings.local.json")) {
  const content = JSON.parse(readFileSync(...));
  if (content.hooks?.Stop?.[0]?.hooks?.[0]?.command?.includes("ark-status")) {
    // Extract session ID from the hook URL, check if session exists
    // If not, remove the file
  }
}
```

**Where:** `app.ts` boot, or `claude.ts` new cleanup function.

---

## Phase 5: Power Features (differentiate from competitors)

### 5.1 Command palette in TUI

`Cmd+K` (or configurable hotkey) opens a fuzzy command palette:

```
> dispatch
  Dispatch selected session
  Stop selected session
  Create new session
  Search sessions
  Open settings
```

Type to filter, Enter to execute. This makes every feature discoverable without memorizing shortcuts.

**Where:** New `CommandPalette.tsx` component, wire into `App.tsx` useInput.

### 5.2 Agent progress parsing

Parse Claude Code's terminal output to extract structured progress:

```
Reading src/auth/login.ts...     -> "Reading files" (blue)
Running npm test...              -> "Running tests" (yellow)
Writing src/auth/login.ts...     -> "Writing code" (green)
```

Show as a mini progress line in the session list row, replacing the raw tmux capture.

**Where:** `status-detect.ts` (already has pattern matching), `SessionsTab.tsx` row rendering.

### 5.3 Web SSE push on actual state changes

Replace the 3-second polling broadcast with event-driven push:

```ts
// Instead of setInterval every 3s:
eventBus.on("session/*", (sessionId, data) => {
  for (const client of sseClients) {
    client.write(`data: ${JSON.stringify(data)}\n\n`);
  }
});
```

**Where:** `web.ts` SSE handler, `hooks.ts` event bus integration.

---

## Priority and Effort

| Item | Impact | Effort | Priority |
|------|--------|--------|----------|
| 2.1 OS notifications | HIGH | Small | **P0** |
| 2.2 Auto-execute action stages | HIGH | Medium | **P0** |
| 1.1 Prerequisite checker | HIGH | Small | **P0** |
| 3.1 Structured errors | HIGH | Medium | **P1** |
| 2.3 Flow pipeline visualization | MEDIUM | Small | **P1** |
| 4.2 Success toasts | MEDIUM | Small | **P1** |
| 1.2 First-run welcome | MEDIUM | Small | **P1** |
| 4.4 Stale hooks cleanup | MEDIUM | Small | **P1** |
| 3.2 Stale session detection | MEDIUM | Small | **P1** |
| 4.3 Empty state guidance | LOW | Small | **P2** |
| 4.1 Responsive layout | LOW | Medium | **P2** |
| 1.3 `ark init` wizard | LOW | Medium | **P2** |
| 1.4 Web auto-build | LOW | Small | **P2** |
| 5.1 Command palette | MEDIUM | Large | **P3** |
| 5.2 Agent progress parsing | MEDIUM | Medium | **P3** |
| 5.3 Web SSE push | LOW | Medium | **P3** |
| 2.4 Dispatch progress streaming | LOW | Large | **P3** |
| 3.3 Persistent error log | LOW | Medium | **P3** |

---

## Execution Plan

**Session 1 (P0 -- immediate impact):**
- 2.1 OS notifications on completion
- 2.2 Auto-execute action stages in flows
- 1.1 Prerequisite checker

**Session 2 (P1 -- trust and polish):**
- 3.1 Structured error messages
- 2.3 Flow pipeline visualization
- 4.2 Success toasts
- 1.2 First-run welcome
- 4.4 Stale hooks cleanup
- 3.2 Stale session detection

**Session 3 (P2 -- completeness):**
- 4.3 Empty state guidance
- 4.1 Responsive layout
- 1.3 `ark init` wizard
- 1.4 Web auto-build

**Session 4 (P3 -- differentiation):**
- 5.1 Command palette
- 5.2 Agent progress parsing
- 5.3 Web SSE push
