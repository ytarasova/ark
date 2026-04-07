# Changelog

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
