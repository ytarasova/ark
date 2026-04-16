# Ark Platform Roadmap

> Last updated: 2026-04-14 (full background agent gap analysis) (71 PRs total -- v0.14.0 released)
> Planning framework: **11 sub-projects (SP1-SP11)** covering all 11 layers of the background agent stack
> Reference: [background-agents.com/landscape](https://background-agents.com/landscape) | [Ona Software Factory](https://ona.com/stories/building-a-software-factory-in-public) | [Open Agents](https://github.com/vercel-labs/open-agents)
> Releases: v0.13.0 (2026-04-13), v0.14.0 (2026-04-14), v0.17.0 (2026-04-15)
> Prompt caching: 99.9% hit rate, $3,430 saved (86% reduction) across 47 agent sessions
>
> **2026-04-14 "ark init" meeting (Yana, Zineng, Abhimanyu, Atul) -- key decisions:**
> - **TUI retired and removed** -- consensus was to drop TUI from the product surface (2026-04-14). Code deletion shipped in v0.16.0 (2026-04-15): `packages/tui/`, `packages/tui-e2e/`, `ark tui` command, ink deps, Makefile targets, and docs. Product surfaces are **Web UI + CLI + Electron desktop app**.
> - **Web UI is the primary interface** -- everything doable from web without touching CLI. Missing: conversation interface, repo dropdown, session creation wizard.
> - **Electron desktop app** -- wrap web UI, build DMGs for macOS + Linux (Intel + ARM). No Windows. Near-term deliverable.
> - **Tauri evaluated, staying with Electron (simpler toolchain, native Playwright testing)** -- Tauri v2 was scaffolded in `packages/desktop-tauri/` (2026-04-15) and evaluated. Decision (v0.17.0): stay with Electron. Rationale: Electron has mature Playwright testing support (critical for CI smoke tests), simpler build toolchain (no Rust needed), and the ~10x binary size advantage is offset by bundling ark-native (~78 MB) regardless of shell. Tauri scaffold removed in v0.17.0; evaluation notes preserved in roadmap history.
> - **ACP (Agent Communication Protocol) POC** -- explore as parallel agent interface. Claude Code/Codex don't officially support it; Gemini does. Not a replacement for channels.
> - **MiniMax as cheap model** -- ~1/10th Claude cost for mechanical tasks. Strategy: plan with Opus/Sonnet, implement with MiniMax. Needs OpenAI-compatible custom provider in LLM Router.
> - **Benchmarking framework** -- Abhimanyu building task-based model benchmarks (100 real tasks on actual repos). Results could feed LLM Router routing decisions.
> - **Stay on GitHub** -- free CI with macOS runners, public repo benefits. No Bitbucket migration.
> - **Team**: Yana (core, break until Thu), Zineng (orienting, web UI improvements), Abhimanyu (benchmarking, ACP, Goose), Atul (adoption tracking).
>
> **2026-04-12-14 session -- PRs #53-#83 shipped on `main` (20 PRs, 18 agent-built):**
> - **Arkd report pipeline** -- fixed silent report drops (arkd defaulted conductorUrl to null), TUI boots arkd alongside conductor, channel routes exclusively through arkd
> - **Action stage execution** -- `await safeAsync` (was fire-and-forget), `create_pr` checks branch for existing PR via `gh pr view`, auto_merge chain respects waiting status
> - **TreeList rewrite** -- proper tree component (groups as parent nodes, ink-scroll-list, useVirtualScroll hook, AvailableHeightContext)
> - **Daemon-client architecture** -- TUI as thin WS client, `make dev-daemon` (hot-reload via bun --watch), `make dev-tui`, `make dev-web`
> - **Events tab** -- moved from bottom panel to dedicated tab (key 3), freed 3 rows for session list
> - **Web UI overhaul** -- contextual session controls (split button + dropdown), auto-refresh polling, toast notifications, deep links, flow descriptions, recipe variable rendering
> - **Knowledge graph fix** -- codegraph -> knowledge store ingestion pipeline repaired, 105 symbol + 13 file nodes indexed
> - **Bug-sweep** -- 32 pre-existing test failures fixed across 8 root causes
> - **God class refactor** -- session-hooks.ts extracted from session-orchestration.ts (697 lines)
> - **Process tree tracking** -- PIDs recorded per session, killed on stop
> - **Docs** -- CONTRIBUTING.md, CHANGELOG.md overhaul, ONBOARDING.md, agents/flows reference expanded
>
> **2026-04-10 decision (Foundry 2.0 review meeting):** Ark selected as the company-wide dev-workflow orchestrator -- the layer ABOVE tools like Goose / Claude Code / Codex, not a replacement. Framed as "the foundry" (control plane) with those tools as "the machines." First hand-out to early adopters targeted for the week of 2026-04-13. See **Camp 0: Early Adopter Ship** below.
>
> **2026-04-12 session (continued) -- PRs #38-#51 shipped on `main`:**
> - **on_outcome routing** -- `on_outcome` field on `StageDefinition` maps agent-reported outcomes (e.g. "approved", "rejected", "needs_info") to named target stages. `resolveNextStage()` checks the on_outcome map before falling back to linear progression. `CompletionReport` and `ReportResult` extended with `outcome` field. `validateDAG` checks that target stages exist. 16 tests. Commit `e2ab174`.
> - **DAG conditional routing** -- `FlowEdge` interface with `condition` field (JS expression evaluated against session data). `resolveNextStages()` separates conditional and default edges, evaluates conditions, respects join barriers, and computes skipped stages. Helpers: `getSuccessors()`, `getPredecessors()`, `isJoinNode()`, `topologicalSort()`, `validateGraphFlow()`. New `conditional.yaml` flow definition demonstrates review-outcome branching. 11 tests. Commit `c986c45`.
> - **on_failure retry loop** -- `on_failure: "retry(N)"` directive on flow stages. `parseOnFailure()` extracts max retries. `retryWithContext()` resets session to "ready" and re-dispatches with error context injected. Wired through both `handleReport()` and `handleHookStatus()` in conductor. Retry events logged with attempt tracking. 17 tests. Commit `d1d9221`.
> - **Verify stage in autonomous-sdlc** -- new `verify` stage between `implement` and `review` in `autonomous-sdlc.yaml`. Uses `verifier` agent with `gate: auto` and `on_failure: "retry(2)"`. Runs test suite, lint, security checks, coverage analysis, acceptance criteria. `mediateStageHandoff()` now enforces repo config verify scripts (was inconsistent with `complete()`). 29 tests. Commit `a9f958f`.
> - **TUI daemon-client rewire** -- complete replacement of direct `AppContext`/`getApp()` access in TUI with `ArkClient` RPC calls. `ArkClientProvider` creates in-memory transport pair for local mode. New `session/replay` RPC endpoint with `ReplayStep` type. All TUI components (AgentsTab, FlowsTab, SessionReplay, useComputeMetrics) now use RPC. TUI works in both local and remote modes. 5 tests. Commit `337d178`.
> - **`ark daemon` command** -- `ark daemon start` (with `--detach` for background mode, PID file at `~/.ark/daemon.pid`), `ark daemon stop` (PID-based, stale cleanup), `ark daemon status` (health probe with version/platform display). Graceful shutdown handlers. Commit `e7640ed`.
> - **Web daemon auto-detection** -- probes conductor (:19100/health) and arkd (:19300/health) with 2s timeout. New `daemon/status` RPC handler with parallel health probes. `useDaemonStatus` hook polls every 15s. Sidebar status dot (green/amber/red) and Dashboard System Health card reflect live daemon state. 3 tests. Commit `0ecdfc8`.
> - **Auto-rebase before PR creation** -- `git rebase origin/<base-branch>` runs before `create_pr` action stage. Controlled by `auto_rebase` config in `.ark.yaml` (default: true). On conflict: aborts cleanly and proceeds with PR creation. 44 tests. Commit `7be0249`.
> - **Agent prompt optimization** -- all 12 agent YAMLs updated with explicit completion protocols, structured JSON output (P0-P3), error recovery guidance, "read before write" patterns. Reviewer gets code-review skill. Worker gets CLAUDE.md context. Commit `3c3cc36`.
> - **Comprehensive documentation suite** -- 6 new HTML pages: API Reference, Contributing/Development, Environment Variables, LLM Router, Runtimes Reference, Troubleshooting. Navigation updated across all 28 doc pages. Commit `a531ba0`.
> - **Stage validation E2E tests** -- 770-line test suite covering verify scripts, TODO enforcement, multi-stage flow progression, handoff blocking, error recovery. 38 tests. Commit `ca58826`.
> - **Completion path fix** -- `session/complete` RPC handler now calls `advance()` after `complete()`, fixing sessions stuck at "ready". 24 tests. Commit `f673708`.
> - **Friendly repo name display** -- session detail shows basename (e.g. "ark") instead of full path. `formatRepoName()` helper. CLI and TUI forms store basename on create. 43 tests updated. Commit `bccca20`.
> - **Lint cleanup** -- replaced `require()` with ES6 imports, removed unused imports. Commit `a79c521`.
>
> **2026-04-12 session (earlier) shipped on `main`:**
> - **Auto-start dispatch for all runtimes** -- replaced the fragile tmux-based `deliverInitialPrompt` (pane polling + `sendReliable`) with native CLI arg injection per executor. Claude: task passed as a positional arg to `claude` CLI for immediate processing. Codex/Gemini: `initialPrompt` added to `LaunchOpts`, handled via three `task_delivery` modes (arg, stdin, file). Goose: `-t` flag for task + new `-s` (stay-alive) flag for interactive/manual-gate stages. The obsolete `deliver-task.ts` module + tests deleted (379 lines removed). Commits `e2eb214`, `c70806c`, `7c053f6`, `ac87721`.
> - **Channel permissions fix** -- `mcp__ark-channel__*` always included in `permissions.allow` since `ark-channel` is system infrastructure injected at dispatch, not declared in `agent.tools`. Without this, `report` and `send_to_agent` were blocked by Claude Code's permission system for all 12 agents. Commit `0eaf60d`.
> - **Autonomous flow + SessionEnd completion fallback** -- new `flows/definitions/autonomous.yaml` (single stage, `gate: auto`) for fully autonomous dispatch. When a `SessionEnd` hook fires on a running auto-gate session, the conductor treats it as implicit completion and triggers `advance()` -- handles the case where the channel `report` tool was unavailable but the agent finished its work. Commit `4b7ed83`.
> - **E2E completion path tests** -- 448-line test file exercising three completion paths: manual (report tool), auto (advance on stage complete), and hook-fallback (SessionEnd triggers advance). Commit `a543e1c`.
> - **Autonomous-SDLC flow** -- new `flows/definitions/autonomous-sdlc.yaml` with four auto-gated stages: plan (planner agent writes PLAN.md), implement (implementer writes code + tests), review (reviewer checks diff), pr (action stage auto-creates GitHub PR). Self-dogfood recipe upgraded to use this flow. New `self-quick` recipe + `make self-quick` for trivial tasks. Commit `13df653`.
> - **Auto-merge action stage** -- new `auto_merge` action stage type that runs `gh pr merge --squash --auto` after PR creation. Added to autonomous-sdlc and quick flows. Completes the fully autonomous pipeline from plan through merge. Commit `b642bc2`.
> - **Commit verification gates** -- two layers preventing agents from advancing past implement with uncommitted work: (1) `applyReport()` checks `git status --porcelain` for tracked file changes and blocks completion if found, (2) conductor runs `runVerification()` before advancing agent stages (not just action stages). 276-line test suite. Commits `953dff1`, `93a215c`.
> - **Worktree auto-cleanup on session stop/delete** -- provider-independent `removeSessionWorktree()` helper that cleans up `~/.ark/worktrees/<sessionId>` via `git worktree remove --force` with `rmSync` fallback. Called from both `stop()` and `deleteSessionAsync()` regardless of provider availability. Commit `16e3a41`.
> - **Channel path fix cascade** -- MCP channel server path broke after module reorg (`core/channel.ts` -> `core/conductor/channel.ts`). Fixed in three iterations across claude.ts, LocalProvider, and LocalArkdProvider, then centralized all three into a single `CHANNEL_SCRIPT_PATH` constant in `constants.ts`. Commits `fed500b`, `4dce66f`, `1356d15`, `911017f`.
> - **Brainstorm flow** -- new `flows/definitions/brainstorm.yaml` with three stages (explore -> synthesize -> plan), manual gates for human steering. Explore generates multiple approaches, synthesize ranks and recommends, plan creates actionable PLAN.md. Commit `5b0f75a`.
> - **Poller fix for Codex/Gemini** -- status poller now treats `not_found` as completed (cli-agent executor returns this when tmux session exits), fixing Codex/Gemini sessions stuck in "running" forever after the agent finished. Commit `c35adb0`.
> - **Conductor action-stage fix** -- `handleHookStatus` auto-advance block now handles action stages (create_pr, merge, close), not just agent/fork stages. Previously, review -> pr transition via SessionEnd hook silently dropped the action. Commit `b4daca0`.
> - **Local provider singleton** -- `ComputeRepository.create()` enforces one row per singleton provider+tenant combo, preventing ghost compute entries during parallel dispatch. Commit `8dc2f25`.
> - **TUI session grouping** -- press `%` to group sessions by status (Running, Waiting, Blocked, etc.) with meaningful sort order. TreeList gains `groupSort` prop. Commit `1988607`.
> - **TUI/Web chat keyboard shortcuts** -- TUI inbox overlay shows Tab/Enter/@mention hints; web SessionsPage gains j/k navigation, t for chat toggle, n for new session, / for search, Escape to dismiss. Commits `3c78736`, `cd81ed7`.
> - **CLI status validation** -- `ark session list --status` now uses Commander `.choices()` with exported `SESSION_STATUSES` array for validation. Commit `1a3ded8`.
> - **Gemini autonomous dispatch test** -- 293-line test suite validating the full Gemini runtime path: resolution, model remapping, cli-agent executor launch, status poller, flow advance, and transcript parser registration. Commit `0e20cda`.
> - **Dispatch ARG_MAX fix** -- pass only `session.summary` (not the full context-injected task blob) as the CLI positional arg. The detailed context remains available via `--append-system-prompt` and channel delivery. Fixes silent crashes on macOS when context exceeded 256KB. Commit `1292fdb`.
> - **Per-stage commit verification using stage_start_sha** -- records HEAD sha at dispatch time in session config. `applyReport()` and `applyHookStatus()` verify new commits were made during the current stage (not just anywhere on the branch). Falls back to `origin/main..HEAD` when `stage_start_sha` is unavailable. Also fixes pre-existing bug where `result.updates` was undefined on the no-commits path. Commits `a4c437a`, `b32cdd9`.
> - **Web status filter tabs** -- full status filter tabs added to the web SessionsPage: running, waiting, pending, blocked, completed, failed, archived. Archived sessions require server-side filtering since they're excluded by default. SSE real-time updates skipped for archived view. Surface parity with CLI `--status` flag. Commits `f8931e0`, `8dd991f`.
> - **MCP config cleanup on stop/delete** -- `removeChannelConfig()` mirrors `removeHooksConfig()` -- removes the `ark-channel` entry from `.mcp.json`, preserves other servers, deletes the file if empty. Called on stop, delete, and at boot for stale config cleanup. Previously, stale MCP config pointed at dead channel ports forever. Commit `23e14da`.
> - **MCP config merge into worktrees** -- git worktrees don't include untracked files like `.mcp.json`, so agents in worktrees lost access to MCP servers configured in the original repo. `writeChannelConfig` now accepts `originalRepoDir` and merges servers from the source repo's `.mcp.json` before writing the `ark-channel` entry. Existing worktree entries preserved; stale `ark-channel` entries from the original skipped. Commits `0810f76`, `65e0acb`.
> - **Goose autonomous dispatch test** -- comprehensive test suite for the Goose runtime's autonomous dispatch path: runtime resolution, executor selection, command building, status poller integration, billing config, flow completion. Mirrors `gemini-autonomous-dispatch.test.ts`. Commits `0adfeaf`, `d825862`.
> - **Artifact tracking in session store** -- new `session_artifacts` table with `ArtifactRepository` for queryable tracking of session outputs (files changed, commits, PRs, branches). Four artifact types: file, commit, pr, branch. Cross-session query, deduplication, tenant scoping. Conductor persists artifacts from agent reports (progress + completion). JSON-RPC handlers: `session/artifacts/list`, `session/artifacts/query`. 15 tests. Commits `671c71b`, `e60b07b`.
> - **Orchestrator-mediated stage handoff** -- `mediateStageHandoff()` consolidates the duplicated verify -> advance -> dispatch chain from conductor's `handleReport()` and `handleHookStatus()` into a single orchestration function. Single entry point for stage transitions with pre-advance verification, auto-dispatch routing, and `stage_handoff` observability events. Commits `9f0a831`, `89de3ff`.
> - **Channel prompt auto-accept hardening** -- faster polling (500ms vs 1000ms), double-tap Enter after selecting option 1, exit early once prompt is dismissed. Previous version missed the prompt window due to slow polling. Commit `387939a`.
> - **applyReport infrastructure file exclusion** -- uncommitted-changes guard was rejecting completions because `.claude/settings.local.json` and `.mcp.json` are always modified at dispatch. These Ark infrastructure files are now filtered from `git status`. Also fixes the "ready instead of completed" regression where single-stage sessions got stuck. Commit `7859603`.
> - **Per-stage status timeline in TUI** -- replaces the simple flow pipeline breadcrumb with a detailed stage timeline showing per-stage status icons, agent names, durations, and start timestamps. Derives status from session events (`stage_started`/`stage_completed`). Renders completed (green check), running (blue dot), failed (red X), and pending (open circle). Commit `296884c`.
> - **Per-stage compute templates** -- `compute_template` field on `StageDefinition` allows flow YAML authors to specify different compute templates per stage. At dispatch, `resolveComputeForStage()` looks up the template (DB then config), reuses existing compute or auto-provisions, and overrides `compute_name` for that stage. Commit `d23858e`.
> - **Stage isolation with fresh runtime per stage** -- each stage gets a fresh runtime by default: `advance()` clears `claude_session_id` and `session_id` so the next dispatch creates a new Claude session instead of resuming. Context passes structurally through the task prompt (PLAN.md, git log, stage events). Stages can opt into `isolation: "continue"` in flow YAML to preserve `claude_session_id` for same-agent refinement (e.g. review -> fixup). Commit `f77ed4e`.
> - **SessionEnd hook commit enforcement** -- agents exiting Claude Code without calling `report(completed)` were bypassing commit enforcement entirely. SessionEnd auto-advance now checks `git log` for new commits; if `stage_start_sha` is set, compares HEAD against it. No new commits -> session marked failed with "Agent exited without committing any changes." Commit `2b123d9`.
> - **TUI session list polish cascade** -- 12 fixes across PRs #22-#24: session-by-status grouping display bugs, row width calculation alignment, age column visibility, left pane width (30%), ListRow unification, completion summary sanitization, SessionDetail pane polish, group header formatting. Commits `fce0f1f` through `afb05ca`.
>
> **2026-04-11 session shipped on `main`:**
> - **Multi-tenant channel hardening** -- conductor `/api/channel/<sessionId>`, `/api/relay`, and `/hooks/status` all extract tenant via `Authorization: Bearer ark_<tid>_*` or `X-Ark-Tenant-Id` and route through `app.forTenant()`. `ARK_TENANT_ID` is injected into the channel MCP subprocess at dispatch, propagated through arkd's channel relay, and included in the hook curl POST. Closes the cross-tenant channel exposure flagged in the security audit (commits `e80ac4d`, `08d3329`). Unblocks hosted multi-tenant rollout.
> - **`ark session send` reliability** -- paste-buffer race + empty-string retry fixed in `tmux.sendTextAsync` / `send-reliable.ts`. 50ms paste-flush delay before `send-keys Enter`; retry nudge uses a direct `sendKeysAsync("Enter")` instead of re-entering the paste pipeline. Unblocks the Camp 0 self-dogfood loop (`make self TASK=...`).
> - **Worker agent auto-start** -- `agents/worker.yaml` now has a `{summary}`-templated system prompt so `--dispatch --summary "..."` kicks off work immediately instead of idling. Removes the friction on ark-on-ark dogfooding.
> - **CI web build before unit tests** -- `.github/workflows/ci.yml` now runs `bunx --bun vite build` between `bun install` and the unit-test step, matching what `make test` does locally. Fixes the `web server > starts and serves dashboard HTML` flake that was only failing in CI (root cause: `packages/web/dist/index.html` never existed on the runner).
> - **E2E fixture leak reaper** -- `packages/e2e/fixtures/web-server.ts` and `packages/tui-e2e/server.ts` now track every spawned subprocess in a module-level `Set` and install a single `process.on('exit'|'SIGINT'|'SIGTERM'|'uncaughtException')` reaper that SIGKILLs everything on host death. Web fixture `teardown()` additionally escalates SIGTERM → 500ms grace → SIGKILL. Kills the "Playwright worker dies mid-test, ark web gets reparented to launchd forever" class of leak (we found 138 orphans at ~24 MB each -- 3.3 GB reclaimed on the fix session).
> - Goose as first-class runtime (`runtimes/goose.yaml` + native executor with recipe dispatch, channel MCP via `--with-extension`, router-injected base URLs, vendored binary + freshness manifest)
> - Executor barrel + plugin discovery (`packages/core/executors/index.ts` -- `builtinExecutors` array, `loadPluginExecutors` for `~/.ark/plugins/executors/*.js`)
> - PluginRegistry (Camp 13 Phase 1) -- typed DI-native lookup context, executors flow through Awilix
> - Unified Claude settings bundle (`permissions.allow` from `agent.tools` + prompt-hint injection so agents don't probe)
> - Schema cleanup -- removed 60 lines of `migrateAddColumn` dead code
> - Browser-rendered TUI e2e harness -- real pty + xterm.js + Playwright, driving a real tmux session per test
> - Full layer-one coverage for TUI + web (167 tests, 0 skips), including real flow progression (walks `default` through all 9 stages), real cost aggregation (seeded usage_records), and real dispatch state transitions (stop/resume/archive/restore via pure RPC round-trips)
>
> **Prior session shipped:**
> - TensorZero gateway integrated (lifecycle manager, sidecar/native/Docker modes, cost feed-back)
> - LLM Router wired into executor dispatch flow (ANTHROPIC_BASE_URL / OPENAI_BASE_URL injection)
> - ops-codegraph indexer (replaced Axon; 33 languages, no Python)
> - Codebase auto-index on dispatch
> - Polymorphic transcript parsers via DI
> - cost_mode column in usage_records
> - Compute templates (CLI + TUI + Web + RPC, tenant-scoped)
> - Full multi-tenant entity scoping
> - DB-backed resource stores for control plane mode
> - Tenant integration policies

---

## What Ark Is

The orchestration platform for AI-powered software development. Manages the full lifecycle -- from ticket to merged PR -- across any agent, any model, any compute target. Runs locally as a CLI/web dashboard/Electron desktop app, or hosted as a multi-tenant service with a control plane. (TUI retired as of 2026-04-14 -- no further investment.)

**Positioning (post-Apr-10 decision):** Ark is an opinionated control plane that orchestrates agents; it does not replace the agent runtimes themselves. Goose, Claude Code, Codex, Gemini are the "machines on the factory floor." Ark provides central knowledge, memory, cost tracking, LLM routing, compute provisioning, flow engine, and multi-tenant governance so a company can change models, policies, or skills in ONE place and have it propagate everywhere. The test we want to pass: an agent autonomously finds and fixes a real bug, and the only reason a human hears about it is the commit notification.

---

## Status: What's Done, What's Partial, What's Missing

### DONE -- Fully built, unit-tested, integrated

| Area | Details | Tests |
|------|---------|-------|
| **Awilix DI container** | All services/repos/stores resolve from AppContext. Zero `getApp()` in production code. | Yes |
| **IDatabase abstraction** | SQLite adapter (local). Postgres adapter (hosted -- sync-over-async, see caveats). | Yes |
| **Session orchestration** | Full lifecycle: start, dispatch, stop, resume, advance, complete, fork, clone, spawn, fan-out, handoff. | Yes |
| **DAG flow engine** | `depends_on`, parallel stages, auto-join on child completion, branch merge with conflict detection. DAG conditional routing (FlowEdge with `condition`), on_outcome branching, on_failure retry, topological sort, cycle detection, join barriers, skipped-stage computation. | Yes |
| **Knowledge graph** | Unified store (codebase + sessions + memories + learnings + skills). MCP tools. Context injection at dispatch. Markdown export/import. Old systems (memory.ts, learnings.ts, hybrid-search.ts) deleted. | 79 tests |
| **Agent eval system** | Runtime evals: evaluateSession, getAgentStats, detectDrift, listEvals. Auto-evaluates on session completion. Old keyword-matching evals deleted. | 10 tests |
| **Universal cost tracking** | PricingRegistry (300+ models via LiteLLM JSON), UsageRecorder (usage_records table), multi-dimensional attribution (session, user, tenant, model, provider, runtime, agent_role). | 28 tests |
| **Runtime/role separation** | Agents define roles. Runtimes define backends. 5 runtimes: Claude, Codex, Gemini, Goose, Aider. 12 agent roles. `--runtime` override at dispatch. | Yes |
| **Browser-rendered TUI e2e harness** | `packages/tui-e2e/` -- real pty via node-pty, pipes into xterm.js rendered in headless Chromium via Playwright, drives keystrokes through `term.paste()`. Each test owns an ephemeral `ARK_TEST_DIR` + `TMUX_TMPDIR`. Ports of all 6 legacy TuiDriver tests plus 8 new tab-focused files plus flows + dispatch + interrupt + attach tests. | 89 tests |
| **Web e2e harness** | `packages/e2e/web/` -- Playwright drives the web dashboard via `setupWebServer()` fixture against an isolated `ARK_TEST_DIR`. Substantive coverage of schedule/flow/cost CRUD round-trips, knowledge graph RPCs, and sessions archive/restore. Runs via `bunx --bun playwright test` (fixture uses Bun APIs). | 78 tests |
| **Unified Claude settings bundle** | `writeHooksConfig` writes `permissions.allow` from `agent.tools`, auto-expanding `mcp_servers` to wildcards, rejecting undeclared MCP refs. Tool-hint injection appends an "Available tools" block to the system prompt so agents don't probe. `--dangerously-skip-permissions` stays the explicit override. | 18 tests |
| **Goose native runtime** | `runtimes/goose.yaml` + `packages/core/executors/goose.ts` -- recipe dispatch (`--recipe` / `--sub-recipe` / `--params`), channel MCP wired via `--with-extension`, LLM router routing via `ANTHROPIC_BASE_URL` + `OPENAI_BASE_URL` injection, vendored binary + freshness manifest. | 15 tests |
| **PluginRegistry (DI)** | `packages/core/plugins/registry.ts` -- typed kind-based collections, Awilix-registered, single source of truth for extensible collections. Executor plugin discovery at `~/.ark/plugins/executors/*.js` via dynamic import. Camp 13 Phase 1 shipped; Phase 2 (port compute providers + stores) is the next delta. | 8 tests |
| **Schema cleanup** | Dead `migrateAddColumn` calls removed -- schema.ts is now the canonical CREATE TABLE definition. No in-place migration layer until there's production data to preserve. `rm ~/.ark/ark.db` is the documented dev workflow for destructive changes. | Yes |
| **Goose native runtime** | Full native integration (`packages/core/executors/goose.ts`): text + recipe dispatch (`--recipe` / `--sub-recipe` / `--params`), channel MCP wired as `--with-extension`, router-injected `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`, `--no-session --quiet --output-format stream-json`, `--model` / `--max-turns` from agent YAML. Binary vendored per platform via `scripts/vendor-goose.sh` + `vendor/versions.yaml` manifest. Unlocks Abhimanyu's ISLC recipe set without porting. | 15 unit tests |
| **Executor barrel + plugin discovery** | `packages/core/executors/index.ts` owns `builtinExecutors: Executor[]` as the single source of truth. Boot loops this array, registering into the module lookup AND the Awilix container under `executor:<name>`. `loadPluginExecutors(arkDir)` discovers user-provided executors at `~/.ark/plugins/executors/*.js` via dynamic import. Failures never block boot. | Yes |
| **on_outcome routing** | `on_outcome` field on `StageDefinition` maps agent-reported outcome labels (e.g. "approved", "rejected") to named target stages. `resolveNextStage()` checks on_outcome map before linear fallback. Wired through `applyReport` -> `mediateStageHandoff` -> `advance`. `validateDAG` validates target stages exist. Channel `report` tool accepts `outcome` parameter. | 16 tests |
| **DAG conditional routing** | `FlowEdge` interface with `condition` field (JS expressions against session data). `resolveNextStages()` evaluates conditions, respects join barriers, computes skipped stages. Helpers: `getSuccessors`, `getPredecessors`, `isJoinNode`, `topologicalSort`, `validateGraphFlow`. New `conditional.yaml` flow definition. | 11 tests |
| **on_failure retry loop** | `on_failure: "retry(N)"` directive on flow stages. `parseOnFailure()` extracts max retries. `retryWithContext()` resets session and re-dispatches with error context. Wired through `handleReport()` and `handleHookStatus()` in conductor. Retry events logged with attempt tracking. | 17 tests |
| **Daemon lifecycle management** | `ark daemon start` (`--detach` for background, PID file at `~/.ark/daemon.pid`), `ark daemon stop` (PID-based, stale cleanup), `ark daemon status` (health probe, version/platform display). Graceful shutdown handlers. | Yes |
| **Web daemon auto-detection** | Probes conductor (:19100) and arkd (:19300) health endpoints. New `daemon/status` RPC handler. `useDaemonStatus` hook polls every 15s. Sidebar status dot (green/amber/red) and Dashboard System Health card show live daemon state. | 3 tests |
| **TUI daemon-client architecture** | Complete replacement of direct `AppContext`/`getApp()` in TUI with `ArkClient` RPC calls. `ArkClientProvider` creates in-memory transport pair for local mode. New `session/replay` RPC endpoint. TUI works in both local and remote modes identically. | 5 tests |
| **Auto-rebase before PR creation** | `git rebase origin/<base-branch>` before `create_pr` action stage. Controlled by `auto_rebase` in `.ark.yaml` (default: true). On conflict: aborts cleanly, proceeds with PR creation. | 44 tests |
| **Agent prompt optimization** | All 12 agent YAMLs updated: explicit completion protocols, structured JSON output (P0-P3), error recovery, "read before write" patterns. Reviewer gets code-review skill. Worker gets CLAUDE.md context. | N/A |
| **Verify stage in autonomous-sdlc** | New `verify` stage between `implement` and `review`. Uses `verifier` agent with `gate: auto` and `on_failure: "retry(2)"`. Pipeline: plan -> implement -> verify -> review -> pr -> merge. `mediateStageHandoff()` enforces repo config verify scripts. | 29 tests |
| **Comprehensive documentation suite** | 6 new HTML pages: API Reference, Contributing, Environment Variables, LLM Router, Runtimes Reference, Troubleshooting. Navigation updated across all 28 doc pages. | N/A |
| **Stage validation E2E tests** | 770-line test suite covering verify scripts, TODO enforcement, multi-stage flow progression, handoff blocking, error recovery. | 38 tests |
| **Completion path fix** | `session/complete` RPC handler calls `advance()` after `complete()`, fixing sessions stuck at "ready" instead of progressing. | 24 tests |
| **Vendor freshness CI** | `vendor/versions.yaml` codifies pinned upstream versions for goose, codex, tmux, tensorzero, codegraph. Weekly scheduled workflow (`.github/workflows/vendor-freshness.yml`) polls upstream releases and opens a PR bumping the manifest when upstream is newer. Every bump goes through CI + human review, no auto-merge. | N/A |
| **Module reorganization** | 91 flat files reorganized into 13 domain directories. Barrel exports. All imports updated. | Yes |
| **SDLC flows** | 7-stage pipeline (intake, plan, audit, execute, verify, close, retro). 13 flow definitions (incl. autonomous, autonomous-sdlc, brainstorm, conditional). | Yes |
| **Skills** | 7 builtin (spec-extraction, sanity-gate, plan-audit, security-scan, self-review, code-review, test-writing). | Yes |
| **Recipes** | 10 templates (islc, islc-quick, ideate, quick-fix, feature-build, code-review, fix-bug, new-feature, self-dogfood, self-quick). | Yes |
| **CLI** | 25 command modules. `ark dashboard/knowledge/eval/router/runtime/tenant/auth/daemon` all working. | Yes |
| **Web UI** | Dashboard (widget grid + Recharts cost charts + daemon health), Sessions (status filter tabs), Agents+Runtimes, Flows, Compute, History, Memory/Knowledge, Tools, Schedules, Costs, Settings, Login. 28 doc pages. | Yes |
| ~~**TUI**~~ | ~~10-tab dashboard. Theme-driven (0 hardcoded colors). Dashboard summary in empty state. ASCII cost charts. Agents+Runtimes sub-groups.~~ | Retired (v0.16.0, 2026-04-15) |
| **ESLint** | 0 errors, 0 warnings. CI lint step. | Yes |
| **Process leak prevention** | stopAll via provider, awaited dispatches, proper shutdown order. | Yes |
| **Auth** | API keys (create/validate/revoke/rotate), tenant_id on all entities, per-tenant AppContext, auth middleware. | Yes |
| **Session launcher** | Interface: TmuxLauncher, ContainerLauncher, ArkdLauncher. Orchestration uses `app.launcher.*` not direct tmux. | Yes |
| **Auto-start dispatch** | Native CLI arg injection per executor replaces fragile tmux pane polling. Claude: positional arg. Codex/Gemini: `initialPrompt` via LaunchOpts (arg/stdin/file modes). Goose: `-t` + `-s` (stay-alive for manual-gate). Old `deliver-task.ts` module deleted. | Yes |
| **Autonomous flow** | `flows/definitions/autonomous.yaml` -- single stage, `gate: auto`. `SessionEnd` hook on running auto-gate session triggers implicit completion via `advance()`. Three completion paths (manual report, auto-advance, hook-fallback) all covered by e2e tests. | Yes |
| **Channel permissions** | `mcp__ark-channel__*` always included in `permissions.allow` -- system infrastructure injected at dispatch, not declared in agent YAML. Ensures `report` and `send_to_agent` tools work for all 12 agents. | Yes |
| **Autonomous-SDLC flow** | `flows/definitions/autonomous-sdlc.yaml` -- six auto-gated stages (plan -> implement -> verify -> review -> pr -> merge). Verify stage uses `verifier` agent with `on_failure: "retry(2)"`. Self-dogfood recipe uses this flow. `self-quick` recipe for trivial tasks. | Yes |
| **Auto-merge action stage** | `auto_merge` action runs `gh pr merge --squash --auto`. Added to autonomous-sdlc and quick flows. Completes plan-to-merge pipeline. | Yes |
| **Commit verification gates** | Two-layer gate: `applyReport()` checks `git status --porcelain` for uncommitted tracked files; conductor runs `runVerification()` before advancing agent stages. Worker agent system prompt enforces commit-before-completion. | 276 tests |
| **Worktree auto-cleanup** | `removeSessionWorktree()` cleans up `~/.ark/worktrees/<sessionId>` on stop/delete via `git worktree remove --force` + `rmSync` fallback. Provider-independent. | Yes |
| **Brainstorm flow** | `flows/definitions/brainstorm.yaml` -- three manual-gated stages (explore -> synthesize -> plan) for interactive ideation. | Yes |
| **Channel path centralization** | `CHANNEL_SCRIPT_PATH` constant in `constants.ts` replaces 3 hardcoded `path.join(__dirname, ...)` resolutions across providers + claude.ts. | Yes |
| **Local provider singleton** | `ComputeRepository.create()` enforces one row per singleton provider+tenant combo. Prevents ghost compute entries from parallel dispatch. | Yes |
| **TUI session grouping** | `%` key toggles grouping sessions by status (Running, Waiting, etc.) with meaningful sort order. TreeList `groupSort` prop. | Yes |
| **CLI status validation** | `ark session list --status` uses Commander `.choices()` with exported `SESSION_STATUSES` array. | Yes |
| **MCP config stubs** | Templates for Atlassian, GitHub, Linear, Figma. | N/A |
| **Artifact tracking** | `session_artifacts` table with `ArtifactRepository` -- queryable tracking of session outputs (files, commits, PRs, branches). Cross-session query, dedup, tenant-scoped. Conductor persists artifacts from agent reports. RPC: `session/artifacts/list`, `session/artifacts/query`. | 15 tests |
| **Orchestrator-mediated handoff** | `mediateStageHandoff()` -- single entry point for stage transitions. Consolidates verify -> advance -> dispatch chain from conductor's `handleReport()` and `handleHookStatus()`. Pre-advance verification, auto-dispatch routing, `stage_handoff` observability events. | Yes |
| **Per-stage commit verification** | Records HEAD sha at dispatch as `stage_start_sha`. `applyReport()` and `applyHookStatus()` verify new commits during the current stage, not just anywhere on the branch. SessionEnd hook also enforces (no commits -> failed). | Yes |
| **Per-stage compute templates** | `compute_template` field on `StageDefinition` -- flow YAML can specify different compute per stage. `resolveComputeForStage()` looks up template (DB then config), reuses or auto-provisions compute. | Yes |
| **Stage isolation** | Each stage gets a fresh runtime by default -- `advance()` clears `claude_session_id` and `session_id`. Context passes structurally (PLAN.md, git log, stage events). Stages opt into `isolation: "continue"` to preserve session for same-agent refinement. | Yes |
| **MCP config merging** | Worktrees get MCP servers from original repo's `.mcp.json` merged in at dispatch. `removeChannelConfig()` cleans up `ark-channel` entry on stop/delete. Stale config cleanup at boot. | Yes |
| **Web status filter tabs** | Full status filter tabs (running, waiting, pending, blocked, completed, failed, archived) on web SessionsPage. Server-side filtering for archived. Surface parity with CLI `--status`. | Yes |
| **Per-stage status timeline (TUI)** | Detailed stage timeline in SessionDetail replacing simple breadcrumb -- per-stage status icons, agent names, durations, start timestamps. Derives from `stage_started`/`stage_completed` events. | Yes |
| **Goose autonomous dispatch test** | Comprehensive test: runtime resolution, executor selection, command building, status poller, billing config, flow completion. Mirrors Gemini test pattern. | Yes |

### PARTIAL -- Built but NOT integration-tested or incomplete

| Area | What exists | What's untested / missing | Risk |
|------|------------|--------------------------|------|
| **LLM Router** | Full server with classifier, 3 policies, streaming, CLI. 30 unit tests. | Never made a real API call. Anthropic adapter format untested against real Messages API. Streaming untested end-to-end. | High -- may not work in production |
| **Postgres adapter** | `PostgresAdapter` implements `IDatabase`. SQL translator for SQLite→Postgres syntax. | Sync-over-async via `Bun.sleepSync` spin loop. Never tested under concurrent load. Repos need async migration for real scale. | High -- will bottleneck under load |
| **Redis SSE bus** | `RedisSSEBus` implements `SSEBus` interface. | Never tested against real Redis server. | Medium |
| **Compute: K8s** | `K8sProvider` + `KataProvider` with pod creation, kill, metrics. | Never tested against real K8s cluster. API calls are untested. | High |
| **Compute: E2B** | `E2BProvider` with sandbox creation. | Never tested against real E2B API. SDK calls untested. | High |
| **Compute: Firecracker** | `LocalFirecrackerProvider` + `RemoteFirecrackerProvider`. | Requires Linux with /dev/kvm. Never tested outside dev machine. | Medium |
| **Compute: Docker** | `DockerProvider` + `LocalDockerProvider`. | Works locally when Docker is running. Not tested in CI. | Low |
| **Compute: EC2+ArkD** | `RemoteArkdBase` with 4 isolation modes. | Requires AWS credentials. Provisioning flow untested end-to-end. | Medium |
| **Control plane** | Worker registry, scheduler, tenant policies, hosted entry point. 20 unit tests. | Never deployed as a running service. Docker-compose untested. Helm chart untested. Worker registration flow untested. | High |
| **Remote client** | `--server`/`--token` for CLI and Web. WebSocket transport. Web proxy mode. | Never tested with a real remote server. | High |
| **Auth middleware** | Token extraction, tenant scoping in web server. | Never tested with real multi-user sessions. No session management. | Medium |
| **SDLC flow E2E** | Full pipeline defined with agents, skills, recipes. Flow progression mechanics exercised by `flows.pw.ts` + `flows.spec.ts` -- walks `default` flow through all 9 stages via `session/advance`, asserts each transition. | Never processed a real Jira ticket end-to-end with a real Claude agent. MCP integrations (Atlassian, Bitbucket, Figma) still untested against live services. | Medium |
| **OTLP observability** | `otlp.ts` sends spans to OTLP/HTTP endpoint. | Never tested against real Jaeger/Tempo/Honeycomb. | Medium |
| **Knowledge: ops-codegraph indexer** | Calls ops-codegraph (33 languages via tree-sitter), parses output, stores in knowledge graph. | Never tested with real codegraph installed in CI. Mock-tested only. | Medium |
| **Cost: router feed-back** | Router has in-memory cost tracking. UsageRecorder exists. | Router doesn't call `app.usageRecorder.record()` yet. Not wired. | Medium |
| **Cost: non-Claude runtimes** | UsageRecorder supports any model/provider. | Codex/Gemini/Aider executors don't report usage yet. Only Claude transcript parsing works. | High |
| **Dashboard** | Web widget grid, CLI command. | Data sources are partially mocked. No real fleet to visualize. | Low |
| **Deployment** | Dockerfile, docker-compose, Helm chart. | Never built the Docker image. Never `helm install`-ed. Never pushed to registry. | High |

### NOT BUILT -- Identified gaps, no code exists

| Area | Why it matters | Source |
|------|---------------|--------|
| **Remote Claude subscription auth provisioning** | Soft preference (not hard ban) for subscription auth at fleet scale to avoid per-token bills. Local `claude-max` works; provisioning N remote VMs with device-code login is the open question. API-key mode stays supported -- this is a "make the non-key path work too," not "delete keys." | 2026-04-10 meeting |
| **MiniMax / GLM / DeepSeek / self-hosted provider support** | Internal teams have MiniMax credits (~1/10th Claude cost, ~90% perf for mechanical tasks) and are evaluating GLM (may compete with Opus). Router must accept custom OpenAI-compatible endpoints with zero-cost tracking. Strategy confirmed Apr 14: plan with Opus/Sonnet, implement with cheap models. MiniMax-M2.5 available via SambaNova API (`https://api.sambanova.ai/v1`), config in `~/.config/goose/custom_providers/custom_sambanova.json`. Slack: C0AQLGKQ601 for details. | 2026-04-10 + 2026-04-14 meetings |
| **Dev-environment provisioning (compose + dynamic DNS)** | Per-session isolated dev environments via docker-compose + Traefik-style dynamic DNS so two engineers on the same repo don't collide. Abhimanyu built a prototype against Goose; Ark should absorb the pattern as a compute provider or a session-level addon. | 2026-04-10 meeting |
| **Built-in secrets vault** | Per-user MCP secrets (Bitbucket app password, Jira, Figma, etc.) injected at dispatch, not checked into YAML. **Hard constraint:** must ship in the single Ark package and work IDENTICALLY in local and control-plane modes. No external vault service required. Design implication: encrypted-at-rest storage inside the Ark DB (SQLite locally, Postgres in hosted) with a pluggable backend so enterprise deployments can optionally point at HashiCorp Vault / VaultMan / AWS Secrets Manager -- but the default path has to be batteries-included. | 2026-04-10 meeting + follow-up |
| **Pre-engineering product flow (ideate → PRD)** | Before engineering starts, agents should mine Elasticsearch, customer-care logs, repos to identify gaps, build hypotheses, draft PRDs. Reference products: Premium (Mehul), Sage. PM needs a session that can read repos + dashboards + Jira + Figma at once. | 2026-04-10 meeting |
| **Multi-repo sessions** | Today `Session.repo` is a single string and worktrees are provisioned one-per-repo. Real work crosses repos: a payment-gateway change spans backend + mobile SDK + docs; infra changes span IaC + app config + runbook repos; reviewer agents need read access to N dependent repos. Without multi-repo, those flows either run as N separate sessions with manual coordination or fall back to cursor-style manual work. Touches: Session schema, worktree provisioning, knowledge graph (cross-repo nodes), auto-PR (N linked PRs per ticket), compute mount layer, dispatch CLI, web/TUI session list. | 2026-04-11 follow-up |
| **Workflow persistence / recovery** | Sessions crash → restart from stage start, not from where they stopped. No checkpoint/resume. | This session analysis |
| **Temporal integration** | Control plane needs durable workflow execution for crash recovery, retries, scheduling. | This session analysis |
| **Task/Kanban board** | No agent work queue. Sessions are execution units, not assignable tasks. MC has 8-column Kanban. | Mission Control gap analysis |
| **Security posture** | No trust scoring, secret detection, injection logging, exec approval queue. MC has composite 0-100 score. | Mission Control gap analysis |
| **Audit trail** | No immutable log of sensitive operations (login, dispatch, delete, config change). | Mission Control gap analysis |
| **Webhooks** | No outbound event delivery (HMAC-signed, retry, circuit breaker). | Mission Control gap analysis |
| **Alert rules** | No declarative alerting (entity/field/operator/value → action). | Mission Control gap analysis |
| **User management UI** | No web panel for user CRUD. CLI-only via `ark auth`. | Mission Control gap analysis |
| **GitHub Issues sync** | Auto-PR exists but no bidirectional issue import/tracking. | Mission Control gap analysis |
| **Standup reports** | No auto-generated daily per-agent summaries. | Mission Control gap analysis |
| **i18n** | English only. No translation framework. | Mission Control gap analysis |
| **Onboarding wizard** | No first-run guided setup for new users. | Mission Control gap analysis |
| **Docker image published** | No image in any registry. Can't `docker pull ark`. | Deployment gap |
| **CI/CD pipeline for Ark** | GitHub Actions runs tests but doesn't build/publish artifacts. | Deployment gap |
| **Async Postgres repos** | Repos use sync IDatabase methods. Postgres adapter uses `Bun.sleepSync` hack. | Architecture gap |
| **Decoupled agent-compute architecture** | Three-phase progression: (1) now: agent CLI + repo on same box (1:1:1), (2) near: agent CLI on cheap box, repo on heavy box with arkd proxy between them, (3) target: serverless agent loop (durable workflow) + pooled repo compute via arkd tools. Phase 2 needs arkd-to-arkd tool proxying. Phase 3 needs conductor-hosted channels (currently MCP in tmux) and durable workflow engine. Enables: independent fleet scaling, compute hibernate/snapshot, multi-repo via N compute attachments, compute pooling. Session 1:N Agent 1:M Compute. | 2026-04-14 analysis |
| **Compute lifecycle (hibernate/snapshot/restore)** | Compute targets should support hibernate (stop billing), snapshot (save state), restore (resume from snapshot). E2B already supports snapshots. EC2 has AMIs. Docker has checkpoint/CRIU. Firecracker has native snapshotting. Expose universally via ComputeProvider interface. | 2026-04-14 analysis |
| **Higress gateway integration** | Custom router works for dev. Enterprise needs CNCF-grade gateway. | LLM Router research |
| **Zoekt code search** | Sourcegraph's fast trigram-based code search engine (github.com/sourcegraph/zoekt). Could complement or replace FTS5 transcript search for large-scale code search across repos. Evaluate as a backend for `ark search` and knowledge graph queries. | Abhimanyu 2026-04-13 |
| **Worktree untracked file setup** | Git worktrees don't include untracked files (.env, .envrc, config/local.yaml). Agents in worktrees lose access to env vars and local config. Add `.ark.yaml` `worktree.copy` list and optional `worktree.setup` script hook. | Abhimanyu 2026-04-13 |
| **ACP (Agent Communication Protocol) integration** | Standard agent interface for cross-tool communication. Goose uses it via Claude SDP adapter. Claude Code/Codex don't officially support it; Gemini does natively. Explore as parallel interface alongside channels. Would make the platform more agent-runtime-agnostic. | 2026-04-14 meeting |
| **Task-based benchmarking framework** | Model comparison on real-world tasks (not just prompting). 100 tasks across categories: JWT updates, code graph, PR review, MCP tool calling. Results feed LLM Router routing weights (model X good at tool calling, model Y good at review). Abhimanyu building. | 2026-04-14 meeting |
| **Web UI conversation interface** | Send messages to running agents from web UI. Channels work for Claude Code; need tmux send-keys fallback for other runtimes. Borrow structured question pattern from Open Agents (`ask_user_question` tool with options UI) instead of plain free-text. | 2026-04-14 meeting (Zineng) |
| **Web UI repo dropdown** | Pick repos from session history / Claude projects dir instead of typing full paths. | 2026-04-14 meeting (Zineng) |
| **Web UI tool call renderers** | Per-tool-type rendering (bash: cmd+output, read: file+line numbers, edit: diff, glob: file tree, grep: results). Borrow from Open Agents `/apps/web/components/tool-call/renderers/` (14 renderers, framework-agnostic React). | Open Agents competitive analysis |
| **Agent-driven todo panel** | Agent creates/manages its own task list visible in a pinned UI panel. Users see real-time progress. Borrow from Open Agents `/packages/agent/tools/todo.ts` + `pinned-todo-panel.tsx`. | Open Agents competitive analysis |
| **Web UI git panel** | Sidebar git panel: file tree, diff viewer (unified/split), PR creation form, merge method selection, CI check runs. Backend exists in Ark; missing the UI layer. Borrow from Open Agents `git-panel.tsx`. | Open Agents competitive analysis |
| **Session sharing** | Read-only shareable links for sessions. Borrow from Open Agents `/apps/web/app/shared/[shareId]/` with env variable redaction. | Open Agents competitive analysis |
| **Stream recovery** | Auto-reconnect SSE on tab visibility changes with retry policies. Critical for long-running agents. Borrow from Open Agents `use-stream-recovery.ts`. | Open Agents competitive analysis |
| **Model-family prompt overlays** | Per-model behavioral tuning in agent system prompts (GPT: anti-verbosity, Gemini: conciseness, Claude: todo management). Borrow pattern from Open Agents `system-prompt.ts`. | Open Agents competitive analysis |
| **Sandbox hibernate/snapshot/restore** | Cloud sandboxes hibernate after inactivity, resume from snapshots. Cost optimization for EC2/Firecracker. E2B already supports snapshots; expose the capability. | Open Agents competitive analysis |
| **Anthropic cache control optimization** | Auto-add `cacheControl: { type: "ephemeral" }` to last tool + last message for Anthropic models. Direct cost savings. Borrow from Open Agents `cache-control.ts`. | Open Agents competitive analysis |
| **Knowledge graph visualization** | No visual rendering of the graph in web UI. MC uses reagraph. | Mission Control gap analysis |
| **Live feed sidebar** | No real-time event stream without leaving current view. MC has collapsible sidebar. | Mission Control gap analysis |
| **Boot sequence** | No staged loading screen with progress. MC shows 9-step boot. | Mission Control gap analysis |

---

## Roadmap Camps (Legacy Detail)

> **Note:** These camps contain detailed task breakdowns, ship-blockers, and what's already landed. The **Background Agent Landscape Gap Analysis** (below the camps) and the **Priority Sequence** (SP1-SP11) are the current planning framework. Camps map to SPs as follows:
> - Camp 0 (Early Adopter Ship) + Camp 8 (UX Polish) -> **SP1** (TUI removal + Desktop + Web UI)
> - Camp 5 (Security) -> **SP2** (Security & Secrets)
> - Camp 6 (Integrations) -> **SP3** (Interface Integrations)
> - Camp 14 (Decoupled Compute) + Camp 12 (Federated) -> **SP4** (Sandbox & Compute Lifecycle)
> - Camp 2 (Workflow Persistence) -> **SP5** (Orchestration Hardening)
> - Camp 10 (Dev-Env + Protocols) -> **SP6** (Protocols & Standards)
> - Camp 7 (Task Management) + Review -> **SP7** (Review Pipeline)
> - Camp 3 (Agent Intelligence) + Expansion -> **SP8** (Agent Expansion)
> - Camp 1 (Integration Testing) + Router -> **SP9** (Models & Router)
> - Camp 4 (Dashboard) + Evals -> **SP10** (Benchmarks, Evals & Verification Artifacts)
> - ROI (new) -> **SP11** (ROI & Measurement)
> - Camp 9 (Architecture), Camp 11 (Multi-Repo), Camp 13 (Plugin Platform) -- absorbed into SP4/SP5/SP6

### Camp 0: Early Adopter Ship (IMMEDIATE -- week of 2026-04-13)

**Goal:** Hand Ark to one user per pilot team with a LIMITED, working feature set. Not a broad release -- individual recruits who give daily feedback.

**Pilot recruits (one user + one builder each):**
- Feature Store -- Yana (builder) + peer from FS team
- RU -- Abhimanyu (builder) + peer from RU team (replaces his current Goose+Traefik harness)
- Risk / PML / Inference -- Atul (builder) + peer (likely inference team first)

**Explicit scoping feedback from the meeting:** Ship a small, reliable surface first. Do NOT dump every feature at once -- foundry-1.0 lesson was that premature breadth drowns the team in shallow bug reports. Decide what's in/out before Monday.

**What has already landed (2026-04-11 + 2026-04-12 session commits on `main`):**
- **Auto-start dispatch for all runtimes (2026-04-12)** -- task delivery via native CLI arg injection per executor replaces fragile tmux pane polling. Claude: positional arg. Codex/Gemini: `initialPrompt` via LaunchOpts (arg/stdin/file modes). Goose: `-t` + `-s` (stay-alive for manual-gate). Obsolete `deliver-task.ts` deleted
- **Channel permissions fix (2026-04-12)** -- `mcp__ark-channel__*` always in `permissions.allow` so `report`/`send_to_agent` work for all 12 agents
- **Autonomous flow + SessionEnd fallback (2026-04-12)** -- `autonomous.yaml` (single stage, `gate: auto`). `SessionEnd` hook fires on running auto-gate session triggers implicit completion via `advance()`
- **Autonomous-SDLC flow (2026-04-12)** -- four auto-gated stages (plan -> implement -> review -> pr + auto_merge). Self-dogfood recipe upgraded to full SDLC. New `self-quick` recipe for trivial tasks
- **Commit verification gates (2026-04-12)** -- `applyReport()` checks `git status --porcelain` for uncommitted tracked files; conductor runs verify scripts before advancing agent stages (not just action stages). Worker agent prompt enforces commit-before-completion
- **Worktree auto-cleanup (2026-04-12)** -- `removeSessionWorktree()` on stop/delete via `git worktree remove --force` + `rmSync` fallback, independent of provider
- **Brainstorm flow (2026-04-12)** -- three manual-gated stages (explore -> synthesize -> plan) for interactive ideation
- **Channel path centralization (2026-04-12)** -- `CHANNEL_SCRIPT_PATH` constant replaces 3 hardcoded path resolutions, fixing MCP server path broken after module reorg
- **Poller + conductor fixes (2026-04-12)** -- poller treats `not_found` as completed (fixes Codex/Gemini sessions stuck forever); conductor handles action stages in hook-based auto-advance
- **Local provider singleton (2026-04-12)** -- enforces one compute row per singleton provider+tenant combo, prevents ghost entries from parallel dispatch
- **TUI session grouping (2026-04-12)** -- `%` key groups sessions by status with meaningful sort order
- **CLI status validation (2026-04-12)** -- `ark session list --status` validates against `SESSION_STATUSES`
- **Gemini autonomous dispatch test (2026-04-12)** -- 293-line test validating full Gemini runtime path
- **Dispatch ARG_MAX fix (2026-04-12)** -- pass only `session.summary` as CLI arg (not full context blob); fixes silent crash on macOS when context exceeded 256KB
- **E2E completion path tests (2026-04-12)** -- 448-line test covering manual, auto, and hook-fallback completion paths
- **Per-stage commit verification (2026-04-12)** -- records HEAD sha at dispatch as `stage_start_sha`, verifies new commits during the current stage. SessionEnd hook enforcement: no commits -> session failed
- **Web status filter tabs (2026-04-12)** -- full status filters (running, waiting, pending, blocked, completed, failed, archived) on web SessionsPage, surface parity with CLI
- **MCP config lifecycle (2026-04-12)** -- `removeChannelConfig()` cleans up `ark-channel` on stop/delete; `writeChannelConfig` merges original repo's `.mcp.json` into worktrees so agents keep user-configured MCP servers
- **Artifact tracking (2026-04-12)** -- `session_artifacts` table with `ArtifactRepository` for queryable tracking of files, commits, PRs, branches. Cross-session query, dedup, tenant-scoped. RPC handlers wired
- **Orchestrator-mediated handoff (2026-04-12)** -- `mediateStageHandoff()` consolidates verify -> advance -> dispatch from conductor into single orchestration function with observability events
- **Per-stage compute templates (2026-04-12)** -- `compute_template` field on `StageDefinition`, `resolveComputeForStage()` auto-provisions per stage
- **Stage isolation (2026-04-12)** -- each stage gets fresh runtime by default (clears `claude_session_id`). Context passes structurally. Opt-in `isolation: "continue"` for same-agent refinement
- **Per-stage status timeline in TUI (2026-04-12)** -- detailed timeline with status icons, agent names, durations replacing simple breadcrumb
- **Goose autonomous dispatch test (2026-04-12)** -- comprehensive test mirroring Gemini pattern
- **Channel prompt auto-accept hardening (2026-04-12)** -- faster polling, double-tap Enter, early exit
- **applyReport infrastructure file exclusion (2026-04-12)** -- filters `.claude/settings.local.json` and `.mcp.json` from uncommitted check; fixes "ready instead of completed" regression
- **TUI session list polish (2026-04-12)** -- 12 fixes: grouping bugs, row width, age column, left pane width, ListRow unification, completion summary sanitization, SessionDetail pane polish
- **on_outcome routing (2026-04-12)** -- agents report outcome labels, flow branches to mapped stages instead of linear next. 16 tests
- **DAG conditional routing (2026-04-12)** -- `FlowEdge` with `condition` field, JS expression evaluation, join barriers, skip computation. New `conditional.yaml` flow. 11 tests
- **on_failure retry loop (2026-04-12)** -- `on_failure: "retry(N)"` directive, `retryWithContext()` re-dispatches with error context. 17 tests
- **Verify stage in autonomous-sdlc (2026-04-12)** -- new `verify` stage between `implement` and `review` with `verifier` agent. Pipeline now: plan -> implement -> verify -> review -> pr -> merge. 29 tests
- **TUI daemon-client architecture (2026-04-12)** -- all TUI components rewired from direct `AppContext` to `ArkClient` RPC. Works in both local and remote modes
- **`ark daemon` command (2026-04-12)** -- `start`/`stop`/`status` subcommands with `--detach`, PID file management, health probing
- **Web daemon auto-detection (2026-04-12)** -- live health probes for conductor + arkd. Sidebar status dot + Dashboard System Health card
- **Auto-rebase before PR creation (2026-04-12)** -- `git rebase origin/<base-branch>` before `create_pr` action. Configurable via `.ark.yaml`. 44 tests
- **Agent prompt optimization (2026-04-12)** -- all 12 agent YAMLs updated: completion protocols, structured JSON output, error recovery, "read before write"
- **Documentation suite (2026-04-12)** -- 6 new HTML pages: API Reference, Contributing, Environment Variables, LLM Router, Runtimes Reference, Troubleshooting
- **Stage validation E2E tests (2026-04-12)** -- 770-line test suite: verify scripts, TODO enforcement, multi-stage flow progression. 38 tests
- **Completion path fix (2026-04-12)** -- `session/complete` RPC calls `advance()` after `complete()`, fixing stuck sessions. 24 tests
- **Friendly repo name display (2026-04-12)** -- basename instead of full path across CLI, TUI, and web
- Unified Claude settings bundle writer -- `permissions.allow` generated from `agent.tools`, prompt-hint injection so agents know what tools exist without probing
- Native Goose runtime (`runtimes/goose.yaml` + `packages/core/executors/goose.ts`) with recipe dispatch, channel MCP via `--with-extension`, LLM router routing
- Vendored binary freshness manifest (`vendor/versions.yaml`) + CI workflow for goose / codex version bumps
- PluginRegistry as a first-class Awilix service (Camp 13 Phase 1) -- all executors flow through it; extension point is ready for compute providers + stores in Phase 2
- Full end-to-end test suite: 89 TUI tests + 78 web tests, 0 skips, 0 failures, covers real flow progression, real cost aggregation, CRUD round-trips, and dispatch state transitions (see Camp 1 below for the full story)
- Schema cleanup -- removed in-place migration dead code now that there is no production data to preserve
- Multi-tenant channel + hook hardening -- `/api/channel`, `/api/relay`, `/hooks/status` all tenant-scoped via `X-Ark-Tenant-Id` extraction and `app.forTenant()` routing. Unblocks hosted multi-tenant rollout (audit-flagged gap closed)
- Session send paste-buffer race fix + worker agent `{summary}` auto-start -- `make self TASK="..."` and `ark session send` both now work end-to-end without human intervention. Closes the ark-on-ark dogfood loop
- CI web build before unit tests -- fixes the one consistent CI flake (`web server > starts and serves dashboard HTML`) that was blocking admin-free merges
- E2E fixture subprocess reaper -- `process.on('exit'|'SIGINT'|'SIGTERM'|'uncaughtException')` cleanup in both `packages/e2e/fixtures/web-server.ts` and `packages/tui-e2e/server.ts`. Kills the "Playwright worker dies mid-test -> orphaned `ark web` reparented to launchd forever" leak (found 138 orphans / 3.3 GB in the wild)

**Candidate "in scope" for the first hand-out** (updated Apr 14 meeting):
- **Web UI + CLI** as the two user-facing surfaces (TUI retired)
- **Electron desktop app** wrapping web UI (if DMG packaging is completed in time)
- Local docker compute with worktree isolation (no AWS creds required on the user's laptop)
- Optionally **federated compute via Ark token** (see Camp 12) for users who need heavier than local docker
- `claude-max` + `codex` + `goose` runtimes, subscription auth preferred over API keys
- **MiniMax via LLM Router** for cheap mechanical tasks (Abhimanyu providing API key)
- Knowledge graph auto-index on dispatch (already DONE)
- One polished flow: `code-review` or `fix-bug`, driven from web UI
- Web dashboard (local mode): Sessions / Flows / Knowledge tabs + conversation interface + repo dropdown
- Cost tracking visible even when it's $0 (subscription mode)

**Candidate "out of scope" for the first hand-out:**
- TUI (retired -- no further investment)
- Control plane / multi-tenant (builder team uses local mode first)
- K8s / E2B / Firecracker providers (untested -- see Camp 1)
- Pre-engineering product flow (ideate/PRD) -- defer to Camp 10
- Dev-environment provisioning with dynamic DNS -- defer to Camp 10
- ACP integration (POC only, not production path)

**Ship-blockers to resolve this week:**
| Blocker | Owner | Notes |
|---------|-------|-------|
| Web UI conversation interface | Zineng | Send messages to agents from web UI. Currently only works via CLI. Zineng flagged as blocker. |
| Web UI repo dropdown | Zineng | List known repos from session history / Claude projects. Users shouldn't have to type full paths. |
| Electron DMG packaging | Yana (deferred to Thu+) | DMG build was started but dropped. macOS Intel + ARM, Linux Intel + ARM. No Windows. |
| MiniMax custom provider in LLM Router | Abhimanyu | Accept arbitrary OpenAI-compatible base URL + key. cost_mode=free. |
| Unified Claude settings bundle (tools, OTEL, cost, router, hooks) | Yana | **Camp 0 slice DONE (2026-04-11):** `.claude/settings.local.json` writer with `buildPermissionsAllow(agent)`. **Still to land:** OTEL exporter config, cost-tracking / router URL env vars, Codex / Gemini executor parity. |
| ISLC recipe decomposition audit | Yana + Abhimanyu | Still pending. Decide port-vs-consolidate before hand-out. |
| Bug-sweep the chosen surface (web UI + CLI smoke pass) | Zineng + Abhimanyu | Keep tests green. Orient while fixing bugs. |
| Onboarding note for the recruit (how to install, what works, what doesn't) | Yana | 1-page README, no marketing |
| Feedback channel (Slack or doc) | Abhimanyu | Daily gather, weekly triage |
| Twice-weekly adoption review with leadership | Atul to schedule | Track who's using what |

**Success metric for the pilot:** at least one pilot user has an agent autonomously identify and fix a real bug on their repo, end-to-end, within 2 weeks of hand-out.

### Camp 1: Integration Testing & Production Readiness

**2026-04-11 status -- end-to-end coverage landed.**

Full test suite is green across both surfaces:

| Surface | Tests | Skipped | Failed | Wall |
|---|---|---|---|---|
| `packages/tui-e2e/` (TUI browser harness) | 89 | 0 | 0 | ~3.6 min |
| `packages/e2e/web/` (Playwright web) | 78 | 0 | 0 | ~54 s |

**TUI harness.** `packages/tui-e2e/` runs `ark tui` inside a real pty
(`@homebridge/node-pty-prebuilt-multiarch`), pipes stdin/stdout through a
WebSocket into `xterm.js` rendered in headless Chromium via Playwright.
Each test owns its own ephemeral `ARK_TEST_DIR` + `TMUX_TMPDIR`, so
workers are parallel-safe in principle -- we currently run workers=1
with retries=2 to absorb transient tmux resource flakes. Keystrokes
route through `term.paste()` (not Playwright's keyboard API, which
doesn't reach xterm's hidden textarea without focus gymnastics).

**Web harness.** `packages/e2e/web/` boots `ark web` via `setupWebServer()`
against an isolated `ARK_TEST_DIR`, then drives the React app via
Playwright. Runs under Bun (`bunx --bun playwright test`) because the
fixture uses Bun APIs that the Node Playwright runner can't parse.

**What the 167 tests actually cover:**

- **Flow progression** -- walks a `default` flow through every stage
  via `session/advance` RPC (`intake → plan → audit → implement →
  verify → pr → review → close → retro → completed`), asserts each
  transition; `bare` flow completes on next advance. Covered in both
  TUI and web.
- **Cost aggregation** -- seeds real `usage_records` + `sessions`
  rows via `sqlite3` CLI, verifies `costs/read` totals,
  `costs/summary` per-model breakdown, `costs/session` per-session
  attribution, and `cost_mode` handling (api/subscription/free).
  TUI and web both exercise the full pipeline from
  `PricingRegistry` + `UsageRecorder` through the RPC handlers into
  Recharts / ASCII charts.
- **Dispatch state transitions** -- `session/resume`, `session/stop`,
  `session/archive`, `session/restore` all exercised as pure RPC
  round-trips. Interrupt `I`, Attach `a`, Live Output pane render
  all driven via sqlite3 state seeding (bypasses `_detectStaleState`
  with `session_id=NULL` or `status=waiting`). Zero skips for "needs
  real agent runtime" -- the state machine and UI wiring are testable
  without live Claude.
- **CRUD round-trips** -- schedule create/disable/delete, session
  clone/archive/restore, tools disk → RPC → DOM reflection, memory
  seed via `ark knowledge remember` CLI → `memory/list` RPC readback.
- **Real worktree creation** -- seed session + `git worktree add`
  against a throwaway temp repo → `ark worktree list` surfaces it.
- **Per-tab TUI smoke + integration** -- every tab (Sessions, Agents,
  Flows, Compute, History, Memory, Tools, Schedules, Costs) has a
  dedicated `.pw.ts` file asserting on real rendered content, not
  boilerplate DOM presence.

**Patterns worth copying for future coverage:**

1. **Seed-before-boot** -- always allocate `ARK_TEST_DIR` via
   `mkTempArkDir()` and seed state via `runArkCli(...)` or direct
   `execFileSync("sqlite3", ...)` BEFORE `startHarness({ arkDir })`.
   SQLite locks if you try to seed while the TUI subprocess holds the
   WAL writer.
2. **Pure RPC contract tests beat UI click chains.** The `session/
   archive` + `session/restore` test was originally a flaky UI flow;
   rewriting it as RPC-only made it rock-solid AND exercised the
   actual integration boundary the UI was merely wrapping.
3. **State machine over runtime.** Agent execution tests that seemed
   to "need real Claude" actually only needed the state machine --
   resume, stop, interrupt, attach are all pure state flips or UI
   round-trips that don't dispatch anything.

**Goal:** Everything that exists actually works against real services. Nothing ships until it's proven.

| Task | Effort | Blocks |
|------|--------|--------|
| Test LLM Router against real Anthropic/OpenAI/Google APIs | 1-2 days | Router launch |
| Wire router cost feed-back to UsageRecorder | 0.5 day | Accurate cost tracking |
| Wire non-Claude executor usage reporting (Codex/Gemini/Aider stdout parsing) | 1-2 days | Universal cost tracking |
| Test MCP configs with real Jira, GitHub, Figma | 1-2 days | SDLC flow |
| Test Postgres adapter under concurrent load | 1 day | Hosted mode |
| Test Redis SSE bus against real Redis | 0.5 day | Hosted mode |
| Test K8s provider against real cluster | 1 day | K8s compute |
| Test E2B provider against real API | 0.5 day | E2B compute |
| Deploy Docker-compose, verify all services start | 1 day | Hosted mode |
| Deploy Helm chart on K8s, verify | 1 day | Production |
| Build + publish Docker image to registry | 0.5 day | Deployment |
| End-to-end: real Jira ticket through full SDLC flow | 2-3 days | "Send to dev" workflow |
| Test remote client mode (CLI -> remote server) | 1 day | Multi-user |
| Test ops-codegraph indexer with real codebase | 0.5 day | Knowledge graph |

### Camp 2: Workflow Persistence & Recovery

**Goal:** Sessions survive crashes. Workflows are durable. Same interface local and hosted.

| Task | Effort | Notes |
|------|--------|-------|
| Research: Temporal vs alternatives for control plane | 1 day | Deep dive needed |
| Design WorkflowEngine interface (local + hosted backends) | 1 day | Like IDatabase pattern |
| Local backend: event-sourced from events table | 2-3 days | SQLite, no extra deps |
| Hosted backend: Temporal integration | 3-5 days | Temporal SDK, Helm chart update |
| Checkpoint/resume: agent gets "you were on turn 47" context | 1-2 days | Needs per-turn event logging |
| Crash recovery test suite | 1-2 days | Kill mid-session, verify resume |

### Camp 3: Agent Intelligence

**Goal:** Agents get smarter over time. We can measure and improve performance.

| Task | Effort | Status |
|------|--------|--------|
| ~~Rewrite eval system~~ | ~~2-3 days~~ | **DONE** -- evaluateSession, getAgentStats, detectDrift |
| ~~Universal cost tracking~~ | ~~2-3 days~~ | **DONE** -- PricingRegistry + UsageRecorder |
| Trust scoring per agent (weighted success/failure) | 1 day | Not started |
| Tool call latency instrumentation (p50/p95/p99) | 1 day | Not started |
| Standup reports (auto-generated daily per agent) | 1 day | Not started |
| Per-task automatic model routing (extend LLM Router) | 1-2 days | Not started |

### Camp 4: Dashboard & Visualization

**Goal:** Operators see the full picture. All three surfaces aligned.

| Task | Effort | Status |
|------|--------|--------|
| ~~Dashboard overview (Web/TUI/CLI)~~ | ~~1-2 days~~ | **DONE** -- widget grid, ASCII charts, ark dashboard |
| ~~Cost charts (Recharts)~~ | ~~1 day~~ | **DONE** -- pie + bar charts |
| ~~Smart polling~~ | ~~0.5 day~~ | **DONE** -- useSmartPoll hook |
| Live feed sidebar (Web) | 1 day | Not started |
| Boot sequence with progress steps (Web) | 0.5 day | Not started |
| Agent detail depth -- tabs for memory/tasks/activity/eval | 1-2 days | Not started |
| Session detail -- inline diff viewer, cost breakdown, timeline | 1-2 days | Not started |
| Knowledge graph visualization (reagraph or similar) | 2-3 days | Not started |
| Onboarding wizard (Web) | 1 day | Not started |

### Camp 5: Security & Compliance

**Goal:** Enterprise-ready security posture. Audit everything.

| Task | Effort |
|------|--------|
| Audit trail (immutable log of all sensitive operations) | 1-2 days |
| Security posture score (composite 0-100) | 1 day |
| Secret detection (scan tool I/O for API keys, tokens) | 1 day |
| Injection attempt tracking | 0.5 day |
| Exec approval queue (interactive approve/deny) | 1-2 days |
| Trust scoring per agent | 1 day |
| Security dashboard panel (Web) | 1 day |

### Camp 6: Integrations & Webhooks

**Goal:** Ark connects to the tools teams already use.

| Task | Effort |
|------|--------|
| Outbound webhook system (HMAC-signed, retry, circuit breaker) | 2-3 days |
| Declarative alert rules | 1-2 days |
| GitHub Issues bidirectional sync | 2-3 days |
| Slack commands + thread-based interaction | 2-3 days |
| Linear integration | 1-2 days |
| Webhook/alert management panels (Web) | 1 day |

### Camp 7: Task Management

**Goal:** Agents have a work queue. Humans can assign, prioritize, and review.

| Task | Effort |
|------|--------|
| Task table (new schema -- separate from sessions) | 1 day |
| Kanban board UI (Web) | 2-3 days |
| Task list view (Web) | 1 day |
| `ark task create/list/assign/dispatch` CLI | 1 day |
| Quality gate / Aegis review system (agent-to-agent review) | 2-3 days |
| Task → session mapping | 1 day |
| Task feedback rating + comments | 1-2 days |

### Camp 8: User Experience Polish

**Goal:** Professional, polished product. Web UI + CLI + Electron desktop are the three product surfaces (TUI retired Apr 14).

| Task | Effort | Status |
|------|--------|--------|
| **Desktop app packaging (Electron)** | 1-2 days | **DONE (v0.17.0)** -- Electron app with bundled ark-native, first-launch CLI install, fully self-contained. Tauri v2 evaluated and rejected (simpler toolchain wins). |
| **Web UI conversation interface** | 1-2 days | Not started. Send messages to agents from web UI. Currently only works via CLI. |
| **Web UI repo dropdown** | 0.5-1 day | Not started. List repos from session history + Claude projects dir. |
| **Web UI session creation wizard** | 1 day | Not started. Guided flow selection, agent selection, compute selection. |
| **Web UI facelift** | 2-3 days | Not started. Borrow from v0 Electron mockups (Nov 2025 aspirational design). |
| Full user management UI (create/edit/delete users, roles) | 1-2 days | Not started |
| Google/GitHub SSO | 1-2 days | Not started |
| Access request workflow | 1 day | Not started |
| i18n foundation | 1-2 days | Not started |
| Natural language schedule parsing | 1 day | Not started |
| Calendar view for schedules | 1-2 days | Not started |

### Camp 10: Dev-Environment Orchestration & Pre-Engineering Flows

**Goal:** Close the gaps surfaced in the 2026-04-10 meeting that extend Ark beyond "ticket → PR" into "problem → ticket → PR → devbox."

**2026-04-11 goose-flow comparison** -- cloned Abhimanyu's `abhimanyu-rathore-paytm/goose-flow` and inventoried. Much bigger than the 9 ISLC recipes he'd shipped earlier: a full Fastify + React + goose-in-container platform with its own session store, secrets DB, and Traefik dev-env plan doc. Five patterns from goose-flow are worth porting into Ark as Camp 10 tasks; all are additive (nothing in Ark breaks if we skip them).

| Task | Effort | Notes |
|------|--------|-------|
| Port the 9 ISLC recipes + jira-planner from goose-flow | 0.5 day | Copy `/tmp/goose-flow-compare/config/setup-goose/recipes/*.yaml` into `recipes/goose/`, adjust the orchestrator's `Summon.delegate` call sites to match Ark's channel, verify the `.workflow/<jira-key>/` artifact paths resolve under Ark's worktree layout. Gives us Abhimanyu's full decomposed ISLC set with zero reauthoring. Dependent on sub-recipe runtime (below). |
| Sub-recipe runtime invocation | 3-5 days | Schema already exists: `RecipeDefinition.sub_recipes: SubRecipeRef[]`, `resolveSubRecipe`, `listSubRecipes` in `packages/core/agent/recipe.ts`. Runtime invocation does NOT -- session-orchestration never calls these helpers. Gaps: (1) expose a sub-recipe invocation as an MCP tool the agent can call mid-session (Goose-style), (2) spawn a child session with parent vars + `ref.values` merged, (3) agree on artifact sharing path so parent reads child output (goose-flow orchestrator uses `.workflow/<jira-key>/`), (4) decide return semantics -- sync block vs async-with-join, (5) fan-out support (same sub-recipe, N inputs). Unblocks the ISLC decomposed recipe set and any future orchestrator-that-delegates pattern. |
| Per-session goose container with named volume (from goose-flow) | 3-4 days | goose-flow's `ContainerRuntime` in `api/src/acp/containerRuntime.ts` is the reference: one docker container per chat, fresh bind-mounted `config/setup-goose/`, per-chat named volume `gf-chat-<id>` holding goose's `sessions.db` so chats survive container restarts, per-chat workspace bind-mounted, and a scoped `xdg-config` dir. Ark today runs goose in tmux on the host. Porting the container-per-session model gives us clean cleanup (kill container = gone), scoped secrets, and goose session continuity. Lives alongside the existing "docker compute provider" path -- becomes a `goose` sub-mode of it. |
| `--env-file` secret injection pattern (from goose-flow) | 1 day | goose-flow never passes `-e KEY=VALUE` on the command line (visible in `ps`); it writes secrets to a `0700`-mode env-file under `<chatStateDir>/_envfiles/<chat>.env` and passes `--env-file <path>`. Ark's current cli-agent / goose executors source env from shell variables which has the same process-listing exposure. Port this pattern to every container-spawning compute provider (`DockerProvider`, `EC2DockerProvider`, `LocalFirecrackerProvider`, etc.). Security hardening; no user-visible change. |
| Declarative MCP `env_keys` resolution (from goose-flow) | 1-2 days | goose-flow's `setupGooseConfig.ts` parses `config.yaml`, collects `env_keys: [...]` from every enabled extension, looks them up in the orchestrator's SQLite `secrets` table (scoped by `namespace`), writes the resolved values to the env-file. Single source of truth for "what secrets does this agent need." Ark's current MCP configs are per-agent string arrays -- we'd get (a) clearer "which secret is this asking for," (b) central missing-secret detection, (c) namespace scoping (per-user, per-tenant). Ports into the Camp 13 `PluginRegistry` naturally as a new `kind: "mcp-extension"` with env_keys metadata. Becomes the foundation of the batteries-included secrets vault already flagged in Camp 10. |
| Feature-flag driven recipe behaviour (from goose-flow) | 0.5 day | goose-flow recipes read `.workflow/config.json` at stage entry (`{"islc": {"enablePlanAudit": true, "enableRetrospective": false}}`) to toggle optional stages without editing recipe code. Ark has no equivalent; closest is agent `autonomy`. Add a session-level `featureFlags: Record<string, boolean>` that's readable from within recipes (via a `context.flag("islc.enablePlanAudit")` helper exposed through the PluginContext). |
| ACP stream-json parser for goose status (from goose-flow) | 1 day | goose-flow uses an ACP framing layer (`api/src/acp/framing.ts`) to parse goose's tool-call / response events structurally. Ark's goose executor sets `--output-format stream-json` but nothing parses the stream; we get no hook-like status for goose sessions. Port the framing parser + wire into `startStatusPoller` so goose sessions report `idle` / `working` / `completed` / `failed` through the same path Claude Code uses. |
| Remote Claude subscription auth distribution | 2-3 days | Research: device-code flow at scale, or mount token from a trusted side-channel. Blocks Claude on remote compute. |
| MiniMax / DeepSeek / OpenAI-compatible custom provider in router | 1 day | Accept arbitrary base URL + key. Cost_mode=free for self-hosted. |
| Dev-env provider (compose + Traefik dynamic DNS) | 3-5 days | Either a new compute provider or a session-level addon. Absorb Abhimanyu's prototype. |
| Built-in secrets vault (batteries-included) | 3-4 days | Encrypted-at-rest in Ark DB (SQLite local / Postgres hosted), per-user + per-tenant scoping, injected at dispatch. Pluggable backend interface so VaultMan / HashiCorp Vault / AWS Secrets Manager are optional adapters, not required. Must ship in the single binary -- no external dependency. |
| Pre-engineering `ideate` flow | 2-3 days | PM-facing recipe with ES + Jira + Figma + repo MCPs. Output: draft PRD in Confluence. |
| PM-facing web surface polish | 1-2 days | Non-engineer UX: chat-first, repo access without clone, Confluence/Jira publishing buttons. |

### Camp 11: Multi-Repo Support

**Goal:** A single session can read from and write to N repositories simultaneously, with coordinated PRs and cross-repo knowledge. Multi-repo describes the real shape of a "product" at Paytm: N equal-weight repos contributing pieces of the same shipped thing.

**Design decisions (locked in 2026-04-11):**
- **Atomicity model**: **atomic**. All cross-repo PRs merge together or none do. Requires a merge queue / coordinator. Harder to build but matches the "one product, many repos" framing -- partial merges leave the product in a broken state.
- **Repo roles**: **fully symmetric**. No primary. Each repo is just another piece of the product. Artifacts like `.workflow/<ticket>/` live in a session-owned directory, not inside any single repo.
- **Knowledge graph scoping**: **add `repo_id` on every node**. Cross-repo impact queries ("who consumes this symbol from repo A?") must work. Existing single-repo indexing stays the same; the field is populated for every node going forward.
- **Worktree layout**: **sibling worktrees under one session dir**. `~/.ark/worktrees/<session-id>/<repo-name>/` for each repo. One session dir owns all of them.
- **Product manifest**: **detached from any individual repo**. A product definition file that lists the N repos, their branches, their roles, and optional per-repo overrides. Lives OUTSIDE any one repo so none of them "owns" the cross-repo relationship. Stored in `~/.ark/manifests/<product>.yaml` (global) or `.ark/manifests/<product>.yaml` (user's local working dir). Tenant-scoped in hosted mode.

| Task | Effort | Notes |
|------|--------|-------|
| Product manifest schema + store | 1-2 days | `ProductManifest` type with repos array, branches, tenant scoping. New `ManifestStore` with three-tier resolution (builtin / global / project), same pattern as `FlowStore` / `SkillStore`. CLI: `ark product list / show / create / delete`. |
| Session schema: `repo` (string) → `repos` (array, symmetric) | 1 day | Migration for existing sessions; keep `repo` as a single-element projection for backward compat. Session can optionally reference a product manifest by name. |
| Worktree provisioning: sibling layout | 2 days | `~/.ark/worktrees/<session>/<repo>/` for each. All compute providers (local, docker, ec2, arkd) mount the full session dir. |
| Knowledge graph: `repo_id` on every node, cross-repo edges | 2-3 days | Migration adds the column. Indexer writes it on insert. Context builder pulls from all session repos. New edge types for cross-repo dependency. |
| Atomic multi-PR auto-merge coordinator | 3-5 days | Create N PRs on dispatch; watch CI on all of them; merge only when all green AND approved. Needs a background worker. Partial-merge rollback if any fails post-merge. |
| Dispatch CLI + recipe schema | 1 day | `ark session start --product <name>` or `--repo X --repo Y`. Recipe `repos:` list. |
| Web: multi-repo session list, multi-repo diff preview | 2 days | Every surface shows all session repos. |
| arkd workdir handling | 1-2 days | N workdirs per session pushed / pulled to remote compute. |
| Verify scripts across repos | 1 day | `verify:` field scopes per-repo or all-repos. |
| Flow engine: stage `target_repo` field | 1 day | Optional per-stage scoping when a stage naturally touches one repo only. |
| Cross-repo E2E test | 1-2 days | Full SDLC flow across a test product with 3 linked repos. |

**Pilot (Camp 0) scope:** explicitly OUT. First hand-out is single-repo sessions. Multi-repo lands after the pilot has closed at least one real bug end-to-end.

### Camp 12: Federated Compute (Local Client, Remote Provisioning)

**Goal:** A user running local Ark can provision remote compute -- EC2, k8s, firecracker, etc. -- WITHOUT holding any cloud credentials themselves. All cloud access lives inside the control plane; local Ark talks to the control plane over RPC with an Ark token. User experience: `ark session start --compute heavy-ec2` just works, even though the user has never configured AWS.

**Why this matters for the pilot:** Pilot users on feature-store / RU / inference teams don't want to install `aws-cli`, configure kubectl, or set up credentials. Every onboarding step that isn't "download one binary" is a point where adoption drops. Federated compute turns a 30-minute provisioning-setup tutorial into zero config.

**Architecture:**
- New compute provider: `FederatedProvider` in `packages/compute/federated.ts`
- Constructor takes: control-plane URL + Ark token (`ark_<tenantId>_<secret>`)
- `provision()` → JSON-RPC to control plane → control plane's internal providers (ec2/k8s/firecracker) do the real work → returns a compute handle
- `run()` / `kill()` / `status()` / `metrics()` → delegated via RPC (method names mirror the existing compute interface)
- Local Ark still owns session state, history, knowledge; only the compute plane is remote
- Tokens scope which compute templates a user can provision (enforced via tenant policy)

**Deployment spectrum (all use the same binary):**
1. **Pure local** -- local state + local compute (today's default)
2. **Federated compute** -- local state + delegated compute via control plane token (new)
3. **Full hosted** -- state + compute both on the control plane, CLI talks to it via `--server` / `--token` (today's `hosted.ts` mode)

All three are the same binary with different config. No separate builds.

| Task | Effort | Notes |
|------|--------|-------|
| Control-plane compute RPC API | 2-3 days | JSON-RPC methods: `compute.listTemplates`, `compute.provision`, `compute.status`, `compute.run`, `compute.kill`, `compute.metrics`. Scoped by the caller's Ark token. |
| `FederatedProvider` on the client side | 2 days | Implements the existing `ComputeProvider` interface; delegates every call to the control plane. |
| Token distribution flow | 1 day | `ark auth request-token` or similar; admin approves + issues. Reuses existing API-key machinery. |
| Session dispatch over federated compute | 2 days | Worktree sync: push the local session dir to the remote compute handle, pull artifacts on completion. Arkd already handles most of this; tighten the client-side delta sync. |
| Tenant-policy enforcement on federated calls | 1 day | Existing `tenant-policy.ts` plus an auth middleware hook on the new RPC methods. Don't let a token with `compute: [docker]` ask for EC2. |
| Client-side telemetry: users still tracked by token | 1 day | Usage records (`cost_mode`, `usage_records`) land in the control plane DB, not the client DB. |
| E2E test: local client provisions remote EC2 via token, session runs, artifacts return | 1-2 days | The validation. |

**Pilot (Camp 0) scope:** **IN, optional**. If the pilot user needs anything heavier than local docker, they get an Ark token and federated compute instead of setting up AWS. If local docker is enough, this is deferred.

### Camp 13: Plugin Platform (Registry, Discovery, Sandboxing)

**Goal:** Every extensible collection in Ark (executors, compute providers, runtimes, transcript parsers, flows, skills, recipes, agents) flows through a single `PluginRegistry`. External plugin authors can ship typed plugins with a manifest, versioning, hot reload, and optional sandboxing.

**Phase 1 (DONE, 2026-04-11):** `PluginRegistry` as a first-class Awilix service (`packages/core/plugins/registry.ts`). Executors register into it at boot; `session-orchestration` and `status-poller` resolve executors via `app.pluginRegistry.executor(name)`. Legacy `registerExecutor` / `getExecutor` module API stays public as a compat mirror for non-app call sites (tests). `builtinExecutors: Executor[]` in `packages/core/executors/index.ts` remains the source-of-truth array; adding a new executor still means touching exactly one barrel file.

**Phase 2 (next, ~3-4 days):** Unification. Port compute providers, runtimes, transcript parsers, and the file-backed stores (flows, skills, recipes, agents) to register into `PluginRegistry`. Existing stores become thin read adapters that query the registry instead of owning their own maps. Three-tier source resolution (`builtin` → `user` → `project` / `tenant`) lives in ONE place instead of five. `getProvider(name)` in `packages/compute/` becomes `app.pluginRegistry.get("compute-provider", name)`.

| Task | Effort | Notes |
|------|--------|-------|
| Extend `PluginKindMap` with `compute-provider`, `runtime`, `transcript-parser`, `flow`, `skill`, `recipe`, `agent` | 0.5 day | Type surface only; no behavior change. |
| Port compute providers | 1 day | `packages/compute/index.ts` populates `pluginRegistry` at boot; `getProvider(name)` becomes a shim. Tenant policy still gates which providers a tenant can use. |
| Port transcript parsers | 0.5 day | `TranscriptParserRegistry` becomes a read adapter over `pluginRegistry`. |
| Port runtime / flow / skill / recipe / agent stores | 1 day each | Existing `FileFlowStore` / `FileSkillStore` / etc. become ingestion paths that push entries into the registry on boot + on file-watcher events. |
| Single three-tier resolver (`builtin` → `user` → `project` / `tenant`) | 0.5 day | Extract the resolution logic into a helper that every store uses. |
| Tests + migration notes | 0.5 day | Full suite green; behaviour identical from the user's POV. |

**Phase 3 (future, ~2-3 days): plugin contract + hot reload + versioning.**

| Task | Effort | Notes |
|------|--------|-------|
| Plugin manifest schema (`PluginManifest`) | 0.5 day | `{ name, kind, version, apiVersion, capabilities[], dependencies?, signature? }`. Exported alongside the impl: `export const manifest = {...}; export default impl;`. |
| `apiVersion` gating at load time | 0.5 day | Loader compares `manifest.apiVersion` to Ark's current plugin API version. Mismatches warn + skip instead of loading. Ark semver drifts independently from plugin semver. |
| Hot reload (file-watcher) | 1 day | `~/.ark/plugins/**` watched via chokidar-style API. On change: call `onUnload?()` on the old impl, unregister, fresh `import()` of the new module, re-register. Stateless plugins (executors, providers) are safe; stateful ones must declare `onUnload`. |
| CLI: `ark plugin install/remove/list/upgrade` | 1 day | Thin wrapper over filesystem ops + the registry. Install = download + place in `~/.ark/plugins/<kind>/`; list = iterate registry entries by source; upgrade = re-fetch against manifest. |
| Tenant policy gate | 0.5 day | `tenant.plugin_policy: { allow: ["builtin"] | ["builtin", "signed"] | ["*"] }`. Enforced before the loader touches disk in hosted mode. |

**Phase 4 (future, 2-4 days): plugin sandboxing.**

**Why this matters.** A plugin in Ark is arbitrary JS/TS code the user downloaded from somewhere. In local mode it has the same permissions as `ark` itself, which is effectively the user's shell -- fine for trusted plugins. In hosted mode we CANNOT allow tenant A's plugin to read tenant B's filesystem, spawn arbitrary commands, or exfiltrate secrets.

**The four mechanisms, in increasing strictness:**

1. **Capability-based API surface (primary layer, ships as default).** Plugins don't get global access to `fs`, `child_process`, or `net`. They receive a `PluginContext` object at `initialize()` containing only the capabilities their manifest declared: `context.readWorkdir(path)`, `context.spawnAgent(cmd)`, `context.log(msg)`, etc. Direct `import { readFileSync } from "fs"` is still legal, but the plugin has no way to call it with a meaningful path because the worktree location comes from `context`, not globals. Soft isolation: a determined plugin can still `require("fs")` and guess paths, but innocent plugins are provably safe and malicious ones have to go out of their way.

2. **Bun Workers (secondary layer, opt-in for hosted mode).** Hosted Ark spawns each plugin in `new Worker(pluginPath)` with structured-clone `postMessage` between worker and main. The plugin sees a worker-scoped `self`, can't touch the main process's memory, and its stdout/stderr/log pipe through a controlled channel. Full Node APIs are still present inside the worker but it has no file descriptors from the main process. Kill-on-timeout if the worker hangs. Cost: ~10-20ms per plugin call. Acceptable for infrequent ops.

3. **Child process isolation (strongest, opt-in per tenant).** Plugins marked `trust: low` in the manifest spawn as a child process with `sandbox-exec` (macOS) / `bwrap` (Linux) constraints: no outbound network, read-only rootfs except a bounded workdir, `no-new-privileges`. ~50-100ms per call. Defeats even malicious plugins.

4. **Tenant policy gate (control plane, enforced at install time).** Before the loader touches a plugin module, `tenant.plugin_policy` is consulted: `allow: ["builtin"]` (no user plugins at all), `allow: ["builtin", "signed"]` (only plugins whose manifest matches a known signature allow-list), `allow: ["*"]` (anything -- local mode default). The policy is the first gate; sandboxing is the second.

**Phase 4 ships #1 + #4 as the default and makes #2 / #3 available as per-tenant opt-ins.** Hosted mode can require #2 for any non-builtin plugin. Phase 4 is deferred until external plugin authors are a real use case; until then, built-in + trusted-user plugins are fine without sandboxing.

### Camp 14: Decoupled Compute Architecture

**Goal:** Separate agent fleet from compute fleet. Agents are cheap/stateless processes (or serverless workflows) that connect to expensive/persistent repo compute via arkd tool proxying over the network. Enables: independent scaling, compute pooling, hibernation, multi-repo, and ultimately serverless agents.

**Three-phase progression:**

**Phase 1: arkd-to-arkd tool proxy (near-term, ~3-5 days)**

The stepping stone. Agent runs on cheap compute (t3.small), repo lives on heavy compute (c6i.4xlarge). Agent-side arkd proxies tool calls (bash, read, write, edit, glob, grep) to repo-side arkd over HTTP.

| Task | Effort | Notes |
|------|--------|-------|
| `ComputeAttachment` type: serializable JSON state blob (resourceId, arkdUrl, pool, status, snapshotUrl) | 0.5 day | Like Open Agents' `SandboxState`. Stored in session DB as JSONB. |
| Session schema: `compute` (string) -> `computes` (ComputeAttachment[]) | 0.5 day | Backward-compat: single element array for existing sessions. |
| arkd tool proxy endpoints: `/proxy/exec`, `/proxy/file/*` | 2 days | Agent-side arkd receives tool calls, forwards to repo-side arkd URL from attachment. Auth via session token. |
| Executor changes: pass repo arkd URL to agent environment | 1 day | Agent's tools target remote arkd instead of local filesystem. |
| E2E test: agent on box A, repo on box B, full SDLC flow | 1 day | Validate tool latency, failure modes, reconnection. |

**Phase 2: Compute lifecycle -- hibernate/snapshot/restore (~3-4 days)**

Make expensive compute hibernatable. Stop billing when idle, resume from snapshot.

| Task | Effort | Notes |
|------|--------|-------|
| `ComputeProvider` interface: add `hibernate()`, `snapshot()`, `restore(snapshotId)` | 0.5 day | Optional methods, providers that don't support them return `not_supported`. |
| E2B snapshot/restore (already supported by SDK) | 1 day | Expose existing capability through the interface. |
| EC2 AMI snapshot/restore | 1-2 days | Create AMI on hibernate, launch from AMI on restore. |
| Docker checkpoint/restore (CRIU) | 1 day | Experimental but works for stateless containers. |
| Inactivity-based auto-hibernate | 0.5 day | Like Open Agents' 30-min inactivity timeout. Conductor polls compute activity. |
| Lifecycle state machine on ComputeAttachment | 0.5 day | States: provisioning -> active -> hibernating -> hibernated -> restoring -> archived. |

**Phase 3: Serverless agent loop (~5-7 days, depends on Camp 2)**

The endgame. Agent is a durable workflow step, not a persistent tmux process. No agent compute at all -- just the LLM API loop running as a workflow function.

| Task | Effort | Notes |
|------|--------|-------|
| Durable workflow engine (local + hosted backends) | 3-5 days | Camp 2 prerequisite. Event-sourced local, Temporal hosted. |
| Conductor-hosted channels | 1-2 days | Move channel MCP from agent tmux to conductor. Agent polls/streams from conductor instead of running MCP server. |
| Serverless executor type | 2 days | New executor that runs the agent loop as a workflow step, calling tools on remote arkd. No tmux, no persistent process. |
| Stream recovery for web UI | 1 day | Reconnect to running workflow on page reload / tab switch. Borrow from Open Agents `use-stream-recovery.ts`. |

### Camp 9: Architecture Hardening

**Goal:** Codebase is production-grade and maintainable.

| Task | Effort | Status |
|------|--------|--------|
| ~~Core module reorganization~~ | ~~3-5 days~~ | **DONE** -- 13 domain directories |
| ~~Delete old eval system~~ | ~~1-2 days~~ | **DONE** |
| ~~Delete old knowledge systems~~ | ~~1-2 days~~ | **DONE** -- memory.ts, learnings.ts, hybrid-search.ts, knowledge.ts |
| ~~Daemon lifecycle management~~ | ~~1-2 days~~ | **DONE** -- `ark daemon start/stop/status`, PID files, health probes |
| ~~TUI daemon-client architecture~~ | ~~2-3 days~~ | **DONE** -- all TUI components via ArkClient RPC, works local + remote |
| ~~DAG flow engine enhancements~~ | ~~2-3 days~~ | **DONE** -- on_outcome routing, conditional edges, on_failure retry, join barriers |
| ~~Auto-rebase before PR~~ | ~~0.5 day~~ | **DONE** -- configurable via `.ark.yaml`, graceful conflict handling |
| Async repo layer for Postgres | 3-5 days | Not started -- blocks hosted scale |
| CI/CD pipeline (build/test/publish) | 1-2 days | Not started |
| Higress gateway integration (enterprise) | 2-3 days | Research done, not started |

---

## Background Agent Landscape Gap Analysis

> Reference: [background-agents.com/landscape](https://background-agents.com/landscape) (11 layers, 95+ vendors)
> Reference: [ona.com -- Building a Software Factory](https://ona.com/stories/building-a-software-factory-in-public)
> Vision: "No human-written code. Humans steer direction. Agents do everything else."

Ark's endgame is a **complete background agent platform** covering all 11 layers of the stack. Below maps each layer, current coverage, identified gaps, and recommended tools.

### Layer 1: Interface
**Current:** Web UI (basic), CLI, Desktop (Electron prototype, broken). TUI (retired).
**Landscape:** Slack, Linear, Jira, GitHub, GitLab Duo, Backstage, Ona, Codex App, Conductor, Kiro, VS Code Server, JetBrains Remote Dev.

| Gap | Tool / Approach | Effort | Priority |
|-----|----------------|--------|----------|
| ~~TUI removal (complete deletion)~~ | **DONE (v0.16.0, 2026-04-15)** -- `packages/tui/`, `packages/tui-e2e/`, ink deps, Makefile targets, docs all removed | 0 | done |
| ~~Tauri desktop scaffold~~ | **Evaluated and removed (v0.17.0)** -- Tauri v2 scaffolded 2026-04-15, evaluated, removed in favor of Electron (simpler toolchain, native Playwright testing). Evaluation notes in roadmap history. | 0 | done |
| Desktop app self-contained bundle (ark-native embedded) | **DONE (v0.17.0)** -- ark-native binary bundled via extraResources, first-launch CLI install dialog on macOS, CI pipeline downloads ark-native per platform. Desktop app works with zero prerequisites. | 1 day | done |
| Web UI production-grade overhaul | Borrow from **Open Agents** (tool renderers, git panel, todo panel, structured questions, model selector, stream recovery). 6K lines -> 30K+ | 5-7 days | **SP1** |
| GitHub App integration (webhooks, not just `gh` CLI) | Build GitHub App: inbound webhooks (PR events, issue events trigger sessions), outbound (create issues, comment on PRs, deployment status) | 2-3 days | **SP3** |
| Bitbucket integration | Bitbucket Cloud REST API + webhooks. PR creation, review triggers, pipeline status | 2-3 days | **SP3** |
| Jira integration | Jira Cloud REST API. Inbound: ticket events trigger sessions. Outbound: agents create/update tickets, transition status | 2-3 days | **SP3** |
| Slack bot | Session notifications, slash commands (/ark dispatch, /ark status), thread-based agent chat | 1-2 days | **SP3** |
| Session sharing (read-only links) | Generate shareable URLs for completed sessions. Viewer sees: transcript, diffs, verification output, terminal recording, cost breakdown. Env variable redaction for security. Borrow from Open Agents `/apps/web/app/shared/[shareId]/`. Works for both web UI and control plane (tenant-scoped sharing policies) | 1-2 days | **SP1** |

### Layer 2: Agents
**Current:** 5 runtimes (Claude Code, Codex, Gemini, Goose, claude-max). 12 agent roles. All software-dev focused.
**Landscape:** Claude Code, Codex CLI, Cursor, Devin, Factory Droids, OpenHands, Copilot, Gemini CLI, Ona, Augment Code, Deep Agents, Goose, OpenCode, Kiro, Cline, Kilo Code, Windsurf, Amp, Warp.

| Gap | Tool / Approach | Effort | Priority |
|-----|----------------|--------|----------|
| PM agents (PRD generation, stakeholder comms) | New agent roles: `pm-analyst` (reads ES/Jira/Figma, drafts PRDs), `pm-writer` (Confluence/docs output) | 2-3 days | **SP8** |
| QA agents (test plan, E2E generation, regression hunting) | New agent roles: `qa-planner` (test strategy from spec), `qa-generator` (E2E tests), `qa-regression` (bisect failures) | 2-3 days | **SP8** |
| DevOps agents (IaC, runbooks, incident response) | New agent roles: `devops-infra` (Terraform/Helm), `devops-incident` (alert triage, runbook execution) | 2-3 days | **SP8** |
| Design agents (Figma MCP, UI generation) | New agent role: `designer` (Figma MCP for reading designs, generates UI code). Borrow Open Agents' Design subagent pattern | 1-2 days | **SP8** |
| Custom agent runtime ("arka" -- Ark's own serverless agent) | Lightweight agent runtime that doesn't need Claude Code/Codex/Goose CLI. Runs as a durable workflow, calls tools on remote arkd. The serverless endgame (Camp 14 Phase 3) | 5-7 days | **SP8** |
| Coverage of emerging runtimes (Kiro, Amp, Warp, Cline, Windsurf) | Add runtime definitions. Most are CLI-agent type -- just YAML + task_delivery config | 1 day each | **SP8** |

### Layer 3: Sandbox / Compute
**Current:** 11 providers (local, docker, devcontainer, firecracker, EC2 variants, E2B, K8s). No lifecycle management.
**Landscape:** Ona, Daytona, Modal, Fly.io, OpenComputer, Runloop, Docker, Cloudflare Agents SDK, Codespaces, Coder, Blaxel, OpenSandbox, Vercel Sandbox, Devin, Namespace, Northflank.

| Gap | Tool / Approach | Effort | Priority |
|-----|----------------|--------|----------|
| Compute lifecycle (hibernate/snapshot/restore) | Add `hibernate()`, `snapshot()`, `restore()` to ComputeProvider interface. E2B has native snapshots, EC2 via AMIs, Docker via checkpoint/CRIU, Firecracker native | 3-4 days | **SP4** |
| Decoupled compute (arkd-to-arkd proxy) | Agent on cheap box, repo on heavy box. Agent-side arkd proxies tool calls to repo-side arkd over HTTP | 3-5 days | **SP4** |
| Compute pooling | Pool of pre-provisioned compute targets. Sessions check out from pool, return on completion. Reduces cold-start from minutes to seconds | 2-3 days | **SP4** |
| Cloud dev environment integration (**Daytona**) | Daytona as a compute provider -- standardized dev environments with devcontainer.json, pre-built images. Open source, self-hostable | 2-3 days | **SP4** |
| Serverless compute (**Modal** / **Fly.io**) | For lightweight agent compute (the "agent fleet" in decoupled architecture). Agents run as serverless functions on Modal/Fly, tools call into persistent repo compute | 2-3 days | **SP4** |

### Layer 4: Orchestration
**Current:** DAG flow engine (15 flows), conductor, on_outcome/on_failure routing. Temporal code exists but never tested.
**Landscape:** Ona, Temporal, GitHub Actions, GitLab Duo Flows, n8n, Open SWE, Claude Agent SDK, Codex Web, Coder, Kiro, Symphony, Open-Inspect, Cursor Cloud, Devin, Warp Oz.

| Gap | Tool / Approach | Effort | Priority |
|-----|----------------|--------|----------|
| Test Temporal integration for control plane | `packages/core/router/tensorzero.ts` pattern exists. Deploy Temporal, validate WorkflowEngine interface against real durable workflows | 2-3 days | **SP5** |
| Local durable workflow engine | Event-sourced from events table. Sessions survive crash, resume from last completed step. No external dependency. Required for serverless agents | 3-5 days | **SP5** |
| Event-driven triggers (GitHub webhooks -> sessions) | PR opened -> dispatch reviewer agent. Issue created -> dispatch implementer. Schedule (cron) -> dispatch maintenance agent | 2-3 days | **SP3** |
| n8n / external workflow integration | Ark as an n8n node. External tools can trigger Ark sessions via API. Bidirectional | 1-2 days | **SP6** |

### Layer 5: Security
**Current:** Guardrails (pattern-based tool blocking), tenant policies, API keys. No secrets vault, no credential brokering, no static analysis.
**Landscape:** Veto, Vault, OPA, Vercel Credential Brokering, Keycard, nono.

| Gap | Tool / Approach | Effort | Priority |
|-----|----------------|--------|----------|
| Batteries-included secrets vault | **Built into Ark DB** (encrypted-at-rest, AES-256-GCM). Per-user + per-tenant scoping. Injected at dispatch via env-file (not CLI args). Pluggable backend: default = Ark DB, optional adapters for HashiCorp Vault / AWS Secrets Manager / VaultMan | 3-4 days | **SP2** |
| OPA-style policy engine | **Open Policy Agent** (OPA) or **Cedar** (AWS). Declarative policies: "tenant X cannot use ec2-firecracker", "agent Y cannot run rm -rf", "sessions over $5 require approval". Evaluate at dispatch + tool-call boundaries | 2-3 days | **SP2** |
| Static analysis integration | **Semgrep** (OSS, multi-language, custom rules) as a verify-stage tool. Run automatically before PR creation. Block merge on P0 findings | 1-2 days | **SP2** |
| Dependency scanning | **Dependabot** (GitHub-native) for open-source repos + **Trivy** (OSS container scanner) for compute images. Run on schedule or PR event | 1-2 days | **SP2** |
| Credential brokering | Short-lived tokens issued per-session. Agent gets a scoped token that expires when session ends. No long-lived secrets in agent environment | 2-3 days | **SP2** |
| Agent Auth protocol support | Implement the emerging **Agent Auth** standard from the landscape. Agents authenticate to services via standardized token exchange | 1-2 days | **SP6** |

### Layer 6: Review
**Current:** Reviewer agent (code-review skill), auto-PR. No webhook-triggered review, no external tool integration.
**Landscape:** Ona, GitLab Duo Review, Greptile, CodeRabbit, Claude Review, Copilot Reviews, Cursor Bugbot, Devin, Vercel Agent G, Gemini Code Assist.

| Gap | Tool / Approach | Effort | Priority |
|-----|----------------|--------|----------|
| Webhook-triggered PR review | GitHub/Bitbucket PR webhook -> dispatch reviewer agent -> post review comments on PR. Autonomous review without human trigger | 2-3 days | **SP7** |
| External review tool integration | **CodeRabbit** (AI review as a service) or **Greptile** (codebase-aware review) as fallback/supplementary reviewers alongside Ark's built-in reviewer agent | 1-2 days | **SP7** |
| Review-on-merge-request for Bitbucket | Bitbucket webhook -> reviewer agent -> inline comments via Bitbucket API | 1-2 days | **SP7** |
| Structured review output in PR comments | Post P0-P3 findings as GitHub/Bitbucket review comments with severity labels, not just a text blob | 1 day | **SP7** |

### Layer 7: Agent Tooling
**Current:** Git worktrees, MCP, arkd tools (bash, read, write, edit, glob, grep, exec), MCP socket pooling.
**Landscape:** VNC, Computer Use, Browserbase, agent-browser, Chromium, Git Worktrees, Browser Use, Nix, Tessl.

| Gap | Tool / Approach | Effort | Priority |
|-----|----------------|--------|----------|
| Browser Use (web automation for agents) | **Browserbase** or **Browser Use** (OSS). Agents can browse web, interact with UIs, test web apps, scrape data. Critical for QA + PM agents | 2-3 days | **SP8** |
| Computer Use (desktop automation) | **Anthropic Computer Use** for agents that need to interact with desktop apps (Figma, Slack, email). MCP tool wrapper | 1-2 days | **SP8** |
| Nix for reproducible environments | **Nix** as a compute provisioning option -- reproducible dev environments without Docker overhead. Lighter than containers | 2-3 days | **SP4** |
| Dev server management | Launch/stop/preview dev servers in compute targets. Port forwarding from compute to web UI for live preview (like Open Agents) | 2-3 days | **SP4** |

### Layer 8: Models
**Current:** LLM Router (3 policies, 300+ model pricing, TensorZero gateway). Never tested against real APIs. Not wired to agents.
**Landscape:** Claude 4.6, GPT-5, Gemini 3, Llama 4, DeepSeek V3, Cursor Composer, MiniMax M2, Kimi K2.

| Gap | Tool / Approach | Effort | Priority |
|-----|----------------|--------|----------|
| Test LLM Router against real APIs | Smoke test: Anthropic, OpenAI, Google. Verify streaming, tool calling, error handling | 1-2 days | **SP9** |
| Wire router into agent dispatch | Executors inject `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` (code exists but untested). Verify end-to-end: agent -> router -> provider | 1 day | **SP9** |
| MiniMax / GLM / DeepSeek custom providers | OpenAI-compatible custom endpoint support. MiniMax via SambaNova API (`https://api.sambanova.ai/v1`). cost_mode=free for self-hosted | 1-2 days | **SP9** |
| Per-stage model routing | Plan with Opus ($75/Mtok output), implement with MiniMax ($1/Mtok output). Configure per-stage in flow YAML: `model_tier: quality|balanced|cost` | 1-2 days | **SP9** |
| Model-family prompt overlays | Per-model behavioral tuning (GPT: anti-verbosity, Gemini: conciseness, Claude: todo management). Borrow from Open Agents `system-prompt.ts` | 1 day | **SP9** |
| Anthropic cache control optimization | Auto-add `cacheControl: { type: "ephemeral" }` for cost savings on long conversations. Borrow from Open Agents `cache-control.ts` | 0.5 day | **SP9** |

### Layer 9: Benchmarks & Evals
**Current:** Eval system exists (evaluateSession, getAgentStats, detectDrift) but never tested against real sessions. No SWE-bench. No benchmark dashboard.
**Landscape:** SWE-bench, SWE-bench 2, Terminal Bench, Rebar.

| Gap | Tool / Approach | Effort | Priority |
|-----|----------------|--------|----------|
| Wire eval system to real sessions | Run evaluateSession on completed sessions. Track success rate, token efficiency, tool call patterns over time | 1-2 days | **SP10** |
| SWE-bench integration | Run SWE-bench tasks as Ark sessions. Compare agent performance across runtimes and models. Automated via CI | 2-3 days | **SP10** |
| Task-based benchmark framework (Abhimanyu) | 100 real-world tasks on actual repos (JWT update, PR review, MCP tool calling). Multi-model comparison. Results feed LLM Router routing weights | 3-5 days | **SP10** |
| Benchmark dashboard | Web UI page showing eval results, model comparison charts, success rates by task type, cost-per-task | 2-3 days | **SP10** |
| Eval-driven routing | Benchmark results automatically update LLM Router routing weights. "Model X is 95% on tool calling, 60% on review" -> route accordingly | 1-2 days | **SP10** |

### Layer 10: Protocols & Standards
**Current:** MCP only. ACP as exploratory POC.
**Landscape:** MCP, A2A, ACP, AGENTS.md, Devcontainer, OCI, OpenTelemetry, Agent Trace, Agent Skills, Agent Auth.

| Gap | Tool / Approach | Effort | Priority |
|-----|----------------|--------|----------|
| **A2A** (Agent-to-Agent protocol, Google) | Agents discover and communicate with other agents. Ark already has fan-out/fork -- A2A standardizes the wire format | 2-3 days | **SP6** |
| **ACP** (Agent Client Protocol) | JSON-RPC 2.0 over stdio. Editor/orchestrator = "Client", LLM runtime = "Agent". Native in Gemini CLI, Codex CLI, Copilot CLI, Cursor CLI, Goose. Claude Code wrapped via `@zed-industries/claude-agent-acp` shim (v0.28.0). See dedicated subsection below for Ark adoption plan | ~1,500 LOC touched / ~500 LOC net deletion | **SP6** |
| **AGENTS.md** | Standard file that describes what agents can do in a repo. Ark should both read (discover repo agent config) and write (declare Ark's capabilities) | 0.5 day | **SP6** |
| **OpenTelemetry / Agent Trace** | Wire OTLP spans (code exists in `otlp.ts` but never tested). Per-session traces with tool call spans, LLM call spans, stage transitions | 1-2 days | **SP6** |
| **Agent Skills** protocol | Standard skill discovery and invocation. Ark's skill system maps but isn't protocol-compliant | 1 day | **SP6** |
| **Agent Auth** protocol | Standardized token exchange for agent-to-service authentication | 1-2 days | **SP6** |
| **Devcontainer** spec compliance | Ensure Ark's devcontainer compute provider fully implements the spec (features, lifecycle hooks, port forwarding) | 1 day | **SP4** |
| **OCI** (Open Container Initiative) | Ensure Docker/K8s providers are OCI-compliant for image management | 0.5 day | **SP4** |

### Layer 10a: ACP (Agent Client Protocol) -- adoption plan

> Added 2026-04-15 after multi-agent research pass. Spec: [agentclientprotocol.com](https://agentclientprotocol.com) (v0.11.7, still shipping breaking changes). Repo: [agentclientprotocol/agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol).

**Why it matters for Ark.** Ark currently carries per-runtime glue for each of Claude Code, Codex, Gemini CLI, and Goose: transcript parsers, hook configs, launchers, channel MCP wiring, permission policies. ACP collapses that to a generic JSON-RPC client + a ~80-line adapter per runtime. Goose's entire Claude Code adapter is **82 lines** (`crates/goose/src/providers/claude_acp.rs`) vs. Ark's ~700-line `packages/core/claude/claude.ts`.

**Protocol surface.**
- Transport: stdio (mandatory), streamable HTTP in draft. Newline-delimited JSON-RPC.
- Agent methods: `initialize`, `authenticate`, `session/new`, `session/load`, `session/prompt`, `session/set_mode`, `session/cancel`.
- Client callbacks: `session/request_permission`, `fs/read_text_file`, `fs/write_text_file`, `terminal/create|output|wait_for_exit|kill|release`.
- Agent notifications: `session/update` streams `agent_message_chunk`, `tool_call`, `tool_call_update`, `current_mode_update`, `plan` entries, `stopReason`.

**Runtime support matrix (as of 2026-04-15).**
| Runtime | ACP support | Adapter |
|---|---|---|
| Gemini CLI | Native (`--acp`) | none |
| GitHub Copilot CLI | Native (public preview 2026-01-28) | none |
| Cursor CLI | Native | none |
| Codex CLI | Native OR via `codex-acp` shim | optional |
| Goose | Native (both client + server sides) | none |
| Claude Code | Shim-wrapped via `@zed-industries/claude-agent-acp` v0.28.0 | required (3,611 LOC TS over Claude Agent SDK) |
| Amp, Pi | Shim-wrapped | required |

**Recommended adoption path -- Option B (executor boundary only).**

1. **Keep arkd HTTP surface intact.** ACP covers only agent-side calls. Metrics, directory ops (`list`/`stat`/`mkdir`), exec, port probing, codegraph indexing, control-plane registration -- all remain on arkd's HTTP API (:19300). Forcing ACP at the arkd boundary would require custom protocol extensions for half the surface.
2. **Add an `acp` executor** alongside `claude-code`, `goose`, `subprocess` in `packages/core/executor.ts`. Spawns the agent (via shim where needed), speaks ACP over stdio, streams `session/update` into the conductor.
3. **Migrate Goose first.** Native ACP, immediate win: deletes `--with-extension` plumbing and `buildGooseCommand` extension wiring in `packages/core/executors/goose.ts:64-67`.
4. **Hold on Claude Code.** Until either Anthropic ships native ACP OR the Zed adapter stabilizes remote-compute support. Ark's hook-based status detection in `claude.ts` is already working in production.
5. **Keep `packages/core/conductor/channel.ts`** until every enabled executor speaks ACP. It remains the only cross-runtime messaging path during migration.
6. **Rename existing `packages/core/acp.ts`** (114 LOC, custom non-Zed protocol) to avoid name collision with the real ACP client.

**Migration cost breakdown.**
| Component | Change |
|---|---|
| New ACP client library | +300-500 LOC (JSON-RPC transport, handshake, `session/*`, `session/update` parser) |
| `packages/core/executor.ts` | Extend interface with `prompt()`, `cancel()`, `onUpdate()` streaming |
| `packages/core/executors/claude-code.ts` (153 LOC) | Swap tmux-direct for spawn-of-`claude-agent-acp` |
| `packages/core/executors/goose.ts` (201 LOC) | Replace `--with-extension` MCP wiring with ACP spawn |
| `packages/core/conductor/channel.ts` (222 LOC) + `channel-types.ts` (86 LOC) | Deletable once ACP `session/update` replaces `report` |
| `packages/core/claude/claude.ts` (701 LOC) | ~200 LOC hooks/settings/channel-config become dead code |
| `packages/core/conductor/` `/hooks/status` endpoint | Deletable |
| Tests | `channel.test.ts`, `conductor-hooks.test.ts`, `autonomy.test.ts`, `e2e-autonomy.test.ts`, ~10 others |
| **Total** | **~1,500 LOC touched, ~500 LOC net deletion** |

**Caveats to resolve.**
- **Protocol instability.** v0.11.x still shipping breaking changes. `sacp` Rust crate pinned to a git rev, not crates.io, because the unstable channel isn't published. Plan for 6-12 months of protocol upgrades.
- **Tmux UX regression.** ACP agents are stdio children of the client. Ark's `tmux attach -t ark-s-<id>` workflow does not map. Need either a PTY wrapper, a detachable-client design, or acceptance that "attach" becomes "connect via web UI."
- **Vendor leakage.** `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` is set inside the Claude shim's "generic" ACP layer. Expect similar quirks for Codex-ACP, Amp-ACP. Ark's "generic" ACP executor will still carry per-runtime env var nuances.
- **Known gaps in Goose's ACP client (as of 2026-04-15).** No session fork or resume. ACP session ID differs from Goose session ID -- telemetry correlation is weak.
- **Extra IPC hop for Claude.** Goose -> stdio -> `claude-agent-acp` (TS/Node) -> in-process -> Claude Agent SDK -> Claude CLI. Three hops vs. Ark's current two. Measurable latency impact TBD.

**Deliverables (SP6).**
1. Design doc + name-collision rename: `packages/core/acp.ts` -> `packages/core/rpc-facade.ts` (or similar). **0.5 day**.
2. ACP client library + protocol types (JSON-RPC transport, handshake, `session/*`). **2-3 days**.
3. `acp` executor + Goose adapter. **2 days**.
4. Channel retirement for ACP-native executors (feature-flag gated). **1-2 days**.
5. Claude Code ACP adapter (spawn `claude-agent-acp`, map permission modes, wire MCP servers via `NewSessionRequest.mcpServers`). **2-3 days**. Gated by Anthropic native ACP timing or Zed adapter remote-compute support.
6. Tests + migration guide + CLAUDE.md updates. **1-2 days**.

**Reference implementations to study.**
- [`github.com/block/goose` `crates/goose/src/providers/claude_acp.rs`](https://github.com/block/goose/blob/main/crates/goose/src/providers/claude_acp.rs) -- 82-line Claude adapter (upper bound for Ark's per-runtime adapter size).
- [`github.com/block/goose` `crates/goose/src/acp/provider.rs`](https://github.com/block/goose/blob/main/crates/goose/src/acp/provider.rs) -- generic ACP consumer (~1,700 LOC Rust; Ark's TS equivalent will be smaller).
- [`github.com/zed-industries/claude-agent-acp`](https://github.com/zed-industries/claude-agent-acp) -- the Claude shim itself. If Ark ships its own Claude ACP adapter instead of depending on this npm package, most of the translation logic comes from here.

### Layer 10b: Verification Artifacts & Session Recording
**Current:** Events table logs stage transitions. Transcript parsers extract Claude/Codex/Gemini/Goose conversations. Artifacts table tracks files/commits/PRs. No video, no terminal recording, no structured test output capture.
**Vision:** Every session produces a complete, reviewable audit trail -- what the agent did, what it saw, what it changed, and proof it worked.

| Gap | Tool / Approach | Effort | Priority |
|-----|----------------|--------|----------|
| Terminal session recording | **asciinema** (record tmux sessions as `.cast` files). Start recording at dispatch, stop on completion. Store in `~/.ark/recordings/<sessionId>.cast`. Playback in web UI via asciinema-player.js | 1-2 days | **SP10** |
| GIF/video generation from recordings | Convert `.cast` -> GIF/MP4 via **agg** (asciinema GIF generator) or **svg-term-cli**. Attach to PR descriptions and session artifacts | 1 day | **SP10** |
| Structured verification output | Capture test results (JUnit XML / TAP), lint results (SARIF), security scan results (SARIF) as typed artifacts. Parse exit codes + structured output, not just pass/fail | 1-2 days | **SP10** |
| Web preview screenshots | For agents building UIs: capture dev server screenshots via **Playwright** at verify stage. Store as session artifacts. Show in web UI session detail | 1-2 days | **SP10** |
| Full transcript persistence | Store complete agent transcript (all messages, tool calls, tool results) as JSONL artifact per session. Already partially done via transcript parsers -- ensure 100% coverage across all 5 runtimes | 1 day | **SP10** |
| Diff snapshots per stage | Capture `git diff --stat` + full diff at each stage boundary. Store as artifacts. Enable "session replay" -- see what changed at each stage | 1 day | **SP10** |
| Cost breakdown per stage | Per-stage token usage and cost already in usage_records. Surface in web UI session detail as a cost timeline chart | 0.5 day | **SP11** |
| Session replay in web UI | "Play back" a completed session: show each stage's transcript, diffs, verification output, terminal recording, and cost. Like a build log but richer | 2-3 days | **SP11** |
| PR attachment of artifacts | Auto-attach to GitHub/Bitbucket PRs: terminal recording GIF, test results summary, diff stats, cost breakdown. Makes PRs self-documenting | 1-2 days | **SP7** |
| Artifact retention policy | Configurable TTL for recordings/transcripts. Local: keep N days. Control plane: tenant-scoped retention policy | 0.5 day | **SP2** |

### Layer 11: ROI & Measurement
**Current:** Universal cost tracking (300+ models, api/subscription/free). No developer experience metrics, no contribution charts, no executive reporting.
**Landscape:** DX, Cursor Analytics, Jellyfish, Git AI, Entire CLI.

| Gap | Tool / Approach | Effort | Priority |
|-----|----------------|--------|----------|
| Developer experience metrics | Cycle time (issue -> merged PR), PR throughput, agent success rate, human intervention rate. Track per-user, per-team, per-tenant | 2-3 days | **SP11** |
| Contribution charts | GitHub-style heatmap showing daily agent activity (PRs merged, lines changed, sessions completed). Borrow from Open Agents `contribution-chart.tsx` | 1 day | **SP11** |
| Cost-per-feature tracking | Attribute total cost (LLM tokens + compute hours) to a feature/ticket. "Feature X cost $12.50 in agent time" | 1-2 days | **SP11** |
| Executive dashboard | Tenant-level reporting: total agent hours saved, cost vs manual development, quality metrics (test coverage delta, bug rate delta) | 2-3 days | **SP11** |
| ROI calculator | "Your agents completed N tasks this week. Estimated human time saved: X hours. Cost: $Y. ROI: Z%" | 1 day | **SP11** |

---

## Priority Sequence

```
═══════════════════════════════════════════════════════════════════════════
TIER 1 -- SHIP (now)
═══════════════════════════════════════════════════════════════════════════
SP1:  TUI Removal + Desktop Bundle  ████        Delete TUI (15.8K lines), Electron desktop with bundled
      + Web UI Overhaul                          ark-native (Tauri evaluated, staying with Electron).
                                                 Ship .dmg/.app + AppImage/.deb. Web UI production overhaul
                                                 (Open Agents patterns). This is the user-facing foundation.

═══════════════════════════════════════════════════════════════════════════
TIER 2 -- FOUNDATIONS (next, enables everything)
═══════════════════════════════════════════════════════════════════════════
SP2:  Security & Secrets           ████████     Credential vault (built-in), OPA/Cedar policies, Semgrep,
                                                 Dependabot/Trivy, credential brokering. Non-negotiable for
                                                 enterprise and multi-tenant. Package with Ark binary.
SP3:  Interface Integrations       ████████     GitHub App (webhooks), Bitbucket, Jira, Slack bot. Inbound
                                                 events trigger sessions. Outbound agents interact with services.
SP9:  Models & Router              ████████     Test LLM Router against real APIs. Wire into agents. MiniMax/
                                                 GLM/DeepSeek providers. Per-stage model routing. Cache control.

═══════════════════════════════════════════════════════════════════════════
TIER 3 -- ARCHITECTURE (the big bets)
═══════════════════════════════════════════════════════════════════════════
SP4:  Sandbox & Compute Lifecycle  ██████████   Hibernate/snapshot/restore. Arkd-to-arkd proxy (decoupled
                                                 compute). Compute pooling. Daytona + Modal/Fly.io providers.
                                                 Dev server management + live preview.
SP5:  Orchestration Hardening      ████████     Test Temporal. Build local durable workflow engine. Event-
                                                 driven triggers (webhooks -> sessions). Crash recovery.
SP6:  Protocols & Standards        ██████       A2A, ACP, AGENTS.md, OpenTelemetry/Agent Trace, Agent Skills,
                                                 Agent Auth, Devcontainer compliance. Table-stakes for interop.

═══════════════════════════════════════════════════════════════════════════
TIER 4 -- CAPABILITIES (scale the factory)
═══════════════════════════════════════════════════════════════════════════
SP7:  Review Pipeline              ████         Webhook-triggered PR review (GitHub/BB), external tool
                                                 integration (CodeRabbit, Greptile), structured PR comments.
SP8:  Agent Expansion              ██████████   PM, QA, DevOps, Design agent roles. Browser Use, Computer Use.
                                                 Custom "arka" serverless agent runtime. Emerging runtimes
                                                 (Kiro, Amp, Warp, Cline, Windsurf).
SP10: Benchmarks, Evals &          ██████████   Wire evals to real sessions. SWE-bench. Task-based benchmarks.
      Verification Artifacts                     Eval-driven routing. Benchmark dashboard. PLUS: terminal
                                                 recording (asciinema), GIF generation, structured test/lint/
                                                 security output (JUnit/SARIF), web preview screenshots,
                                                 full transcript persistence, diff snapshots per stage,
                                                 session replay in web UI.
SP11: ROI & Measurement            ██████       DX metrics, contribution charts, cost-per-feature, executive
                                                 dashboard, ROI calculator. The "why should we keep paying" answer.
```

**What changed in this update (2026-04-14 post-meeting + 2026-04-12 full session):**

**Apr 14 "ark init" meeting decisions:**
- TUI retired -- product surfaces narrowed to Web UI + CLI + Electron desktop. TUI was most expensive
  to maintain, hardest to test, least intuitive for new users.
- Web UI elevated to primary interface. Ship-blockers added: conversation interface, repo dropdown.
- Electron desktop app packaging (DMG for macOS/Linux, Intel/ARM) promoted to Camp 0 ship-blocker.
- ACP (Agent Communication Protocol) added as exploratory POC. Not a replacement for channels.
- MiniMax/GLM added as cheap model targets (~1/10th Claude cost). Strategy: plan with Opus, implement
  with cheap models. Needs OpenAI-compatible custom provider in LLM Router.
- Task-based benchmarking framework (Abhimanyu) -- results to feed LLM Router routing weights.
- Camp 8 (UX Polish) elevated in priority sequence -- now ship-critical since web is primary.
- Tauri flagged as potential Electron alternative (smaller binary, Rust backend).

**2026-04-12 full session (51 PRs, 100+ commits):**

**DAG flow engine (new -- production-grade branching and routing):**
- on_outcome routing -- agents report outcome labels (e.g. "approved", "rejected"), flow
  advances to the mapped stage instead of linear next. Wired through applyReport -> advance.
- DAG conditional routing -- `FlowEdge` with `condition` field (JS expressions against session
  data). `resolveNextStages()` evaluates conditions, computes skipped stages, respects join barriers.
- New `conditional.yaml` flow definition: review-outcome branching with revise/reject/approve paths.
- on_failure retry loop -- `on_failure: "retry(N)"` directive. `retryWithContext()` re-dispatches
  with error context. Wired through both `handleReport()` and `handleHookStatus()` in conductor.

**Autonomous SDLC pipeline (hardened):**
- Plan -> implement -> verify -> review -> PR -> auto-merge (6-stage, fully autonomous).
- New `verify` stage with `verifier` agent, `gate: auto`, `on_failure: "retry(2)"`.
- `mediateStageHandoff()` now enforces repo config verify scripts (was inconsistent).
- `brainstorm.yaml` (3-stage manual-gated for ideation).
- `auto_merge` action stage added to autonomous-sdlc and quick flows.
- Three completion paths all tested: manual report, auto-advance, hook-fallback.
- Auto-rebase before PR creation (`auto_rebase` in `.ark.yaml`, default true).

**Daemon lifecycle (new):**
- `ark daemon start/stop/status` CLI commands with `--detach` background mode, PID file management.
- Web daemon auto-detection -- probes conductor + arkd health endpoints. Sidebar status dot
  (green/amber/red) and Dashboard System Health card reflect live state.
- `useDaemonStatus` hook polls every 15s with smart visibility detection.

**TUI daemon-client architecture (new):**
- Complete replacement of direct `AppContext`/`getApp()` in TUI with `ArkClient` RPC calls.
- `ArkClientProvider` creates in-memory transport pair for local mode.
- New `session/replay` RPC endpoint with `ReplayStep` type.
- TUI now works identically in local and remote modes.

**Agent prompt optimization (all 12 agents):**
- Explicit completion protocols with `report()` guidance per role.
- Structured JSON output format (P0-P3 priority) matching ReviewResult interface.
- Error recovery guidance, "read before write" patterns.
- Worker gets CLAUDE.md context, reviewer gets code-review skill.

**Documentation (6 new pages):**
- API Reference, Contributing/Development, Environment Variables, LLM Router,
  Runtimes Reference, Troubleshooting. Navigation updated across all 28 doc pages.

**Stage orchestration infrastructure:**
- `mediateStageHandoff()` -- single orchestration entry point for all stage transitions
  (verify -> advance -> dispatch), replacing duplicated logic in conductor.
- Stage isolation -- each stage gets a fresh runtime by default; `advance()` clears
  `claude_session_id`. Opt-in `isolation: "continue"` for same-agent refinement.
- Per-stage compute templates -- `compute_template` field on `StageDefinition`, with
  `resolveComputeForStage()` for auto-provisioning per stage.
- Per-stage commit verification -- records HEAD sha at dispatch as `stage_start_sha`,
  verifies new commits at stage boundary. SessionEnd hook also enforces (no commits -> failed).
- Artifact tracking -- `session_artifacts` table with cross-session query, 4 artifact types
  (file, commit, pr, branch), RPC handlers wired.

**MCP config lifecycle:**
- `writeChannelConfig` merges original repo `.mcp.json` into worktrees (agents keep user MCP servers).
- `removeChannelConfig()` cleans up `ark-channel` entry on stop/delete + stale cleanup at boot.
- Infrastructure file exclusion from uncommitted check (`.claude/settings.local.json`, `.mcp.json`).

**Commit enforcement hardening:**
- `applyReport()` checks `git status --porcelain` for uncommitted tracked files.
- Conductor runs `runVerification()` before advancing agent stages.
- SessionEnd auto-advance checks `git log` for new commits; no commits -> session failed.
- Infrastructure files excluded from the uncommitted check.
- Completion path fix -- `session/complete` RPC calls `advance()` after `complete()`.

**Surface parity (TUI + Web):**
- TUI: session-by-status grouping (`%`), per-stage status timeline in SessionDetail,
  12 display polish fixes (row width, age column, left pane, ListRow unification).
- Web: full status filter tabs (running/waiting/pending/blocked/completed/failed/archived).
- TUI/Web chat keyboard shortcuts (Tab/Enter/@mention hints, j/k/t/n/Escape).
- Friendly repo name display (basename instead of full path) across all surfaces.

**Runtime coverage:**
- Auto-start dispatch for all 5 runtimes (Claude positional arg, Codex/Gemini initialPrompt, Goose -t/-s).
- Gemini + Goose autonomous dispatch test suites.
- Poller `not_found` fix for Codex/Gemini; conductor action-stage fix.
- Channel prompt auto-accept hardening (faster polling, double-tap Enter).

**Infrastructure:**
- Channel MCP path centralized in `CHANNEL_SCRIPT_PATH` constant.
- Local provider singleton enforcement.
- CLI `--status` validation against `SESSION_STATUSES`.
- Dispatch ARG_MAX fix (pass summary only, not full context blob).
- Worktree auto-cleanup on stop/delete (provider-independent).
- Lint cleanup: replaced `require()` with ES6 imports across codebase.

---

## Competitive Landscape

| Product | Their strength | Our strength | Gap to close |
|---------|---------------|-------------|--------------|
| **Mission Control** | 32-panel dashboard, Kanban, security posture, webhooks | Compute orchestration, DAG flows, knowledge graph | Dashboard depth, task board, security |
| **Vercel Open Agents** | Polished web chat UI (model selector, slash commands, thinking blocks, file autocomplete, PR dialogs), sandbox hibernation/snapshots, live preview/port forwarding, durable workflows, in-session subagent delegation, session sharing | Multi-agent orchestration (12 roles vs 1), DAG flows (15 vs 0), 11 compute providers vs 1, 5 runtimes vs 1, LLM Router, knowledge graph, multi-tenant control plane, cost tracking (300+ models), CLI + Desktop, verification gates, guardrails | **Web UI polish** (biggest gap), sandbox snapshot/hibernate, live preview, durable workflows |
| **SoulForge** | Codebase knowledge graph, PageRank, blast radius | Unified knowledge (code + sessions + memories) | Symbol-level precision (Axon handles this) |
| **Goose** | Recipe-based SDLC, server mode | DAG conditional routing + on_outcome branching replaces Goose's linear recipes | Server mode (our control plane) |
| **Higress** | CNCF AI gateway, enterprise-grade | Custom router with Ark-specific features | Enterprise gateway (use Higress for prod) |

---

## Internal Context

- **#ark-init origin (2026-03-09)**: Harinder kicked off the channel with a deep research note on agent-orchestration layers -- Strategy (Paperclip) / Orchestration (Symphony, Jido) / Execution (Goose, Claude Code, Codex). Core design calls: task-driven not heartbeat-driven; workers execute tasks but don't invent them; every task produces a structured artifact (PR, test report, design doc, eval result); traceability runs `goal → task → run → artifact → decision`; governance gates on merges, deployments, secrets access, financial operations. Ark's design is aligned with these principles -- keep them as invariants when adding features.
- **2026-03-16 → 04-10 arc**: Harinder first said "goose is the answer" (Mar 16-18), then Abhimanyu's Goose+Traefik prototype showed the orchestration-layer gap, then the Apr 10 meeting reversed to Ark-on-top-of-tools. The "workflow control is the real moat" note (Mar 22) is the durable framing: intelligence is commoditized, the system that owns the workflow wins.
- **Upstream of the subscription preference**: Harinder flagged on 2026-04-05 that "Claude CLI is going to get restricted" -- this is the origin of the fleet-scale auth anxiety, not a sudden Apr 10 decision.
- **ISLC recipe set (parity gap flagged)**: Abhimanyu shipped 9 Goose recipes on 2026-04-06 -- a master `islc-orchestrate` that delegates to 8 sub-recipes: `islc-ticket-intake`, `islc-ideate`, `islc-plan`, `islc-audit`, `islc-execute`, `islc-verify`, `islc-close`, `islc-retro`. Ark currently ships only two consolidated recipes (`islc.yaml`, `islc-quick.yaml`). Before the pilot hand-out, either (a) verify the consolidated form covers everything Abhimanyu's decomposed form did, or (b) port the decomposed form so each stage is individually resumable and sub-recipe-addressable. Abhimanyu's orchestrator has specific contracts (`.workflow/<jira-key>/` artifact paths, `mcp__Atlassian__createJiraIssue` for sub-tasks, `mcp__bitbucket__bb_post` for PRs) that our recipes should match or intentionally diverge from. Files available in Yana's Downloads folder.
- **2026-04-10 platform decision**: Ark chosen as the company-wide dev-workflow orchestrator, positioned ABOVE Goose / Claude Code / Codex. Builder trio: Yana (core), Abhimanyu (product + user feedback), Zining (collaboration). Each builder recruits one user from a pilot team (feature-store / RU / risk-PML-inference). Twice-weekly adoption sync with leadership starting week of Apr 13. Leadership framing: "factory floor" -- Ark is the foundry, tools are the machines, one place to swap models/policies/skills for the whole company.
- **Project name caveat**: internally the repo stays "ark". External branding may be "Foundry" (technically the better fit, per the factory metaphor). Keep technical name separate from any productized name.
- **Soft constraint**: Prefer subscription auth (or self-hosted / MiniMax / DeepSeek via router + TensorZero) for fleet-scale Claude, but keep API-key mode fully supported. Ark must accommodate all three `cost_mode` values (`api` / `subscription` / `free`) -- different tenants and different models will land in different modes.
- **Foundry 2.0**: QA Infra (fan-out test suites) + AI Monitor (Prometheus + Slack alerts). Apr 20 deadline. Both tracks now delivered AS USE CASES ON Ark, not as separate products.
- **Competing harnesses**: Goose + Traefik (Abhimanyu), mehul mathur's harness, shrinivasan's personal harness, others. Arc's differentiator is the control layer on top -- compute orchestration + central knowledge/cost/router -- not a better chat loop.
- **"Send to dev"**: PRD ready → remote devbox → tested PR at 95% readiness. Requires: Camp 1 (integration testing) + Camp 2 (workflow persistence) + Camp 10 (dev-env provisioning).
- **Risk team (PAI-32794)**: Per-user MCP credentials, chat history on server → auth + control plane + knowledge graph + Camp 10 credential vault.
- **Rollout discipline**: Start with individuals, not teams. Limited feature set, not everything at once. Daily feedback from recruits, weekly triage by builders. Success = an agent autonomously closing a real bug end-to-end (the Srinivasan-tweet test).
- **2026-04-14 "ark init" meeting**: First team sync with Yana, Zineng, Abhimanyu, Atul. Architecture walkthrough confirmed two modes (user/local vs control plane), conductor as central gateway, arkd as per-compute agent manager. TUI retired by consensus. Web UI + CLI + Electron desktop as product surfaces. Zineng orienting on codebase (first tasks: web UI improvements). Abhimanyu building model benchmarks and exploring ACP. Team regroups Apr 15 for roadmap after orientation period. Yana on break until Thu Apr 17 (worked over weekend, out of Claude tokens).
- **Tauri consideration (2026-04-14)**: Zineng flagged Tauri v2 as potential Electron alternative. Smaller binary size, Rust backend, better security model. Scaffolded 2026-04-15 under `packages/desktop-tauri/`. **Decision (v0.17.0)**: staying with Electron -- simpler toolchain (no Rust needed), native Playwright testing, and the binary size advantage is moot once ark-native (~78 MB) is bundled regardless. Tauri scaffold removed.
- **MiniMax economics (2026-04-14)**: Input $0.30/Mtok, output $1.00/Mtok vs Claude Opus input $15/Mtok, output $75/Mtok. ~25-75x cheaper. ~90% performance for mechanical tasks per Abhimanyu's benchmarks. GLM also competitive on some benchmarks. Strategy: use cheap models for mechanical work (implement, verify) and expensive models for judgment work (plan, review).
- **Native skill gap (2026-04-14)**: Abhimanyu asked about integrating native skills (like superpowers) into dispatched sessions. Yana: "I added native skill support at some point. Maybe dropped at some point." Needs investigation -- may have regressed during refactors.

---

## Mission Control Feature Gaps (detailed)

From deep analysis of builderz-labs/mission-control (32 panels):

| MC Feature | Ark Status | Priority |
|-----------|-----------|----------|
| Overview dashboard (widget grid) | **DONE** (v0.12.0) | -- |
| Cost charts (Recharts pie/line/bar) | **DONE** (v0.12.0) | -- |
| Smart polling (pause when tab hidden) | **DONE** (v0.12.0) | -- |
| Agent detail depth (11 tabs: overview, soul, memory, tasks, activity, config, files, tools, channels, cron, models) | Partial (2 tabs: roles + runtimes) | Medium |
| Task board (8-column Kanban with dispatch, retry, quality gate) | **NOT BUILT** | High |
| Aegis quality review (agent-to-agent blocking review before completion) | **NOT BUILT** | High |
| Exec approval queue (real-time approve/deny tool calls with risk classification) | **NOT BUILT** | Medium |
| Security posture score (0-100 composite) | **NOT BUILT** | High |
| Trust scoring per agent (weighted event history) | **NOT BUILT** | Medium |
| Secret detection (scan tool I/O for API keys) | **NOT BUILT** | Medium |
| Audit trail (immutable log with IP/user-agent) | **NOT BUILT** | High |
| Outbound webhooks (HMAC-SHA256, retry, circuit breaker) | **NOT BUILT** | Medium |
| Declarative alert rules (entity/field/operator/value → action) | **NOT BUILT** | Medium |
| GitHub Issues bidirectional sync | **NOT BUILT** (auto-PR only) | Medium |
| Multi-gateway support (connect multiple LLM gateways) | **NOT BUILT** (single router) | Low |
| Agent eval framework (completion rate, correctness, tool latency, drift) | **DONE** (v0.12.0 -- evaluateSession, getAgentStats, detectDrift) | -- |
| Standup reports (auto-generated daily per agent) | **NOT BUILT** | Low |
| Notifications (@mention inbox) | **NOT BUILT** | Low |
| Office spatial visualization (agents at desks) | **NOT BUILT** (skip -- gimmick) | Skip |
| System monitor (CPU/mem/disk/GPU charts) | **NOT BUILT** | Low |
| Cron with natural language + calendar view | Partial (cron list, no NLP/calendar) | Low |
| Boot sequence with progress steps | **NOT BUILT** | Low |
| Live feed sidebar (real-time events without leaving view) | **NOT BUILT** | Medium |
| User management UI (full CRUD) | **NOT BUILT** (CLI only) | Medium |
| Google/GitHub SSO | **NOT BUILT** | Medium |
| Pipeline builder (visual workflow editor) | **NOT BUILT** (YAML-only flow definition) | Low |
| i18n (10 languages) | **NOT BUILT** | Low |
| Onboarding wizard | **NOT BUILT** | Low |

## Slack Thread Gaps (Harinder + Abhimanyu)

| Requirement | Ark Status | Gap |
|-------------|-----------|-----|
| "Send to dev" -- PRD → remote devbox → tested PR at 95% | SDLC flow exists, never tested E2E | Need: real Jira E2E test, verified compute, crash recovery |
| Server mode with per-user MCP credentials | Auth + tenants exist, MCP creds not per-user | Need: user-level MCP credential storage |
| Chat history on server | Knowledge graph stores sessions | Need: verify conversation persistence in hosted mode |
| Connect Goose scripts to server | Ark replaces Goose. CLI-agent runtime runs any tool. | Need: verify codex/gemini/aider runtimes work |
| Goose recipe orchestration with sub-recipes | SDLC flow stages map to sub-recipes | Need: verify stage → recipe mapping works |

## SoulForge / Codebase Intelligence Gaps

| Feature | Ark Status | Gap |
|---------|-----------|-----|
| PageRank ranking of files | ops-codegraph does this (via indexer) | Need: verify codegraph integration works with real repo |
| Blast radius scoring | knowledge/impact MCP tool exists | Need: real-world testing |
| Symbol-level extraction (33+ languages) | ops-codegraph handles via tree-sitter WASM | Need: codegraph as required dependency, tested |
| Git co-change history | indexCoChanges() in indexer.ts | Need: real-world testing |
| Real-time graph updates as files change | Incremental indexing on session completion | Need: verify incremental path works |

## LLM Router Research Gaps

| Finding | Ark Status | Gap |
|---------|-----------|-----|
| Prompt caching (90% savings) | Not implemented | Need: pass-through caching headers to providers |
| Batch API (50% savings on async) | Not implemented | Need: batch endpoint in router |
| Semantic caching (31% of queries cacheable) | Not implemented | Need: embedding-based cache in router |
| Bandit-based online learning | Not implemented (rule-based classifier only) | Need: feedback loop → routing weights |
| Multi-turn warm handoff | Sticky sessions exist but no handoff with context summary | Need: conversation summarization on model switch |
| Tool-call reliability matrix | Not tracked | Need: per-model tool success rate tracking |

## Key Decisions Made

1. **Temporal for control plane workflow engine.** Start with local event-sourced engine, plan for Temporal hosted backend. Same WorkflowEngine interface.
2. **TensorZero replaces our hand-rolled LLM provider adapters.** Keep our routing intelligence (classifier, task-aware policies, tenant policies, sticky sessions). TensorZero handles API dispatch (format conversion, retries, streaming, A/B testing, feedback optimization). Runs as Rust sidecar. Apache 2.0.
3. **Async Postgres repos** required for hosted scale. Camp 9 priority.
4. **Task board:** Tasks sit ABOVE sessions. Creating a task doesn't dispatch -- dispatching a task creates a session.
5. **TUI as pure RPC client.** All TUI components communicate via ArkClient RPC, not direct AppContext. Makes local and remote mode identical. In-memory transport pair for local mode avoids network overhead.
6. **DAG engine: dual routing model.** Static routing via `on_outcome` (agent-reported labels) for deliberate branching. Dynamic routing via `condition` (JS expressions against session data) for data-driven flow control. Both coexist on the same stage/edge.
7. **on_failure retry with error context injection.** Failed stages re-dispatch with the failure reason injected into the task prompt, not just retried blindly. Max retries configurable per stage via `on_failure: "retry(N)"`.
8. **Auto-rebase default-on, conflict-tolerant.** PR branches auto-rebase onto base before creation. Conflicts abort the rebase and proceed with PR anyway -- human handles the merge conflict in the PR itself.
9. **TUI retired (2026-04-14).** Product surfaces: Web UI + CLI + Electron desktop app. TUI code stays in repo, no further investment. Reason: most expensive to maintain, hardest to test, least intuitive for new users.
10. **Web UI is the primary interface (2026-04-14).** Everything doable from web without CLI. Conversation interface, repo dropdown, session wizard are ship-blockers.
11. **Channels remain the Claude Code agent communication path (2026-04-14).** ACP is exploratory (POC), not a replacement. Claude Code and Codex don't officially support ACP.
12. **Plan with Opus, implement with cheap models (2026-04-14).** LLM Router should support per-stage model routing. MiniMax (~1/10th Claude cost) for mechanical tasks.
13. **Benchmarking feeds routing (2026-04-14).** Task-based model benchmarks (not just prompting) should inform LLM Router routing weights per task category.
14. **Decoupled compute architecture (2026-04-14).** Separate agent fleet from compute fleet. Current: Session 1:1 Agent 1:1 Compute. Target: Session 1:N Agent 1:M Compute. Agents are cheap/stateless (LLM loop only), compute is expensive/persistent (repo, tools, dev servers). Agents connect to compute via tools over network (arkd). Scale independently, hibernate compute without losing agent state. Solves multi-repo naturally (one agent, N compute attachments).
15. **Compute lifecycle: hibernate/snapshot/restore (2026-04-14).** Compute targets should support hibernate (stop billing), snapshot (save state), restore (resume). E2B has snapshots, EC2 has AMIs, Docker has checkpoint, Firecracker has snapshotting. Expose universally via compute provider interface.
16. **Web UI overhaul from Open Agents patterns (2026-04-14).** Borrow 10+ components: tool call renderers, git panel, todo panel, structured questions, model selector, contribution charts, stream recovery. Current Ark web is ~6K lines; Open Agents is ~43K. Clone at /tmp/open-agents for reference.

## TensorZero Integration Plan

**What we keep (Ark routing layer):**
- `classifier.ts` -- task complexity scoring with Ark-specific signals
- `engine.ts` -- routing policies (quality/balanced/cost, per-tenant, per-agent)
- Sticky sessions -- multi-turn conversation tracking
- Cost attribution -- per-session/user/tenant/agent/model breakdown via UsageRecorder
- Knowledge context injection -- codebase awareness before routing

**What TensorZero replaces:**
- `providers.ts` -- our untested Anthropic/OpenAI/Google adapters
- `dispatch.ts` -- our fallback/circuit breaker logic
- Streaming -- our SSE proxy
- Feedback loop -- manual evaluateSession → TensorZero's native optimization

**Architecture:**
```
Agent → Ark Routing Layer (classify, policy, context) → TensorZero (Rust sidecar) → LLM Provider
```

**Deployment:** TensorZero as Docker sidecar in Helm chart + docker-compose. Agents point to TensorZero endpoint. Ark routing layer makes model decision, forwards to TensorZero for dispatch.

---

## Key Learnings

1. Architecture before features (DI, database abstraction, compute interfaces).
2. Global state is poison (225 getApp() calls eliminated).
3. Process leaks are insidious (fixed by: awaited dispatches, stopAll, provider kill chain).
4. Build ≠ integrated (7 providers, router, auth, Postgres -- none tested against real services).
5. Knowledge should be unified (7 systems → 1 graph).
6. Theme consistency matters (0 hardcoded colors).
7. DAG engine needs both static (depends_on, on_outcome) and dynamic (condition expressions) routing -- real workflows aren't linear.
8. TUI-as-daemon-client pays for itself: one rewire makes local + remote mode identical, and eliminates an entire class of getApp() coupling bugs.
9. Agents need explicit completion protocols in their prompts -- without them, agents finish work but forget to report status, leaving sessions stuck.
10. Auto-rebase before PR reduces merge conflicts but must handle conflicts gracefully (abort + proceed) -- blocking PR creation on rebase failure is worse than the conflict.
7. Mission Control sets the UX bar (32 panels vs our 11 views).
8. Cost tracking must be universal (not just Claude -- every provider, every user, every dimension).
11. TUI is a maintenance trap. Rich content in text is hard to represent, testing is "literally hell," and agents are bad at fixing TUI bugs. Web UIs are easier to build, test, and iterate on. Retire early, not late.
12. Plan with expensive models, implement with cheap ones. Most coding work is mechanical once the plan is set -- use 1/10th-cost models for the bulk of token spend.
13. ACP adoption is fragmented -- don't bet on it yet. Only Gemini has native support. Keep channels as the Claude Code path and explore ACP as a parallel option.
14. Benchmarking on real tasks beats synthetic benchmarks. Model comparison should use actual repo tasks (JWT update, PR review, MCP tool calling), not isolated prompts.
15. Decouple agents from compute. Agent VMs are cheap (LLM loop). Compute VMs are expensive (repo, tools, dev servers). When coupled 1:1, you overpay for idle compute and can't share repos across agents. The "agent outside sandbox" pattern from Open Agents enables independent fleet scaling, compute hibernation, and natural multi-repo support.
16. Compute state should be a serializable JSON blob. If you can serialize compute state (resource ID, pool, status, snapshot URL), you can hibernate it, restore it, move it, and share it -- same pattern as Open Agents' SandboxState. Arkd is already the network boundary.
