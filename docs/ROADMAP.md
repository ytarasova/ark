# Ark Platform Roadmap

> Last updated: 2026-04-12 (full-day session -- autonomous SDLC, commit gates, worktree cleanup, brainstorm flow)
> Unit tests: 2724 pass, 0 fail, 0 lint errors, 0 process leaks
> E2E tests: 89 TUI (`packages/tui-e2e/`) + 78 web (`packages/e2e/web/`) = **167 passing, 0 skipped, 0 failed**
>
> **2026-04-10 decision (Foundry 2.0 review meeting):** Ark selected as the company-wide dev-workflow orchestrator -- the layer ABOVE tools like Goose / Claude Code / Codex, not a replacement. Framed as "the foundry" (control plane) with those tools as "the machines." First hand-out to early adopters targeted for the week of 2026-04-13. See **Camp 0: Early Adopter Ship** below.
>
> **2026-04-12 session shipped on `main`:**
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

The orchestration platform for AI-powered software development. Manages the full lifecycle -- from ticket to merged PR -- across any agent, any model, any compute target. Runs locally as a CLI/TUI or hosted as a multi-tenant service with a control plane.

**Positioning (post-Apr-10 decision):** Ark is an opinionated control plane that orchestrates agents; it does not replace the agent runtimes themselves. Goose, Claude Code, Codex, Gemini are the "machines on the factory floor." Ark provides central knowledge, memory, cost tracking, LLM routing, compute provisioning, flow engine, and multi-tenant governance so a company can change models, policies, or skills in ONE place and have it propagate everywhere. The test we want to pass: an agent autonomously finds and fixes a real bug, and the only reason a human hears about it is the commit notification.

---

## Status: What's Done, What's Partial, What's Missing

### DONE -- Fully built, unit-tested, integrated

| Area | Details | Tests |
|------|---------|-------|
| **Awilix DI container** | All services/repos/stores resolve from AppContext. Zero `getApp()` in production code. | Yes |
| **IDatabase abstraction** | SQLite adapter (local). Postgres adapter (hosted -- sync-over-async, see caveats). | Yes |
| **Session orchestration** | Full lifecycle: start, dispatch, stop, resume, advance, complete, fork, clone, spawn, fan-out, handoff. | Yes |
| **DAG flow engine** | `depends_on`, parallel stages, auto-join on child completion, branch merge with conflict detection. | Yes |
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
| **Vendor freshness CI** | `vendor/versions.yaml` codifies pinned upstream versions for goose, codex, tmux, tensorzero, codegraph. Weekly scheduled workflow (`.github/workflows/vendor-freshness.yml`) polls upstream releases and opens a PR bumping the manifest when upstream is newer. Every bump goes through CI + human review, no auto-merge. | N/A |
| **Module reorganization** | 91 flat files reorganized into 13 domain directories. Barrel exports. All imports updated. | Yes |
| **SDLC flows** | 7-stage pipeline (intake, plan, audit, execute, verify, close, retro). 12 flow definitions (incl. autonomous, autonomous-sdlc, brainstorm). | Yes |
| **Skills** | 7 builtin (spec-extraction, sanity-gate, plan-audit, security-scan, self-review, code-review, test-writing). | Yes |
| **Recipes** | 10 templates (islc, islc-quick, ideate, quick-fix, feature-build, code-review, fix-bug, new-feature, self-dogfood, self-quick). | Yes |
| **CLI** | 17 command modules. `ark dashboard/knowledge/eval/router/runtime/tenant/auth` all working. | Yes |
| **Web UI** | Dashboard (widget grid + Recharts cost charts), Sessions, Agents+Runtimes, Flows, Compute, History, Memory/Knowledge, Tools, Schedules, Costs, Settings, Login. | Yes |
| **TUI** | 9-tab dashboard. Theme-driven (0 hardcoded colors). Dashboard summary in empty state. ASCII cost charts. Agents+Runtimes sub-groups. | Yes |
| **ESLint** | 0 errors, 0 warnings. CI lint step. | Yes |
| **Process leak prevention** | stopAll via provider, awaited dispatches, proper shutdown order. | Yes |
| **Auth** | API keys (create/validate/revoke/rotate), tenant_id on all entities, per-tenant AppContext, auth middleware. | Yes |
| **Session launcher** | Interface: TmuxLauncher, ContainerLauncher, ArkdLauncher. Orchestration uses `app.launcher.*` not direct tmux. | Yes |
| **Auto-start dispatch** | Native CLI arg injection per executor replaces fragile tmux pane polling. Claude: positional arg. Codex/Gemini: `initialPrompt` via LaunchOpts (arg/stdin/file modes). Goose: `-t` + `-s` (stay-alive for manual-gate). Old `deliver-task.ts` module deleted. | Yes |
| **Autonomous flow** | `flows/definitions/autonomous.yaml` -- single stage, `gate: auto`. `SessionEnd` hook on running auto-gate session triggers implicit completion via `advance()`. Three completion paths (manual report, auto-advance, hook-fallback) all covered by e2e tests. | Yes |
| **Channel permissions** | `mcp__ark-channel__*` always included in `permissions.allow` -- system infrastructure injected at dispatch, not declared in agent YAML. Ensures `report` and `send_to_agent` tools work for all 12 agents. | Yes |
| **Autonomous-SDLC flow** | `flows/definitions/autonomous-sdlc.yaml` -- four auto-gated stages (plan -> implement -> review -> pr). Self-dogfood recipe uses this flow. `self-quick` recipe for trivial tasks. | Yes |
| **Auto-merge action stage** | `auto_merge` action runs `gh pr merge --squash --auto`. Added to autonomous-sdlc and quick flows. Completes plan-to-merge pipeline. | Yes |
| **Commit verification gates** | Two-layer gate: `applyReport()` checks `git status --porcelain` for uncommitted tracked files; conductor runs `runVerification()` before advancing agent stages. Worker agent system prompt enforces commit-before-completion. | 276 tests |
| **Worktree auto-cleanup** | `removeSessionWorktree()` cleans up `~/.ark/worktrees/<sessionId>` on stop/delete via `git worktree remove --force` + `rmSync` fallback. Provider-independent. | Yes |
| **Brainstorm flow** | `flows/definitions/brainstorm.yaml` -- three manual-gated stages (explore -> synthesize -> plan) for interactive ideation. | Yes |
| **Channel path centralization** | `CHANNEL_SCRIPT_PATH` constant in `constants.ts` replaces 3 hardcoded `path.join(__dirname, ...)` resolutions across providers + claude.ts. | Yes |
| **Local provider singleton** | `ComputeRepository.create()` enforces one row per singleton provider+tenant combo. Prevents ghost compute entries from parallel dispatch. | Yes |
| **TUI session grouping** | `%` key toggles grouping sessions by status (Running, Waiting, etc.) with meaningful sort order. TreeList `groupSort` prop. | Yes |
| **CLI status validation** | `ark session list --status` uses Commander `.choices()` with exported `SESSION_STATUSES` array. | Yes |
| **MCP config stubs** | Templates for Atlassian, GitHub, Linear, Figma. | N/A |

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
| **Remote client** | `--server`/`--token` for CLI, TUI, Web. WebSocket transport. Web proxy mode. | Never tested with a real remote server. | High |
| **Auth middleware** | Token extraction, tenant scoping in web server. | Never tested with real multi-user sessions. No session management. | Medium |
| **SDLC flow E2E** | Full pipeline defined with agents, skills, recipes. Flow progression mechanics exercised by `flows.pw.ts` + `flows.spec.ts` -- walks `default` flow through all 9 stages via `session/advance`, asserts each transition. | Never processed a real Jira ticket end-to-end with a real Claude agent. MCP integrations (Atlassian, Bitbucket, Figma) still untested against live services. | Medium |
| **OTLP observability** | `otlp.ts` sends spans to OTLP/HTTP endpoint. | Never tested against real Jaeger/Tempo/Honeycomb. | Medium |
| **Knowledge: Axon indexer** | Calls Axon subprocess, parses output, stores in graph. | Never tested with real Axon installed. Mock-tested only. | Medium |
| **Cost: router feed-back** | Router has in-memory cost tracking. UsageRecorder exists. | Router doesn't call `app.usageRecorder.record()` yet. Not wired. | Medium |
| **Cost: non-Claude runtimes** | UsageRecorder supports any model/provider. | Codex/Gemini/Aider executors don't report usage yet. Only Claude transcript parsing works. | High |
| **Dashboard** | Web widget grid, TUI summary, CLI command. | Data sources are partially mocked. No real fleet to visualize. | Low |
| **Deployment** | Dockerfile, docker-compose, Helm chart. | Never built the Docker image. Never `helm install`-ed. Never pushed to registry. | High |

### NOT BUILT -- Identified gaps, no code exists

| Area | Why it matters | Source |
|------|---------------|--------|
| **Remote Claude subscription auth provisioning** | Soft preference (not hard ban) for subscription auth at fleet scale to avoid per-token bills. Local `claude-max` works; provisioning N remote VMs with device-code login is the open question. API-key mode stays supported -- this is a "make the non-key path work too," not "delete keys." | 2026-04-10 meeting |
| **MiniMax / DeepSeek / self-hosted provider support** | Internal teams are hosting OSS models (DeepSeek) and have free MiniMax credits. Router must accept custom OpenAI-compatible endpoints with zero-cost tracking. Jay: "share the key you can use with some on our API" / "let's start hosting them." | 2026-04-10 meeting |
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
| **Higress gateway integration** | Custom router works for dev. Enterprise needs CNCF-grade gateway. | LLM Router research |
| **Knowledge graph visualization** | No visual rendering of the graph in web UI. MC uses reagraph. | Mission Control gap analysis |
| **Live feed sidebar** | No real-time event stream without leaving current view. MC has collapsible sidebar. | Mission Control gap analysis |
| **Boot sequence** | No staged loading screen with progress. MC shows 9-step boot. | Mission Control gap analysis |

---

## Roadmap Camps

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

**Candidate "in scope" for the first hand-out** (builder trio to confirm):
- Local docker compute with worktree isolation (no AWS creds required on the user's laptop)
- Optionally **federated compute via Ark token** (see Camp 12) for users who need heavier than local docker -- lets them hit remote EC2/k8s/firecracker without any cloud credentials
- `claude-max` + `codex` + `goose` runtimes, subscription auth preferred over API keys
- Knowledge graph auto-index on dispatch (already DONE)
- One polished flow: `code-review` or `fix-bug`, driven from web UI
- Web dashboard (local mode), limited to Sessions / Flows / Knowledge tabs
- Cost tracking visible even when it's $0 (subscription mode)

**Candidate "out of scope" for the first hand-out:**
- Control plane / multi-tenant (builder team uses local mode first)
- K8s / E2B / Firecracker providers (untested -- see Camp 1)
- Pre-engineering product flow (ideate/PRD) -- defer to Camp 10
- Dev-environment provisioning with dynamic DNS -- defer to Camp 10

**Ship-blockers to resolve this week:**
| Blocker | Owner | Notes |
|---------|-------|-------|
| Unified Claude settings bundle (tools, OTEL, cost, router, hooks) | Yana | **Camp 0 slice DONE (2026-04-11):** `.claude/settings.local.json` writer extended with `buildPermissionsAllow(agent)` -- maps `agent.tools` into `permissions.allow`, auto-expands declared `mcp_servers` to `mcp__<server>__*` wildcards, rejects explicit `mcp__X__*` entries that reference undeclared servers, and cleans up on session stop via the `_ark.managedAllow` marker. **Confirmed design:** `--dangerously-skip-permissions` (autonomy=full) remains the explicit override -- it bypasses the allow list on purpose. The list is authoritative when bypass is off. **Still to land on the same writer:** OpenTelemetry exporter config, cost-tracking / router URL env vars, Codex / Gemini executor parity (different permission models), load-time agent validation. |
| ISLC recipe decomposition audit | Yana + Abhimanyu | Ark ships consolidated `islc.yaml` / `islc-quick.yaml`; Abhimanyu's Goose set has 9 separate sub-recipes with specific MCP tool contracts. Decide port-vs-consolidate before hand-out. Porting the decomposed form requires sub-recipe runtime invocation -- see Camp 10. |
| Decide in/out feature list | Yana + Abhimanyu + Zining | Monday sync |
| Bug-sweep the chosen surface (limited-features smoke pass) | Yana | Keep tests green |
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
| Test remote client mode (TUI/CLI → remote server) | 1 day | Multi-user |
| Test Axon indexer with real codebase | 0.5 day | Knowledge graph |

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
| Security dashboard panel (Web+TUI) | 1 day |

### Camp 6: Integrations & Webhooks

**Goal:** Ark connects to the tools teams already use.

| Task | Effort |
|------|--------|
| Outbound webhook system (HMAC-signed, retry, circuit breaker) | 2-3 days |
| Declarative alert rules | 1-2 days |
| GitHub Issues bidirectional sync | 2-3 days |
| Slack commands + thread-based interaction | 2-3 days |
| Linear integration | 1-2 days |
| Webhook/alert management panels (Web+TUI) | 1 day |

### Camp 7: Task Management

**Goal:** Agents have a work queue. Humans can assign, prioritize, and review.

| Task | Effort |
|------|--------|
| Task table (new schema -- separate from sessions) | 1 day |
| Kanban board UI (Web) | 2-3 days |
| Task list view (TUI) | 1 day |
| `ark task create/list/assign/dispatch` CLI | 1 day |
| Quality gate / Aegis review system (agent-to-agent review) | 2-3 days |
| Task → session mapping | 1 day |
| Task feedback rating + comments | 1-2 days |

### Camp 8: User Experience Polish

**Goal:** Professional, polished product.

| Task | Effort |
|------|--------|
| Full user management UI (create/edit/delete users, roles) | 1-2 days |
| Google/GitHub SSO | 1-2 days |
| Access request workflow | 1 day |
| i18n foundation | 1-2 days |
| Natural language schedule parsing | 1 day |
| Calendar view for schedules | 1-2 days |

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
| Web + TUI: multi-repo session list, multi-repo diff preview | 2 days | Surface parity rule applies -- every surface shows all session repos. |
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

### Camp 9: Architecture Hardening

**Goal:** Codebase is production-grade and maintainable.

| Task | Effort | Status |
|------|--------|--------|
| ~~Core module reorganization~~ | ~~3-5 days~~ | **DONE** -- 13 domain directories |
| ~~Delete old eval system~~ | ~~1-2 days~~ | **DONE** |
| ~~Delete old knowledge systems~~ | ~~1-2 days~~ | **DONE** -- memory.ts, learnings.ts, hybrid-search.ts, knowledge.ts |
| Async repo layer for Postgres | 3-5 days | Not started -- blocks hosted scale |
| CI/CD pipeline (build/test/publish) | 1-2 days | Not started |
| Higress gateway integration (enterprise) | 2-3 days | Research done, not started |

---

## Priority Sequence

```
Camp 0:  Early Adopter Ship       ████████████   IMMEDIATE -- week of Apr 13, limited-features hand-out
Camp 1:  Integration Testing      ██             Mostly DONE: 167 e2e tests, TUI harness + web harness green,
                                                 flow/cost/dispatch contracts covered. Remains: real LLM router
                                                 smoke, K8s/E2B/arkd real-service runs, Docker image publish
Camp 10: Dev-Env + Pre-Eng        ██████████     Unblocks Claude-at-fleet, non-engineer adoption (Traefik, VaultMan,
                                                 sub-recipe runtime, MiniMax router adapter, ideate flow)
Camp 11: Multi-Repo Support       ██████████     Design decisions locked; lands after pilot closes first bug
Camp 12: Federated Compute        ██████████     Unblocks pilot: local client + remote compute via token, no AWS creds
Camp 13: Plugin Platform          ████████       Phase 1 DONE (PluginRegistry + DI); Phases 2-4 (unify stores,
                                                 manifest/versioning/hot-reload, sandboxing)
Camp 2:  Workflow Persistence     ████████       Temporal + crash recovery
Camp 3:  Agent Intelligence       ████           Partial (evals, costs done; trust scoring, latency p50/p95 remain)
Camp 4:  Dashboard & Viz          ████           Partial (dashboard, charts, smart polling done; live feed, graph viz remain)
Camp 5:  Security                 ██████         Enterprise blocker (audit trail, posture score, exec approval, secret detection)
Camp 9:  Architecture             ████           Partial (DI, PluginRegistry, schema cleanup done; async Postgres remains)
Camp 6:  Integrations             ██████         Webhooks, alert rules, GitHub Issues sync, Linear, Slack commands
Camp 7:  Task Management          ████████       Task board ABOVE sessions, Aegis review, quality gates
Camp 8:  UX Polish                ██████         Desktop .dmg shipping (currently broken), Homebrew, onboarding wizard, i18n
```

**What changed in this update (2026-04-12):**

- Autonomous SDLC pipeline is now end-to-end: plan -> implement -> review -> PR -> auto-merge,
  with commit verification gates preventing agents from advancing with uncommitted work.
- 11 new flow definitions: `autonomous-sdlc.yaml` (4-stage auto-gated) and `brainstorm.yaml`
  (3-stage manual-gated for ideation). `auto_merge` action stage added to quick flow too.
- Worktree lifecycle hardened: auto-cleanup on stop/delete, provider-independent.
- Channel MCP path resolution centralized in `CHANNEL_SCRIPT_PATH` -- eliminates a class of
  post-reorg breakage across providers.
- Codex/Gemini sessions now finish correctly (poller `not_found` fix + conductor action-stage fix).
- Local compute no longer ghosts (singleton enforcement).
- TUI gains session-by-status grouping (`%`), web gains keyboard shortcuts for sessions.
- CLI `--status` validation, Gemini dispatch test suite, ARG_MAX dispatch fix all landed.

---

## Competitive Landscape

| Product | Their strength | Our strength | Gap to close |
|---------|---------------|-------------|--------------|
| **Mission Control** | 32-panel dashboard, Kanban, security posture, webhooks | Compute orchestration, DAG flows, knowledge graph | Dashboard depth, task board, security |
| **SoulForge** | Codebase knowledge graph, PageRank, blast radius | Unified knowledge (code + sessions + memories) | Symbol-level precision (Axon handles this) |
| **Goose** | Recipe-based SDLC, server mode | We replaced Goose's recipes with native Ark flows | Server mode (our control plane) |
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
| PageRank ranking of files | Axon does this (via indexer) | Need: verify Axon integration works with real repo |
| Blast radius scoring | knowledge/impact MCP tool exists | Need: real-world testing |
| Symbol-level extraction (33+ languages) | Axon handles via tree-sitter | Need: Axon as required dependency, tested |
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
7. Mission Control sets the UX bar (32 panels vs our 11 views).
8. Cost tracking must be universal (not just Claude -- every provider, every user, every dimension).
