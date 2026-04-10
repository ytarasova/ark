# Ark Platform Roadmap

> Last updated: 2026-04-10 (end of session)
> Tests: 2580 pass, 0 fail, 0 lint errors, 0 process leaks

---

## What Ark Is

The orchestration platform for AI-powered software development. Manages the full lifecycle -- from ticket to merged PR -- across any agent, any model, any compute target. Runs locally as a CLI/TUI or hosted as a multi-tenant service with a control plane.

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
| **Runtime/role separation** | Agents define roles. Runtimes define backends. 4 runtimes: Claude, Codex, Gemini, Aider. 12 agent roles. `--runtime` override at dispatch. | Yes |
| **Module reorganization** | 91 flat files reorganized into 13 domain directories. Barrel exports. All imports updated. | Yes |
| **SDLC flows** | 7-stage pipeline (intake, plan, audit, execute, verify, close, retro). 9 flow definitions. | Yes |
| **Skills** | 7 builtin (spec-extraction, sanity-gate, plan-audit, security-scan, self-review, code-review, test-writing). | Yes |
| **Recipes** | 8 templates (islc, islc-quick, ideate, quick-fix, feature-build, code-review, fix-bug, new-feature). | Yes |
| **CLI** | 17 command modules. `ark dashboard/knowledge/eval/router/runtime/tenant/auth` all working. | Yes |
| **Web UI** | Dashboard (widget grid + Recharts cost charts), Sessions, Agents+Runtimes, Flows, Compute, History, Memory/Knowledge, Tools, Schedules, Costs, Settings, Login. | Yes |
| **TUI** | 9-tab dashboard. Theme-driven (0 hardcoded colors). Dashboard summary in empty state. ASCII cost charts. Agents+Runtimes sub-groups. | Yes |
| **ESLint** | 0 errors, 0 warnings. CI lint step. | Yes |
| **Process leak prevention** | stopAll via provider, awaited dispatches, proper shutdown order. | Yes |
| **Auth** | API keys (create/validate/revoke/rotate), tenant_id on all entities, per-tenant AppContext, auth middleware. | Yes |
| **Session launcher** | Interface: TmuxLauncher, ContainerLauncher, ArkdLauncher. Orchestration uses `app.launcher.*` not direct tmux. | Yes |
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
| **SDLC flow E2E** | Full pipeline defined with agents, skills, recipes. | Never processed a real Jira ticket end-to-end. MCP integrations untested. | High |
| **OTLP observability** | `otlp.ts` sends spans to OTLP/HTTP endpoint. | Never tested against real Jaeger/Tempo/Honeycomb. | Medium |
| **Knowledge: Axon indexer** | Calls Axon subprocess, parses output, stores in graph. | Never tested with real Axon installed. Mock-tested only. | Medium |
| **Cost: router feed-back** | Router has in-memory cost tracking. UsageRecorder exists. | Router doesn't call `app.usageRecorder.record()` yet. Not wired. | Medium |
| **Cost: non-Claude runtimes** | UsageRecorder supports any model/provider. | Codex/Gemini/Aider executors don't report usage yet. Only Claude transcript parsing works. | High |
| **Dashboard** | Web widget grid, TUI summary, CLI command. | Data sources are partially mocked. No real fleet to visualize. | Low |
| **Deployment** | Dockerfile, docker-compose, Helm chart. | Never built the Docker image. Never `helm install`-ed. Never pushed to registry. | High |

### NOT BUILT -- Identified gaps, no code exists

| Area | Why it matters | Source |
|------|---------------|--------|
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

### Camp 1: Integration Testing & Production Readiness

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
Camp 1: Integration Testing      ████████████   FIRST -- prove what we built works
Camp 2: Workflow Persistence     ████████       Temporal + crash recovery
Camp 3: Agent Intelligence       ████           Partially done (evals, costs done; trust, latency remain)
Camp 4: Dashboard & Viz          ████           Partially done (dashboard, charts done; live feed, graph viz remain)
Camp 5: Security                 ██████         Enterprise blocker
Camp 9: Architecture             ████           Partially done (reorg, old code deleted; async Postgres remains)
Camp 6: Integrations             ██████         Connect to existing tools
Camp 7: Task Management          ████████       New capability
Camp 8: UX Polish                ██████         Professional finish
```

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

- **Foundry 2.0**: QA Infra (fan-out test suites) + AI Monitor (Prometheus + Slack alerts). Apr 20 deadline.
- **Team**: Converting Goose recipes → Ark handles this. Server mode needed → control plane addresses it.
- **"Send to dev"**: PRD ready → remote devbox → tested PR at 95% readiness. Requires: Camp 1 (integration testing) + Camp 2 (workflow persistence).
- **Risk team (PAI-32794)**: Per-user MCP credentials, chat history on server → auth + control plane + knowledge graph.

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

## Key Decisions Needed

1. **Temporal for control plane workflow engine?** Plan: start with local event-sourced engine, plan for Temporal hosted backend. Same WorkflowEngine interface.
2. **Async Postgres repos?** Required for hosted scale. Big refactor. Should be Camp 9 priority.
3. **Higress vs custom router?** Custom for dev/small. Higress for enterprise. Both behind same config.
4. **Task board scope?** Tasks sit ABOVE sessions. Creating a task doesn't dispatch -- dispatching a task creates a session.

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
