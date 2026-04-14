# Session Handoff -- Apr 12-14, 2026

## What was done

### PRs merged (20 total)
| PR | Feature | Source |
|----|---------|--------|
| #53 | Repo path fix + arkd report pipeline | Manual |
| #62 | Bug-sweep: 32 test failures fixed | Agent |
| #63 | God class refactor (session-hooks.ts extracted) | Agent |
| #65 | Worktree untracked file setup (.ark.yaml copy/setup) | Agent |
| #66 | Process tree tracking (PIDs per session) | Agent |
| #67 | auto_merge waits for CI (pr-merge-poller) | Agent |
| #68 | Unify flow routing (depends_on -> implicit edges) | Agent |
| #69 | Action stage chaining fix | Agent |
| #70 | Daemon-client architecture (TUI as thin WS client) | Agent |
| #71 | Unified Claude settings bundle | Agent |
| #73 | TreeList rewrite (proper tree + ink-scroll-list) | Agent |
| #75 | Session detail pane fixes | Agent |
| #76 | Events tab (moved from bottom panel) | Agent |
| #77 | Hot-reload dev targets | Agent |
| #78 | Async audit (unawaited promises) | Agent |
| #79 | CHANGELOG.md overhaul | Agent |
| #80 | Settings docs link fix | Agent |
| #81 | Web UI overhaul (controls, polling, toasts, deep links) | Agent |
| #82 | Docs completeness pass | Agent |
| #83 | CONTRIBUTING.md + docs updates | Agent |

### Direct commits on main
- `await safeAsync` for action stages
- `create_pr` skips if PR exists (checks branch via `gh pr view`)
- Auto-merge chain respects waiting status
- Session stop kills tracked process trees
- markRead on terminal states
- Selection stability on delete/archive
- SessionsTab state preservation (display=none)
- Costs tab key (0)
- SplitPane AvailableHeightContext
- ScrollBox rewrite (useVirtualScroll -> ink-scroll-list)
- Planner upgraded to opus + PostCompact task re-injection
- Stale hook event guard
- Status poller for all runtimes (crash detection)
- Removed stale MCP server refs from agents
- Docs flow (plan -> implement -> PR, 3 stages)
- v0.13.0 + v0.14.0 releases

## What works now

- **Ark-on-Ark dogfooding**: dispatch sessions that plan, implement, verify, review, create PR, and merge autonomously
- **Daemon-client**: `make dev-daemon` (hot-reload) + `make dev-tui` / `make dev-web`
- **Action stages**: create_pr and auto_merge execute reliably (await safeAsync + branch check)
- **Knowledge graph**: codegraph indexes codebase, nodes ingested into knowledge store, context injected at dispatch
- **Prompt caching**: 99.9% cache hit rate, $3,430 saved (86% reduction) across 47 sessions
- **TUI**: group headers visible, Events tab, Costs tab (0), stable scroll (ink-scroll-list)
- **Web UI**: contextual session controls, auto-refresh polling, toast notifications, deep links, flow docs

## Known issues

### Critical
1. **Orphan bun test processes**: session stop kills tracked PIDs but processes spawned before the fix still leak. Need a periodic reaper (every 60s scan for orphan `bun test` processes not attached to any running session).
2. **TUI crashes**: exit logging added but no crashes captured yet. Suspected cause was orphan process CPU exhaustion (now fixed).
3. **Session rows disappearing from DB**: s-4459fc vanished from sessions table. Data integrity issue -- needs investigation.

### Important
4. **Web UI session list doesn't auto-refresh in all cases**: polling is 5s but SSE would be better for real-time updates
5. **Stage timeline in session detail**: doesn't show completed/failed icons or elapsed times per stage
6. **Compute details overlapping** in web UI detail pane
7. **Rework loop error context injection**: never completed (dispatch failed). Agent retry prompt should include previous error.

### Nice to have
8. **Hot-reload for TUI**: currently only daemon hot-reloads. TUI needs restart.
9. **Orphan worktree cleanup**: `~/.ark/worktrees/` accumulates worktrees from completed/failed sessions
10. **Event-sourced session state**: sessions should be rebuildable from events (crash recovery)

## Suggested next steps (priority order)

### P0 -- Ship blockers for pilot (this week)
1. **Orphan process reaper**: periodic scan + kill in conductor. 30 lines.
2. **Rework loop error injection**: dispatch with `--flow quick` to skip planning overhead
3. **ISLC recipe audit**: Yana + Abhimanyu decision still pending

### P1 -- Stability
4. **SSE event stream on conductor**: replace polling with push updates for TUI/web/Claude Code
5. **Session DB integrity**: investigate why sessions vanish. Add WAL checkpoint on shutdown.
6. **E2E test for full autonomous-sdlc flow**: seed -> dispatch -> verify all stages complete -> PR merged

### P2 -- Features
7. **Knowledge graph bi-directional**: re-index after implement stage so verifier/reviewer gets fresh context. Measure token savings.
8. **Multi-repo sessions**: extend Session.repo to support N repos
9. **Pre-engineering flows**: ideate -> PRD pipeline for PMs

### P3 -- Polish
10. **Web UI parity with TUI**: stage timeline icons, compute metrics, session replay
11. **Desktop app**: fix .dmg packaging (currently broken)
12. **i18n framework**: English only for now

## Dev workflow

```bash
# Development (3 terminals)
make dev-daemon    # terminal 1: hot-reload daemon (conductor + arkd + WS)
make dev-tui       # terminal 2: TUI connects to daemon
make dev-web       # terminal 3: API + Vite frontend

# Standalone (1 terminal, no hot-reload)
make tui-standalone

# Dispatch work via Ark
ark session start --flow autonomous-sdlc --repo . --summary "description" --dispatch
ark session start --flow docs --repo . --summary "update README" --dispatch
ark session start --flow quick --repo . --summary "quick fix" --dispatch

# Monitor
ark session list
ark session events <id>
tmux attach -t ark-s-<id>
```

## Key architecture decisions locked in this session

1. **Agents always route through arkd** (single path, no conductor fallback)
2. **TUI is a thin client** (daemon owns state, TUI connects via WS)
3. **TreeList is a proper tree** (groups are parent nodes, not flat array with headers)
4. **ScrollBox uses ink-scroll-list** (no manual row counting)
5. **SplitPane provides height via context** (AvailableHeightContext)
6. **Action stages are awaited** (`await safeAsync`, not fire-and-forget)
7. **Planner uses opus** (sonnet hit context limits on complex tasks)
8. **PostCompact hook re-injects task** (prevents context loss after compaction)
