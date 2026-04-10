# Changelog

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

## v0.8.0

Previous release.
