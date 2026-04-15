# Changelog

## v0.15.5 (2026-04-15)

### Desktop App
- **Health probe endpoint**: added `GET /api/health` to the web server (`packages/core/hosted/web.ts`) returning `{ ok, version, uptime }`. Unauthenticated, no DB hits, safe to call before token auth is configured. The desktop main process (`packages/desktop/main.js`) now probes this endpoint instead of the nonexistent `/api/status`, eliminating the spurious "Startup Error: The Ark server failed to start within 15 seconds" dialog that appeared on every launch even though the server was up.
- **Daemon auto-start**: new `--with-daemon` flag on `ark web` (`packages/cli/commands/misc.ts`) starts the conductor (:19100) and arkd (:19300) in-process before serving the dashboard. The desktop app now passes this flag, so launching Ark Desktop gives the user a fully working instance with no manual `ark daemon start` required. Dashboard "System Health" widget shows Conductor and ArkD as online out of the box. If the user already has external daemons running on those ports, `--with-daemon` detects them via a `/health` probe and reuses them instead of failing. Both daemons shut down cleanly when the desktop app quits (SIGTERM handler).
- **Traffic-light overlap fix**: macOS native window controls (red/yellow/green) no longer cover the "ark" sidebar brand. `BrowserWindow` now uses `titleBarStyle: "hiddenInset"` on macOS (preserving native traffic-light position), and the preload script tags `<body>` with `is-electron` and `is-macos` classes so platform-specific CSS in `packages/web/src/styles.css` adds 22px of top padding to the sidebar header (clears the 28px traffic-light strip).

### Known Limitations (v0.15.5)
- Same as v0.15.4: unsigned macOS DMG, unsigned Windows installer, no auto-updater, no system tray, requires `ark` CLI on `PATH`.

## v0.15.4 (2026-04-15)

### Desktop App
- **Release pipeline**: fix `gh release create` glob in `.github/workflows/release.yml` so electron-builder artifacts actually reach the release. Previous `dist/ark-*` pattern matched only the lowercase Debian package; macOS `.dmg`/`.zip`, Windows `.exe`/`.zip`, and Linux `.AppImage` (all produced with capital A by electron-builder as `Ark-<ver>-*`) were silently dropped. Glob now covers `ark-*`, `Ark-*`, and `Ark Setup*`. Same fix applied to the rolling `latest` release upload.
- **Single-instance lock**: desktop app now calls `app.requestSingleInstanceLock()` in `packages/desktop/main.js`. A second launch no longer spawns a second `ark web` subprocess on a new port -- it focuses the existing window.
- **Install documentation**: new `packages/desktop/INSTALL.md` with platform downloads, the macOS Gatekeeper workaround (`xattr -dr com.apple.quarantine /Applications/Ark.app`) for the current unsigned build, and a full list of known limitations. Linked from root `README.md`.
- **Remove stale playwright config**: `packages/desktop/playwright.config.ts` referenced `./tests`, which was deleted in the e2e migration (commit `1c6cb94`). `npm test` no longer errors out in the desktop package; the `test` script and `@playwright/test` dev dependency were removed. A real desktop smoke test will come when e2e coverage is restored.

### Known Limitations (v0.15.4)
- No bundled `ark` CLI runtime -- desktop app still requires the Ark CLI on `PATH` (install via `curl -fsSL https://ytarasova.github.io/ark/install.sh | bash`). Tracked as a follow-up.
- Unsigned macOS DMG -- see `packages/desktop/INSTALL.md` for the Gatekeeper workaround. No Apple Developer certificate is configured in CI yet.
- Unsigned Windows installer -- SmartScreen warns about unverified publisher.
- No auto-updater, no system tray.

## v0.14.0 (2026-04-13)

### TUI
- **Events tab**: moved Events panel from session detail to its own dedicated tab (key `3`)
- **Virtual scrolling**: replaced custom ScrollBox with ink-scroll-view, extracted useVirtualScroll hook with AvailableHeightContext for proper height management
- **TreeList rewrite**: proper tree component with key-based selection, stable group headers
- **Selection stability**: selection stays stable after delete/archive, resets on group-by toggle
- **Layout fixes**: SplitPane content height via AvailableHeightContext, collapsed EventLog single-line

### Developer Experience
- **Hot-reload dev targets**: `make dev-daemon` and `make dev-arkd` for auto-restart on file changes
- **Dev mode checks**: `dev-tui` and `dev-web` check for running daemon before starting
- **Makefile cleanup**: renamed `make tui` to `tui-standalone`, clarified target descriptions

### Fixes
- **Action stages**: await safeAsync for action stages in mediateStageHandoff
- **Auto-PR dedup**: create_pr action skips if PR already exists
- **Message read state**: mark messages as read when session reaches terminal state
- **Costs tab**: accessible via key `0`

## v0.13.0 (2026-04-13)

### Daemon-Client Architecture
- **Server daemon**: TUI connects as thin WebSocket client to server daemon (port 19400) -- no in-process AppContext
- **Unified settings**: renamed writeHooksConfig to writeSettings (Claude settings bundle)
- **`ark daemon` CLI**: `ark daemon start/stop/status` commands for managing the server daemon
- **Web daemon detection**: `ark web` auto-detects running daemon

### Flow Engine
- **Autonomous SDLC flow**: plan -> implement -> verify -> review -> PR -> merge pipeline
- **Action stage chaining**: consecutive action stages (create_pr + auto_merge) chain correctly
- **Auto-merge CI wait**: auto_merge waits for CI checks before completing session
- **DAG conditional routing**: graph flow engine supports conditional edges based on stage outcome
- **On-outcome routing**: `on_outcome` field in flow stage definitions for branching
- **Orchestrator-mediated handoff**: stage transitions go through `mediateStageHandoff()`
- **DAG flow edges**: `depends_on` creates implicit graph-flow edges
- **On-failure retry loop**: wired `on_failure` retry in conductor DAG engine
- **Brainstorm flow**: interactive ideation flow for exploring ideas
- **Per-stage compute templates**: flow definitions can specify compute per stage
- **Stage isolation**: fresh runtime per stage for clean execution

### Agent System
- **Auto-start dispatch**: Claude, Codex, Gemini, and Goose agents start working immediately on dispatch (no manual prompt acceptance)
- **Tool enforcement**: `agent.tools` field enforced via Claude Code `permissions.allow`
- **Tool hints**: inject tool descriptions into agent system prompt
- **Commit-before-completion**: agents must commit before reporting completed
- **Per-stage commit verification**: tracks `stage_start_sha` to detect real changes
- **Optimized agent prompts**: all 12 agent prompts tuned for production quality
- **SessionEnd completion fallback**: agents complete even without explicit report

### Worktree Enhancements
- **Copy globs**: `worktree.copy` glob list for syncing untracked files to worktrees
- **Setup script**: `worktree.setup` script for post-creation initialization
- **MCP config merge**: `.mcp.json` from original repo merged into worktree
- **Auto-cleanup**: worktrees cleaned up on session stop and delete
- **Auto-rebase**: rebase onto base branch before PR creation

### Infrastructure
- **Status poller**: enabled for all runtimes (crash detection, not just Claude)
- **Hook/report extraction**: extracted hook/report status logic into session-hooks.ts
- **Process tree tracking**: executor tracks process tree when launching agents
- **Artifact tracking**: session store tracks artifacts produced by agents
- **Channel MCP always allowed**: ark-channel MCP tools always permitted in agent permissions
- **Stale hook filtering**: ignore hook events from previous stage agent sessions

### TUI
- **Group headers**: visible, distinct styling, scroll-to-header behavior
- **Session grouping by status**: group sessions by running/waiting/completed/failed
- **Status filter tabs (web)**: full status filter tabs in web session list
- **Stage timeline**: per-stage status timeline in SessionDetail pane
- **Delete confirmation**: visible confirmation message in Sessions tab
- **Friendly repo names**: display short repo name instead of full path
- **Chat thread shortcuts**: missing keyboard shortcuts added for chat threads
- **Filter reset**: Esc resets all session filters

### Documentation
- **Pilot onboarding guide**: getting started guide for new Ark users
- **Ark-on-Ark dogfooding**: instructions for using Ark to build Ark
- **Comprehensive docs suite**: 6 new documentation pages

### Testing
- **E2E completion paths**: tests for manual, auto, and hook-fallback completion
- **Gemini and Goose runtime tests**: verify autonomous dispatch works across runtimes
- **Stage validation tests**: e2e tests for stage commit verification
- **Resolved 8 root causes**: fixed pre-existing test failures across the suite

## v0.12.0 (2026-04-10)

### Knowledge Graph
- **Unified knowledge store**: nodes (file, symbol, session, memory, learning, skill, recipe, agent) and edges (depends_on, imports, modified_by, etc.) in SQLite
- **Codebase indexer**: `ark knowledge index --repo .` indexes files and symbols into the graph (Axon integration for symbol extraction)
- **Context builder**: automatically injects relevant knowledge into agent prompts at dispatch time
- **MCP tool handler**: agents can query the knowledge graph via MCP tools during execution
- **Markdown export/import**: `ark knowledge export` / `ark knowledge import` for portability
- **CLI commands**: `ark knowledge search/index/stats/remember/recall/export/import/ingest`
- **Old systems removed**: `memory.ts`, `learnings.ts`, `hybrid-search.ts` deleted -- all functionality migrated to knowledge graph

### LLM Router
- **OpenAI-compatible proxy**: `ark router start` serves `/v1/chat/completions` across multiple LLM providers
- **3 routing policies**: quality (best model), balanced (cost/quality tradeoff), cost (minimize spend)
- **Circuit breakers**: per-provider failure tracking with automatic fallback to healthy providers
- **Request classification**: classifies prompt complexity to select appropriate model tier
- **Cost tracking**: per-request cost accumulation; `ark router status` and `ark router costs` commands

### Control Plane & Hosted Mode
- **`ark server start --hosted`**: starts multi-tenant control plane with worker registry, session scheduler, and tenant policies
- **Worker registry**: workers register via HTTP, health-checked every 60s, stale workers pruned after 90s
- **Session scheduler**: assigns sessions to available workers, respects tenant policies
- **Tenant policies**: per-tenant allowed providers, default provider, max concurrent sessions, daily cost cap
- **CLI**: `ark tenant policy set/get/list/delete`
- **Redis SSE bus**: multi-instance event streaming via Redis pub/sub (falls back to in-memory)
- **IDatabase abstraction**: `database.ts` interface with SQLite (`database-sqlite.ts`) and PostgreSQL (`database-postgres.ts`) adapters

### Auth & Multi-Tenancy
- **API key auth**: `ark auth create-key/list-keys/revoke-key/rotate-key` commands
- **Tenant scoping**: API keys scoped to tenants, per-tenant AppContext in hosted mode
- **Role-based access**: admin, member, viewer roles with write/read permissions
- **Auth middleware**: extracts tenant context from Bearer tokens or query params

### Compute Providers
- **E2B provider**: managed Firecracker sandboxes via E2B SDK (sub-second boot, full isolation)
- **K8s provider**: Kubernetes pods for agent execution, with optional Kata Containers (Firecracker microVM isolation)
- **7 total providers**: local, docker, devcontainer, firecracker, ec2+arkd, e2b, k8s+kata

### SDLC Pipeline
- **ISLC flow**: full 7-stage pipeline (intake, plan, audit, execute, verify, close, retro)
- **12 agents**: ticket-intake, spec-planner, plan-auditor, task-implementer, verifier, closer, retro (added to existing planner, implementer, reviewer, documenter, worker)
- **7 skills**: code-review, plan-audit, sanity-gate, security-scan, self-review, spec-extraction, test-writing
- **Runtime/role separation**: agents define WHAT (role, prompt, skills), runtimes define HOW (LLM backend, command). Override at dispatch with `--runtime codex`

### Dashboard & Web
- **Dashboard command**: `ark dashboard` shows fleet status, costs (today/week/month), budget progress, recent activity, system health
- **Web dashboard page**: DashboardView with cost charts (Recharts), fleet status counts, budget bar
- **MCP config stubs**: pre-configured `.mcp.json` templates for Atlassian, GitHub, Linear, Figma

### Remote Client Mode
- **`--server`/`--token` flags**: CLI, TUI, and Web can connect to a remote Ark control plane
- **`ARK_SERVER`/`ARK_TOKEN` env vars**: alternative to CLI flags
- **WebSocket client**: remote mode uses typed WebSocket ArkClient instead of local AppContext

### Deployment
- **Dockerfile**: production container image for Ark
- **docker-compose.yaml**: Ark + PostgreSQL + Redis stack
- **Helm chart**: `.infra/helm/ark/` with control plane, worker pool, PostgreSQL, Redis, Ingress
- **Production values**: `.infra/helm/ark/values-production.yaml` with Kata/Firecracker runtime class

### Documentation
- **Comprehensive rewrite**: all docs updated to reflect current platform state

## v0.11.0 (2026-04-09)

### Code Quality & Security
- **Shell injection protection**: added `shellEscape()` for all SSH command interpolation in EC2 provider
- **OAuth token safety**: base64-encode tokens before remote shell interpolation
- **Validation bypass fix**: server handlers now pass only validated fields to save functions
- **Auth-aware fetch**: web UI schedule/session forms now use authenticated API calls instead of raw fetch
- **ES module compliance**: replaced all `require()` calls (11 sites) and `__dirname` usage (2 sites) with proper ES module patterns
- **React hooks fix**: fixed Rules of Hooks violation in TUI HistoryDetail component
- **ArkD bind address**: arkd now accepts `--hostname` option, defaults to `0.0.0.0` for remote accessibility
- **AppContext lifecycle**: `shutdown()` clears singleton, `todos` accessor initialized at boot

### Code Cleanup
- **CLI deduplication**: fork/clone handlers unified, server start AppContext leak fixed, exec singleton overwrite fixed
- **TUI improvements**: useArkStore running guard in `finally` block, attach logic deduplicated, buildHistoryItems memoized, focus stack mass-pop replaced with targeted pop, useEffect dependencies corrected
- **Web error handling**: try/catch added to all action handlers across SessionDetail, AgentsView, FlowsView, ScheduleView
- **Compute deduplication**: Docker provision logic extracted to shared helpers, clean/clean-zombies handlers unified
- **Search optimization**: extracted `readTranscriptTail` helper, fixed stale 64KB comment
- **Shared styles**: extracted `selectClassName` to shared module across 5 web components
- **Structured logging**: `safeAsync` now uses `logError` instead of `console.error`
- **Em dash cleanup**: replaced all U+2014 em dashes with `--` per code style

### Documentation
- **README rewrite**: improved pitch and positioning, updated architecture and features
- **Web UI guide**: comprehensive documentation of all web dashboard views and interactions
- **CLI reference**: added 10+ missing commands (doctor, init, costs-export, openapi, acp, repo-map, eval, worktree cleanup, spawn-subagent)
- **CLI agent docs**: documented multi-tool support (Codex, Gemini, Aider, etc.)

### Testing
- **45 new tests** across 8 new test files covering shell escaping, validation, client lifecycle, app lifecycle, store recovery, and more
- **2233 total tests**, 0 failures

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

## v0.8.0 (2026-04-05)

### JSON-RPC Protocol
- **Protocol server**: `packages/server/` with router and notification system serving session lifecycle, resource queries, config, history, tools, and metrics
- **JSONL codec and transport**: framed message protocol for server communication
- **ArkClient library**: `packages/protocol/` with typed RPC calls and push notifications
- **Server CLI**: `ark server` command with stdio and WebSocket modes

### TUI Migration
- **Push-based architecture**: TUI fully migrated from polling to ArkClient protocol
- **useArkStore hook**: reactive store replacing manual refresh cycles
- **Action hooks migrated**: all TUI session/compute actions routed through ArkClient
- **Loading unification**: single TabBar spinner replaces inline refreshing indicators

### Executor System
- **Executor interface**: 5-method contract (launch, kill, status, send, capture) in `packages/core/executor.ts`
- **Executor registry**: pluggable executor dispatch at session start
- **Claude Code executor**: wraps existing launch/kill/status/send/capture
- **Subprocess executor**: generic command executor for non-interactive agents

### Web UI
- **Memory management**: list, add, search, and forget memories from the browser

### Documentation
- **User guide**: quickstart, use cases, executor system, protocol server
- **CLI, TUI, and configuration references**: updated for protocol server and executors

## v0.7.0 (2026-04-04)

### Graph Flows
- **Graph-based flows**: composable termination conditions and flow state persistence
- **Cross-session memory**: knowledge ingestion, handoff, and message filtering
- **Task ledger**: recipe evaluation and headless ACP protocol

### Skills & Recipes
- **Skill CLI**: `ark skill create/delete` commands
- **Recipe CLI**: `ark recipe create/delete` with `--from-session` for extracting recipes from completed sessions
- **Skill extraction**: auto-extract reusable procedures from completed sessions

### Intelligence
- **Guardrails**: pattern-based tool authorization wired into PreToolUse hook pipeline
- **Sub-agent fan-out**: dynamic task decomposition with fork/join
- **Hybrid search**: unified search with LLM re-ranking and `--hybrid` CLI flag
- **Structured review output**: machine-parseable JSON with P0-P3 severity levels
- **Prompt injection guard**: detection at session dispatch boundary

### Observability
- **OTLP span export**: JSON span exporter wired into session lifecycle
- **Auto-rollback health poller**: reverts deployments on health check failure
- **Telemetry flush**: configurable HTTP endpoint for telemetry data

### Web UI
- **Full CLI parity**: 50+ endpoints in web API, covering agents, tools, flows, compute, and history
- **Extension catalog**: evals framework and observability hooks

### TUI
- **Advance stage**: `A` key to manually advance a session's flow stage
- **Worktree finish**: `W` key for merge/PR workflow
- **Profile + status counts**: shown in StatusBar

### Testing
- **E2E CLI rewrite**: in-process test calls replaced subprocess tests (215s -> 2.6s, 0 failures)

## v0.6.0 (2026-04-03)

### Web Dashboard
- **Rich React dashboard**: full session management with costs, live updates, and token auth
- **SSE live updates**: event-driven broadcast replaces polling
- **Session replay**: step through completed session timelines
- **Cost views**: model breakdown, per-session costs, and fleet summary

### MCP Socket Pool
- **Shared MCP processes**: Unix socket pool for concurrent MCP server connections

### Cost Tracking
- **Pricing engine**: per-model cost calculation with CLI summary and TUI display
- **Costs tab**: dedicated TUI tab with model breakdown

### Session Lifecycle
- **Soft-delete with undo**: 90-second TTL, Ctrl+Z undo in TUI, `ark session undelete` CLI
- **Checkpoint system**: crash detection with automatic session recovery
- **Multi-instance coordination**: SQLite heartbeat for concurrent Ark instances
- **Content-based status detection**: tmux output pattern matching (busy/waiting/idle)

### Compute
- **Docker sandbox**: containerized agent execution
- **Direct AWS SDK**: replaced Pulumi with direct EC2 provisioning

### TUI Enhancements
- **Hotkey remapping**: customizable keyboard shortcuts
- **Profiles and themes**: UI state persistence across restarts
- **Status filters**: `!/@/#/$` shortcuts for filtering sessions by status
- **Fuzzy search**: `/` key for searching sessions
- **Fork unification**: combined fork/clone into single feature with conversation continuity

### Integrations
- **Messaging bridge**: Telegram, Slack, and Discord integration for notifications
- **Conductor learning system**: auto-promotion of patterns to policy
- **Multi-tool abstraction**: Claude and Gemini drivers with unified interface
- **Auto-update**: automatic version checking and update prompts

### Worktree
- **Worktree finish**: merge, cleanup, and delete workflow from TUI (`W` key)

## v0.5.0 (2026-04-01)

### Tools Tab
- **Unified tool discovery**: TUI Tools tab showing skills, recipes, MCP servers, and commands in a single view
- **Skill CRUD**: three-tier resolution (project > global > builtin), create/edit/delete via CLI and TUI
- **Recipe CRUD**: variable instantiation, `sessionToRecipe` for extracting templates from sessions
- **MCP server and command management**: unified CRUD for all tool types

### Intelligence Features
- **Guardrail rules**: pattern-based tool authorization blocking dangerous commands
- **Structured review output**: P0-P3 severity JSON from reviewer agents
- **Sub-agent fan-out**: dynamic task decomposition into parallel child sessions
- **Fail-loopback**: retry failed stages with error context injection (max 3 retries)
- **Skill injection**: skill prompts automatically injected into agent system prompt at dispatch

### Remote Sync
- **Config sync**: commands, skills, and CLAUDE.md synced to remote compute targets on dispatch

### Code Quality
- **safeAsync/withProvider helpers**: eliminated nested try/catch patterns across core, TUI, and compute
- **Clean tsc build**: resolved all TypeScript type errors
- **Standardized TUI patterns**: useConfirmation hook, consistent prop naming, empty states

## v0.4.0 (2026-04-01)

### Focus System
- **useFocus context**: TUI keyboard input ownership with focus stack -- overlays push/pop focus, app shortcuts only fire when no child component owns focus

### Agent Management
- **Custom agents**: create, edit, delete, and copy agent definitions via CLI and TUI
- **Three-tier resolution**: project `.ark/agents/` > global `~/.ark/agents/` > builtin `agents/`
- **CLI commands**: `ark agent create/edit/delete/copy`

### TUI Refactoring
- **SessionsTab decomposition**: split into SessionDetail, GroupManager, TalkToSession, CloneSession, MoveToGroup sub-components
- **Confirmation prompts**: destructive actions (delete, stop) require confirmation
- **Helper modules**: `statusBarHints.ts` for centralized hint generation, `sessionFormatting.ts` for display formatting
- **Extracted hooks**: useAuthStatus, useEventLog, useGroupActions

### Code Quality
- **Silent catch cleanup**: error logging added to all catches across 7 modules (session, github-pr, app, conductor, claude, claude-sessions, EC2)
- **Circular dependency fix**: removed import cycles between core modules
- **Type safety**: DB row types, consistent return types, deduplicated FTS escaping
- **CI test isolation**: shared test context across all test files

## v0.3.0 (2026-03-28)

### ArkD Universal Daemon
- **ArkD**: typed JSON-over-HTTP API on port 19300 -- agent lifecycle, file ops, metrics, channel relay
- **Snapshot endpoint**: capture agent state via ArkD
- **ArkdBackedProvider base class**: shared implementation for all remote compute providers

### Compute Providers
- **8 providers**: local, docker, devcontainer, firecracker, ec2, ec2-docker, ec2-devcontainer, ec2-firecracker -- all isolation modes via ArkdBackedProvider

### Conductor Transport
- **ArkD as relay**: channel reports go through arkd, arkd forwards to conductor
- **Comprehensive test coverage**: integration tests for the full relay pipeline

### PR Monitoring
- **Pull-based polling**: monitors GitHub PRs via gh CLI for review activity
- **Auto-detect PR URL**: extracts PR URL from agent reports
- **pr-review flow**: dedicated flow for PR review workflows

### Session Details
- **Rich details**: files changed, commits, and clickable links in session view
- **Auto-generated names**: forked/cloned sessions get unique names automatically

## v0.2.0 (2026-03-27)

### EC2 Compute
- **EC2 provider**: full lifecycle management -- provision, start, stop, destroy with SSH
- **Auth sync**: sync Claude and GitHub credentials to remote instances
- **SSH connection pool**: per-type queues for efficient remote command execution
- **Remote MCP channel**: channel communication over SSH tunnel
- **Cloud-init provisioning**: automated instance setup with tool verification and remediation

### Provider Interface
- **Capability flags**: providers declare supported operations
- **Extended methods**: checkSession, getOutput, reboot, connectivity test
- **Provider-based dispatch**: session dispatch uses provider methods instead of isLocal/isRemote branching

### Messaging & Chat
- **Text input navigation**: Option+Backspace word deletion, Ctrl+arrow word navigation
- **Chat overlay**: `t` for chat, `T` for threads, Tab toggles focus between messages and input
- **useMessages hook**: centralized message state management
- **Reliable message sending**: retry with paste marker detection
- **Auto-accept channel prompt**: handles resume fallback double-prompt

### TUI Polish
- **Status bar layout**: consistent shortcuts with `|` separators across all tabs
- **Fork/clone shortcuts**: `c` to fork, `C` to clone
- **TreeList navigation**: j/k matches visual group order
- **Dispatch progress**: shown as events in session detail
- **Loading spinner**: shown on TUI startup
- **OS notifications**: stage completion triggers terminal bell

### Remote Dispatch
- **Auth token passing**: remote agents receive auth token, refreshed periodically
- **Claude auth setup**: interactive setup-token flow for remote instances
- **Config sync**: Claude configs synced to remote EC2 clone on dispatch

### Web UI
- **Landing page**: wider layout, top nav, sidebar hover
- **Copy buttons**: consistent copy-to-clipboard across all views
- **Chat display**: messages don't overflow into input area

### DevContainer Support
- **JSONC parsing**: handle comments in devcontainer.json
- **Explicit opt-in**: devcontainer/compose require explicit configuration

## v0.1.0 (2026-03-25)

### Initial Release
- **Ark**: autonomous agent orchestration platform for AI coding agents
- **Claude Code agent**: launch Claude Code in tmux sessions with isolated worktrees
- **Session lifecycle**: create, dispatch, stop, and monitor agent sessions
- **TUI dashboard**: React + Ink terminal interface with session list and detail pane
- **Agent completion summary**: structured summary in TUI detail pane
- **Flow engine**: multi-stage pipelines with manual and automatic gates
- **Conductor**: HTTP server for channel relay and hook status
- **Paste support**: Cmd+V paste in TUI text inputs
- **Install script**: `make install` with tagged release support
