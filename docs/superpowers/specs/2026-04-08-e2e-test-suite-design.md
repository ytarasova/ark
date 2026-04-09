# E2E Test Suite Design -- Web UI + TUI

Comprehensive, flow-focused e2e tests for the Web UI and TUI surfaces.

## Goals

- Test real user workflows, not element existence
- Two tiers: fast (CRUD/UI, CI-safe) and slow (dispatch, tmux, worktrees)
- Unified `packages/e2e/` package owning all e2e tests
- Migrate existing TUI e2e tests into the new package
- Delete superseded desktop tests

## Package Structure

```
packages/e2e/
  playwright.config.ts          # Playwright config for web tests only
  fixtures/
    app.ts                      # Shared AppContext boot/teardown (evolved from e2e-setup.ts)
    web-server.ts               # Launch ark web + Playwright browser fixture
    tui-driver.ts               # TuiDriver class (moved from tui/__tests__)
    session-factory.ts          # Create sessions with defaults, track for cleanup
  web/
    navigation.spec.ts          # Sidebar, tabs, SSE, API health (fast)
    sessions.spec.ts            # Session CRUD: create, filter, search, delete, clone, archive (fast)
    session-detail.spec.ts      # Detail panel, todos, messages, actions, export/import (fast)
    agents-flows.spec.ts        # Agent/flow listing and management (fast)
    compute.spec.ts             # Compute CRUD (fast)
    dispatch.spec.ts            # Dispatch, live output, stop/resume (slow)
  tui/
    tabs.test.ts                # Tab switching, per-tab content, status bar hints (fast)
    sessions.test.ts            # Session list nav (j/k), detail pane, status labels (fast)
    session-crud.test.ts        # New session (n), delete (x), clone (c), group (m/g), archive (Z) (fast)
    talk.test.ts                # Talk to agent (t), inbox (i) (fast)
    dispatch.test.ts            # Dispatch (Enter), output, stop (s), interrupt (I), resume (slow)
    worktree.test.ts            # Worktree overlay (W), diff, merge/PR options (slow)
```

## Test Tiers

**Fast tier** -- No tmux, no git worktrees, no real agent dispatch. Tests session CRUD via API, UI interactions, navigation, forms. Safe for CI.

**Slow tier (dispatch)** -- Dispatches to local compute, verifies tmux session creation, live output, worktree operations. Requires tmux + git.

## Makefile Targets

```makefile
test-e2e:       # all e2e (fast + slow, sequential)
test-e2e-fast:  # fast tier only (CI-safe)
test-e2e-web:   # web tests only (Playwright)
test-e2e-tui:   # TUI tests only (bun test)
```

## Fixtures

### `fixtures/app.ts`

Evolved from existing `packages/tui/__tests__/e2e-setup.ts`. Provides:

- `setupE2E()` -- boots `AppContext.forTest()` with isolated temp DB + dirs
- Creates isolated git workdir with initial commit
- Tracks tmux sessions and session IDs for automatic cleanup
- `teardown()` -- kills tmux sessions, shuts down AppContext, removes temp dirs

Used by both TUI tests (directly) and web tests (indirectly via web-server fixture).

### `fixtures/web-server.ts`

Boots `ark web` subprocess for Playwright tests:

- Calls `setupE2E()` to get isolated AppContext + temp dir
- Spawns `ark web --port <random>` with `ARK_TEST_DIR=<temp dir>` env var
- Both Playwright browser and the web server share the same isolated DB
- Polls `/api/status` until server is ready (20s timeout)
- Returns `{ port, baseUrl, app, env }` for test use
- Teardown: kills subprocess, calls `env.teardown()`

### `fixtures/tui-driver.ts`

Moved from `packages/tui/__tests__/tui-driver.ts`. The existing TuiDriver class unchanged. Accepts env vars in constructor options -- tests pass `ARK_TEST_DIR` to isolate.

### `fixtures/session-factory.ts`

Helper for creating sessions with sensible defaults:

```ts
createTestSession(app, { summary?, repo?, flow?, group_name?, status? })
```

- Creates session via `app.sessionService.start()`
- Returns session object
- For slow tier: accepts a pre-created git workdir path as `repo`

## Web UI Test Flows

### `web/navigation.spec.ts` (fast)

- Sidebar renders with all 9 nav items
- Click each nav item, verify correct page loads with meaningful content
- SSE event stream connects on page load
- API health: status, sessions, agents, flows, compute endpoints respond with correct shapes

### `web/sessions.spec.ts` (fast)

- **Create session**: Open New Session modal, fill summary + repo + flow, submit, verify session appears in list
- **Filter by status**: Create sessions in different states via API, click Running/Failed/All filters, verify list updates correctly
- **Search**: Create sessions with distinct summaries, type in search input, verify filtered results
- **Group filter**: Create sessions in groups, filter by group, verify scoping
- **Delete + undelete**: Delete session, verify removed from list, undelete, verify restored
- **Clone**: Clone existing session, verify new session appears with same config
- **Archive + restore**: Archive completed session, verify hidden from list, restore, verify visible again

### `web/session-detail.spec.ts` (fast)

- **View detail**: Click session in list, verify detail panel shows ID, status, flow, repo, timestamps
- **Todos**: Add todo item, verify appears, toggle complete, delete, verify removed
- **Send message**: Type message in input, send, verify appears in conversation
- **Actions**: For sessions in appropriate states -- stop, restart, complete, pause, interrupt buttons trigger correct status transitions (verified via API)
- **Export/import**: Export session as JSON, import it back, verify round-trip preserves data

### `web/agents-flows.spec.ts` (fast)

- List agents page shows builtin agents (planner, implementer, reviewer, etc.)
- List flows page shows builtin flows (default, quick, bare, parallel)
- Click flow, verify stages render with agent assignments

### `web/compute.spec.ts` (fast)

- Compute page shows "local" compute as running
- Create new compute target, verify appears in list
- Delete compute, verify removed from list

### `web/dispatch.spec.ts` (slow)

- **Full dispatch**: Create session with real git repo, click dispatch, verify status transitions to "running", verify tmux session created via API
- **Live output**: After dispatch, poll output endpoint, verify non-empty content
- **Stop**: Dispatch then stop via UI, verify status goes to "stopped"
- **Resume**: Stop then restart via UI, verify status returns to "running"

## TUI Test Flows

### `tui/tabs.test.ts` (fast)

- Launch TUI, verify tab bar shows all 6 tabs (Sessions, Agents, Tools, Flows, History, Compute)
- Press 1-6, verify body content changes for each tab
- Agents tab shows builtin agent names in list
- Flows tab shows builtin flow names
- Compute tab shows "local" compute as running
- Status bar key hints update per active tab

### `tui/sessions.test.ts` (fast)

- Create sessions via API, verify they appear in list pane
- Navigate with j/k, verify selection moves and detail pane updates
- Tab to detail pane, verify shows session info (ID, flow, status, repo)
- Tab back to list pane, verify list retains selection
- Sessions with different statuses show correct labels in list
- Orphan cleanup: create stale tmux session, verify TUI reconciles it

### `tui/session-crud.test.ts` (fast)

- **New session**: Press 'n', type summary, set repo, select flow, press Enter, verify session appears
- **Delete**: Select session, press 'x' twice, verify removed from list
- **Clone**: Select session, press 'c', verify new session appears
- **Move to group**: Press 'm', create/select group, verify session moves
- **Group manager**: Press 'g', verify overlay opens, create group, delete group
- **Archive/restore**: Complete a session via API, press 'Z', verify hidden, press 'Z' on archived, verify restored

### `tui/talk.test.ts` (fast)

- Create session in "waiting" state via API
- Select session, press 't', type message, press Enter
- Verify message persisted (check via API)
- Press 'i', verify inbox overlay opens, press Esc to close

### `tui/dispatch.test.ts` (slow)

- **Dispatch**: Create session with real git repo, press Enter, verify status shows "running", verify tmux session exists
- **Live output**: Tab to detail pane, verify output section shows content
- **Stop**: Press 's', verify status changes to "stopped"
- **Interrupt**: Dispatch, press 'I', verify agent receives interrupt
- **Resume**: After stop, press Enter, verify running again
- **Verification**: Press 'V', verify verification gate runs

### `tui/worktree.test.ts` (slow)

- Dispatch session with real git repo (creates worktree automatically)
- Press 'W', verify worktree overlay shows diff stats
- Verify merge/PR option buttons visible in overlay
- Esc to close, complete and clean up

## Migration Plan

### Files moved into `packages/e2e/`

| Source | Destination |
|---|---|
| `packages/tui/__tests__/e2e-setup.ts` | `packages/e2e/fixtures/app.ts` |
| `packages/tui/__tests__/tui-driver.ts` | `packages/e2e/fixtures/tui-driver.ts` |
| `packages/tui/__tests__/e2e-tui-real.test.ts` | Split into `tui/tabs.test.ts` + `tui/sessions.test.ts` |
| `packages/tui/__tests__/e2e-tui-dispatch.test.ts` | Merged into `tui/dispatch.test.ts` |
| `packages/tui/__tests__/e2e-attach-tui.test.ts` | Merged into `tui/dispatch.test.ts` |
| `packages/tui/__tests__/e2e-session-flow.test.ts` | Merged into `tui/session-crud.test.ts` |
| `packages/tui/__tests__/e2e-attach.test.ts` | Merged into `tui/dispatch.test.ts` |

### Files deleted

| File | Reason |
|---|---|
| `packages/desktop/tests/app.spec.ts` | Superseded by `web/navigation.spec.ts` + `web/sessions.spec.ts` |
| `packages/tui/__tests__/e2e-*.test.ts` | Moved to `packages/e2e/tui/` |
| `packages/tui/__tests__/e2e-setup.ts` | Moved to `packages/e2e/fixtures/app.ts` |
| `packages/tui/__tests__/tui-driver.ts` | Moved to `packages/e2e/fixtures/tui-driver.ts` |

### Files unchanged

| File | Reason |
|---|---|
| `packages/core/__tests__/e2e-*.test.ts` | Core business logic tests, not UI surface tests |
| `packages/compute/__tests__/e2e-*.test.ts` | Compute provider tests, not UI surface tests |
| `packages/server/__tests__/integration.test.ts` | Protocol integration, not UI |
| `packages/desktop/playwright.config.ts` | Kept for desktop-specific tests if needed later |

## Test Isolation

All tests use isolated state:

- **Database**: `AppContext.forTest()` creates temp dir with fresh SQLite DB
- **Web server**: `ARK_TEST_DIR` env var points subprocess at test DB
- **TUI**: `ARK_TEST_DIR` env var passed via TuiDriver constructor
- **Git**: Fresh temp repo with initial commit per test suite
- **Tmux**: Tracked session names, killed in teardown
- **Ports**: Random port for web server, conductor ports use test offsets

## Playwright Config

```ts
// packages/e2e/playwright.config.ts
{
  testDir: "./web",
  timeout: 60_000,
  retries: 0,
  workers: 1,            // Sequential -- shared server + DB
  reporter: "list",
  use: { trace: "on-first-retry" },
  // globalSetup / globalTeardown boot ark web
}
```

TUI tests run via `bun test` (not Playwright). The Playwright config only covers `web/`.
