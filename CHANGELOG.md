# Changelog

## v0.10.0 (2026-04-07)

### New Features
- **Generic CLI agent executor**: run ANY CLI coding tool (Codex, Gemini, Aider, Cursor Agent, OpenCode, Pi, Amp, etc.) in tmux with worktree isolation. Agent YAML: `runtime: cli-agent`, `command: ["tool", "args"]`, `task_delivery: stdin|file|arg`
- **Electron desktop app**: native macOS/Windows/Linux app wrapping the Web UI. `make desktop` to launch, `make desktop-build` to package for distribution
- **Status poller**: non-Claude executors get automatic session status detection via 3-second tmux polling
- **Builtin agent definitions**: codex-worker, gemini-worker, aider-worker, generic-cli

### Usage
```bash
ark session start --repo . --summary "Fix bug" --agent codex-worker --dispatch
ark session start --repo . --summary "Refactor" --agent aider-worker --dispatch
make desktop   # Launch Electron app
```

## v0.9.1 (2026-04-07)

### Product Excellence
- **OS notifications**: stage completion/failure triggers terminal-notifier or terminal bell
- **Auto-execute action stages**: flow action stages (create_pr, merge, close) now execute automatically with verification enforcement
- **Prerequisite checker**: `ark doctor` command; guards on `session start` and `tui` for missing tmux/git/claude
- **Flow pipeline visualization**: TUI SessionDetail shows `plan > [implement] > pr > review` with current stage highlighted
- **First-run welcome**: TUI shows getting-started hints when no sessions exist
- **Success toasts**: inline status bar confirmation for all async operations
- **Stale session detection**: orphaned running sessions detected and marked failed on boot
- **Stale hooks cleanup**: removes orphaned `.claude/settings.local.json` on boot
- **Structured error messages**: recovery hints on common error paths
- **Empty state guidance**: helpful placeholders in SessionDetail sections
- **Responsive layout**: session list adapts to terminal width
- **`ark init` wizard**: prerequisite check + auth check + .ark.yaml stub creation
- **Web auto-build**: `ark web` auto-builds frontend if dist/ is missing
- **Agent progress parsing**: structured labels from tmux output (Working/Reading/Writing)
- **Web SSE push**: event-driven broadcast on state changes (replaces 3s polling)
- **Help overlay grouped**: reorganized into Session Actions / Navigation / Tools / Filters sections

### Fixes
- **Config YAML loading**: `~/.ark/config.yaml` now actually loaded (hotkeys, budgets, theme, otlp, rollback, telemetry, default_compute)
- **Notifications**: uses terminal-notifier (no Script Editor permission dialog) with bell fallback

## v0.9.0 (2026-04-07)

### New Features
- **Verification gates**: `verify` field on flow stages defines scripts that must pass before completion. Todos block completion too. Enforced automatically when agents report completed. (`ark session verify`, `ark session todo`)
- **Auto-PR creation**: agents auto-push branch and create GitHub PR on completion via `gh pr create`. Disable with `auto_pr: false` in `.ark.yaml`. Manual: `ark worktree pr`
- **Agent interrupt**: send Ctrl+C to pause a running agent without killing the session (`ark session interrupt`, TUI: `I`)
- **Diff preview**: view git diff stat before merging or creating PRs (`ark worktree diff`, TUI: `W` overlay)
- **Session archive/restore**: archive completed sessions for long-term reference (`ark session archive/restore`, TUI: `Z`)
- **Web UI scheduling page**: full CRUD for cron schedules with sidebar nav
- **Web UI compute lifecycle**: provision, start, stop, destroy compute from the browser
- **Web UI session actions**: pause, advance, complete, fork, send message buttons

### Architecture
- **Zero `as any` casts**: eliminated all 228 casts (84 production + 144 test) with typed interfaces, RpcError class, WeakMap for WebSocket metadata, SessionConfig interface, mock helpers
- **Broken circular import**: extracted `provider-registry.ts` from the `app.ts` <-> `session-orchestration.ts` cycle
- **Shared URL constants**: `constants.ts` replaces 7+ hardcoded `localhost:19100` strings
- **TodoRepository**: new repository for verification checklist persistence
- **RpcError class**: replaces `(err as any).code` mutation pattern across server/protocol

### Test Infrastructure
- Fixed Makefile `test` target (concurrency flag parsing)
- Added tmux cleanup helpers (`snapshotArkTmuxSessions`/`killNewArkTmuxSessions`)
- Fixed 13 pre-existing test failures
- 39 new tests for conductor gap features
- `mockSession()`/`mockCompute()` typed test helpers
- 2239 tests, 0 fail, 0 skip

### Bug Fixes
- Fixed orphaned tmux sessions accumulating across test runs
- Fixed `complete()` nulling session_id before tmux cleanup
- Fixed duplicate imports in 4 test files
- Fixed `ArkClient.close()` causing unhandled rejections during teardown
- Replaced `console.log` in arkd and ec2 provision with structured logging

## v0.8.0

Previous release.
