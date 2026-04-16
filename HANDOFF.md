# Session Handoff -- Apr 12-14, 2026 (updated Apr 14 post-meeting)

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
- **Daemon-client**: `make dev-daemon` (hot-reload) + `make dev-web`
- **Action stages**: create_pr and auto_merge execute reliably (await safeAsync + branch check)
- **Knowledge graph**: codegraph indexes codebase, nodes ingested into knowledge store, context injected at dispatch
- **Prompt caching**: 99.9% cache hit rate, $3,430 saved (86% reduction) across 47 sessions
- **Web UI**: contextual session controls, auto-refresh polling, toast notifications, deep links, flow docs

> Note: TUI (`ark tui`, `packages/tui/`, `packages/tui-e2e/`) was removed in v0.16.0 (2026-04-15). Historical entries below describe shipments that happened before removal -- they are retained as history.

## Known issues

### Critical
1. **Orphan bun test processes**: session stop kills tracked PIDs but processes spawned before the fix still leak. Need a periodic reaper (every 60s scan for orphan `bun test` processes not attached to any running session).
2. **Session rows disappearing from DB**: s-4459fc vanished from sessions table. Data integrity issue -- needs investigation.

### Important
3. **Web UI session list doesn't auto-refresh in all cases**: polling is 5s but SSE would be better for real-time updates.
4. **Web UI needs conversation interface**: no way to send messages to agents from web UI (currently only works via CLI). Zineng flagged this as a blocker for his workflow.
5. **Web UI needs repo dropdown**: users must type repo paths manually. Should list known repos from session history / Claude projects.
6. **Stage timeline in session detail**: doesn't show completed/failed icons or elapsed times per stage.
7. **Compute details overlapping** in web UI detail pane.
8. **Rework loop error context injection**: never completed (dispatch failed). Agent retry prompt should include previous error.
9. **Cost tracking numbers may not be accurate**: subscription mode costs are approximations, not real billing data. Abhimanyu flagged this.

### Nice to have
10. **Orphan worktree cleanup**: `~/.ark/worktrees/` accumulates worktrees from completed/failed sessions.
11. **Event-sourced session state**: sessions should be rebuildable from events (crash recovery).
12. **Native skill support in dispatched sessions**: skills like superpowers should be available to dispatched agents. May have regressed -- needs investigation.

## Apr 14 meeting decisions (ark init -- Yana, Zineng, Abhimanyu, Atul)

### TUI retirement (consensus)
- **Drop TUI** from the product surface. Focus on **Web UI + CLI + Electron desktop app**.
- TUI is the most expensive surface to maintain, hardest to test, and least intuitive for new users (Zineng: "I spend half an hour and I don't know what to do").
- Yana: "let's not spend time on text UI. I'm happy not to."
- TUI code was fully deleted in v0.16.0 (2026-04-15).

### Web UI is the primary interface
- Everything should be doable from web UI without touching CLI.
- Missing features flagged: **conversation interface** (send messages to agents), **repo dropdown** (pick from known repos), **session creation wizard**.
- Web UI needs polish but is surprisingly functional already.

### Desktop app (near-term deliverable)
- Wrap web UI in Electron (already prototyped in `packages/desktop/`) or Tauri v2 (https://v2.tauri.app/ -- smaller binaries, Rust backend).
- Build for: macOS Intel, macOS ARM, Linux Intel, Linux ARM. No Windows.
- Not signed (acceptable for internal distribution).
- DMG packaging was started but dropped midway -- needs completion.
- Zineng flagged Tauri as worth evaluating: ~10x smaller binaries than Electron, but requires Rust toolchain and uses system webview (rendering inconsistencies possible).

### ACP (Agent Communication Protocol) -- POC
- Abhimanyu raised ACP as a standard agent interface. Goose uses it via Claude SDP adapter.
- Yana open to exploring: "we can run a quick POC on this."
- Caveat: Claude Code and Codex don't officially support ACP. Only Gemini has native support.
- Decision: explore as a parallel interface alongside channels, not a replacement.

### MiniMax as cheap model for mechanical tasks
- ~1/10th cost of Claude, ~90% performance for routine tasks.
- Strategy: **plan with Opus/Sonnet, implement with MiniMax** for trivial/mechanical work.
- Abhimanyu shared API key (input: $0.30/Mtok, output: $1.00/Mtok vs Claude's $25 output).
- Needs: OpenAI-compatible custom provider support in LLM Router.

### GLM model evaluation
- Benchmarks show GLM may compete with Opus on certain tasks.
- Abhimanyu exploring via Goose provider integration.

### Benchmarking framework (Abhimanyu)
- Building task-based benchmarks: 100 real-world tasks on actual repos (not just prompting).
- Categories: JWT updates, code graph, PR review, MCP tool calling.
- Multi-model comparison: Claude, MiniMax, GLM, Haiku, Sonnet.
- Results could feed into **LLM Router routing decisions** (model X is good at tool calling, model Y is good at PR review).

### Multi-repo (investigation)
- Abhimanyu sharing 2 repos: mock server + consumer (connected via package.json dependency).
- Yana needs to look at the actual setup before designing the multi-repo feature.

### Stay on GitHub
- Free GitHub Actions, macOS runners for DMG builds, public repo benefits.
- No move to Bitbucket for now.

### Team assignments
- **Yana**: core architecture, taking break until Thursday (2026-04-17). "Consultant mode" rest of week.
- **Zineng**: orienting on the codebase. Interested in monitoring/observability use case. First task: web UI improvements (repo dropdown, conversation interface).
- **Abhimanyu**: MiniMax/GLM benchmarking, ACP exploration, multi-repo setup sharing, Goose expertise.
- **Atul**: leadership adoption tracking, scheduling twice-weekly syncs.
- Meet again Apr 15 to discuss roadmap after Zineng/Abhimanyu orient.

## Suggested next steps (priority order)

### P0 -- Ship blockers for pilot (this week)
1. **Web UI conversation interface**: add send-message capability so users can interact with agents from web UI (Zineng blocker).
2. **Web UI repo dropdown**: list known repos from session history / Claude projects directory.
3. **Orphan process reaper**: periodic scan + kill in conductor. 30 lines.
4. **Electron desktop app**: complete DMG packaging for macOS (Intel + ARM) and Linux (Intel + ARM).

### P1 -- Stability + model support
5. **MiniMax/custom provider in LLM Router**: accept arbitrary OpenAI-compatible base URL + key with cost_mode=free for self-hosted.
6. **SSE event stream on conductor**: replace polling with push updates for web/Claude Code.
7. **Session DB integrity**: investigate why sessions vanish. Add WAL checkpoint on shutdown.
8. **Rework loop error injection**: dispatch with `--flow quick` to skip planning overhead.

### P2 -- Features
9. **ACP POC**: spike on Agent Communication Protocol as a parallel agent interface.
10. **Benchmarking integration**: connect Abhimanyu's benchmark results to LLM Router routing weights.
11. **Knowledge graph bi-directional**: re-index after implement stage so verifier/reviewer gets fresh context.
12. **Multi-repo sessions**: investigate Abhimanyu's 2-repo setup, then extend Session.repo.

### P3 -- Polish
13. **Web UI facelift**: borrow design patterns from v0 mockups (the aspirational Electron version from Nov 2025).
14. **Native skill support in dispatched sessions**: verify skills like superpowers are available to agents.
15. **ISLC recipe audit**: Yana + Abhimanyu decision still pending.

## Dev workflow

```bash
# Development (2 terminals)
make dev-daemon    # terminal 1: hot-reload daemon (conductor + arkd + WS)
make dev-web       # terminal 2: API + Vite frontend (Web UI)

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
2. **Web UI is the primary interface** (daemon owns state, web connects via SSE/REST)
3. **Action stages are awaited** (`await safeAsync`, not fire-and-forget)
4. **Planner uses opus** (sonnet hit context limits on complex tasks)
5. **PostCompact hook re-injects task** (prevents context loss after compaction)

### Added Apr 14 (ark init meeting)

6. **TUI retired** -- removed in v0.16.0. Product surfaces: Web UI + CLI + Electron desktop.
7. **Web UI is the primary interface** -- everything doable from web without touching CLI.
8. **Channels remain the Claude Code path** -- ACP is exploratory, not a replacement.
9. **Hierarchical config: builtin -> tenant -> user** -- confirmed for flows, skills, agents, MCPs, compute.
10. **Conductor is the single gateway** -- all state behind conductor. Web, CLI, Electron, Claude Code all talk to conductor.
11. **Arkd is per-compute agent manager** -- installs on every compute target, manages agent lifecycle, proxies MCP.
12. **Plan with Opus, implement with cheap models** -- LLM Router should support this split.
13. **Stay on GitHub** -- free CI with macOS runners, no Bitbucket migration.

### Added Apr 14 (post-meeting, Open Agents analysis)

14. **Decoupled compute architecture (target)** -- separate agent fleet from compute fleet. Current: Session 1:1 Agent 1:1 Compute. Target: Session 1:N Agent 1:M Compute. Agents are cheap/stateless (just LLM loop), compute is expensive/persistent (repo, tools, dev servers). Scale independently, hibernate compute without losing agent state. Inspired by Open Agents' "agent outside sandbox" pattern. Arkd is already the network boundary -- extend it.
15. **Compute lifecycle: hibernate/snapshot/restore** -- compute targets should support hibernate (stop billing), snapshot (save state), restore (resume from snapshot). E2B already supports snapshots. EC2 has AMIs. Docker has commit/checkpoint. Firecracker has snapshotting. Expose this universally.
16. **Web UI needs production-grade overhaul** -- borrow heavily from Open Agents (tool call renderers, git panel, todo panel, structured questions, model selector, contribution charts, stream recovery). Current web UI is ~6K lines, theirs is ~43K. Gap is significant.
