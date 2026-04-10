# Ark Platform Roadmap

> Last updated: 2026-04-10

---

## What Ark Is

The orchestration platform for AI-powered software development. Manages the full lifecycle -- from ticket to merged PR -- across any agent, any model, any compute target. Runs locally as a CLI/TUI or hosted as a multi-tenant service with a control plane.

---

## What's Done

### Core Platform (2552+ tests, 0 fail, 0 lint errors, 0 process leaks)

| Area | What's built |
|------|-------------|
| **DI Container** | Awilix-based. All services/repos/stores resolve from AppContext. Zero global state in production code. |
| **Database** | IDatabase abstraction. SQLite (local) + Postgres adapter (hosted). |
| **Session Orchestration** | Full lifecycle: start, dispatch, stop, resume, advance, complete, fork, clone, spawn, fan-out, handoff. |
| **DAG Flow Engine** | `depends_on` field, parallel stages, auto-join on child completion, branch merge with conflict detection. |
| **Compute Providers (7)** | Local (tmux), Docker, DevContainer, Firecracker (local+EC2), EC2+ArkD, E2B (managed sandboxes), K8s (vanilla+Kata). |
| **LLM Router** | OpenAI-compatible proxy. Request classifier, 3 policies (quality/balanced/cost), sticky sessions, circuit breakers, cascade fallback. |
| **Knowledge Graph** | Unified store: codebase (Axon indexer), sessions, memories, learnings, skills -- all as typed nodes with edges. MCP tools for agents. Context injection at dispatch. Markdown export/import. |
| **Auth & Multi-Tenancy** | API keys, tenant_id on all entities, per-tenant AppContext, auth middleware. |
| **Session Launcher** | Interface abstraction: TmuxLauncher (local), ContainerLauncher (Docker/K8s), ArkdLauncher (remote). |
| **Control Plane** | Worker registry, session scheduler, tenant compute policies, Redis SSE bus. |
| **SDLC Flows** | 7-stage pipeline (intake, plan, audit, execute, verify, close, retro). 16 agents, 7 skills, 5 recipes. |
| **Runtime/Role Separation** | Agents define roles (what). Runtimes define backends (how). Any role on any runtime. 4 runtimes: Claude, Codex, Gemini, Aider. |
| **Remote Client** | CLI/TUI/Web connect to hosted control plane via `--server`/`--token`. Web proxy mode. |
| **Deployment** | Dockerfile, docker-compose (control-plane + workers + Postgres + Redis), Helm chart with Kata/Firecracker support. |
| **CLI** | 14 command modules (from 2367-line monolith). |
| **Web UI** | Domain-scoped queries/pages. Sessions, Agents+Runtimes, Flows, Compute, History, Memory, Tools, Schedules, Costs, Settings, Login. |
| **TUI** | 9-tab React/Ink dashboard. All colors from theme.ts. Keyboard-driven. |
| **ESLint** | 0 errors, 0 warnings. CI lint step. |
| **MCP Configs** | Stubs for Atlassian, GitHub, Linear, Figma. |

---

## What's NOT Done (Honest Assessment)

### Built but NOT integration-tested

These exist as code with unit tests but have never been tested against real external services:

| Item | Risk |
|------|------|
| LLM Router -- real API calls | Anthropic adapter format conversion untested against real API |
| Postgres adapter under load | Sync-over-async bridge (Bun.sleepSync) won't scale |
| Redis SSE bus | Never tested against real Redis |
| K8s/E2B compute providers | Never tested against real cluster/API |
| Auth middleware in production | Multi-user web sessions untested |
| Control plane deployment | Docker-compose and Helm chart never deployed |
| OTLP observability | Never tested against real Jaeger/Tempo |
| MCP configs | Never tested with real Jira/GitHub/Figma |
| SDLC flow end-to-end | Never processed a real Jira ticket through the full pipeline |
| Remote client mode | TUI/CLI connecting to remote server untested |

### Not built at all

| Item | Why it matters |
|------|---------------|
| Agent performance evals | Current evals are keyword matching -- useless. Need real runtime eval. |
| Dashboard overview | No homepage with fleet status, cost summary, activity stream. |
| Cost charts | Plain table, no pie/line/bar charts. |
| Task/Kanban board | No task queue for agents. Sessions are execution units, not work items. |
| Security posture | No trust scoring, secret detection, injection logging, audit trail. |
| Webhooks | No outbound event delivery. |
| Alert rules | No declarative alerting. |
| User management UI | Token auth only, no user CRUD panel. |
| GitHub Issues sync | Auto-PR only, no issue import/tracking. |
| Exec approval queue | Guardrails block/allow, no interactive approval. |
| Standup reports | No auto-generated daily summaries. |
| i18n | English only. |
| Onboarding wizard | No first-run guided setup. |
| Async Postgres repos | Repos are sync -- blocks real hosted scale. |
| Docker image published | No image in any registry. |
| Core module reorganization | 91 flat files in packages/core/ -- needs domain directories. |

---

## Roadmap Camps

### Camp 1: Integration Testing & Production Readiness

**Goal:** Everything that exists actually works against real services.

| Task | Effort |
|------|--------|
| Test LLM Router against real Anthropic/OpenAI/Google APIs | 1-2 days |
| Test MCP configs with real Jira, GitHub, Figma | 1-2 days |
| Test Postgres adapter under concurrent load | 1 day |
| Make repos async for real Postgres scale | 3-5 days |
| Test Redis SSE bus against real Redis | 0.5 day |
| Test K8s provider against real cluster | 1 day |
| Test E2B provider against real API | 0.5 day |
| Deploy Docker-compose, verify all services start | 1 day |
| Deploy Helm chart, verify on K8s | 1 day |
| End-to-end: real Jira ticket through SDLC flow | 2-3 days |
| Publish Docker image to registry | 0.5 day |

### Camp 2: Agent Intelligence & Evaluation

**Goal:** Agents get smarter over time. We can measure and improve their performance.

| Task | Effort |
|------|--------|
| Rewrite eval system -- live runtime evals, not keyword matching | 2-3 days |
| Agent completion rate tracking (per role, per runtime) | 1 day |
| Tool call latency tracking (p50/p95/p99 per tool) | 1 day |
| Drift detection (compare recent vs 4-week baseline) | 1 day |
| Per-agent trust scoring (weighted success/failure history) | 1 day |
| Standup reports (auto-generated daily per agent) | 1 day |
| Per-task automatic model routing (extend LLM Router) | 1-2 days |
| Feed eval results into knowledge graph as nodes | 0.5 day |

### Camp 3: Dashboard & Visualization

**Goal:** Operators see the full picture at a glance. All three surfaces (Web/TUI/CLI) aligned.

| Task | Effort |
|------|--------|
| Dashboard overview page (Web) -- widget grid | 1-2 days |
| Dashboard summary (TUI) -- empty state enhancement | 0.5 day |
| `ark dashboard` CLI command | 0.5 day |
| Cost charts -- Recharts pie/line/bar (Web) | 1 day |
| Cost sparklines (TUI) | 0.5 day |
| Smart polling (pause when tab hidden) | 0.5 day |
| Live feed sidebar (Web) | 1 day |
| Boot sequence with progress steps (Web) | 0.5 day |
| Agent detail depth -- tabs for memory/tasks/activity/eval (Web+TUI) | 1-2 days |
| Session detail -- inline diff viewer, cost breakdown, timeline (Web) | 1-2 days |
| Onboarding wizard (Web) | 1 day |

### Camp 4: Security & Compliance

**Goal:** Enterprise-ready security posture. Audit everything.

| Task | Effort |
|------|--------|
| Audit trail (immutable log of all sensitive operations) | 1-2 days |
| Security posture score (composite 0-100) | 1 day |
| Secret detection (scan tool I/O for API keys, tokens) | 1 day |
| Injection attempt tracking | 0.5 day |
| Exec approval queue (interactive approve/deny for borderline ops) | 1-2 days |
| Trust scoring per agent | 1 day |
| Security dashboard panel (Web+TUI) | 1 day |

### Camp 5: Integrations & Webhooks

**Goal:** Ark connects to the tools teams already use.

| Task | Effort |
|------|--------|
| Outbound webhook system (HMAC-signed, retry, circuit breaker) | 2-3 days |
| Declarative alert rules (entity/field/operator/value/action) | 1-2 days |
| GitHub Issues bidirectional sync | 2-3 days |
| Slack commands + thread-based interaction | 2-3 days |
| Linear integration | 1-2 days |
| Webhook management panel (Web+TUI) | 1 day |
| Alert management panel (Web+TUI) | 1 day |

### Camp 6: Task Management

**Goal:** Agents have a work queue. Humans can assign, prioritize, and review.

| Task | Effort |
|------|--------|
| Task table (new schema -- separate from sessions) | 1 day |
| Kanban board UI (Web) | 2-3 days |
| Task list view (TUI) | 1 day |
| `ark task create/list/assign/dispatch` CLI | 1 day |
| Quality gate / Aegis review system (agent-to-agent review) | 2-3 days |
| Task → session mapping (dispatching a task creates a session) | 1 day |
| Task feedback rating on completion | 0.5 day |
| Task comments with @mentions | 1-2 days |

### Camp 7: User Experience Polish

**Goal:** Professional, polished product.

| Task | Effort |
|------|--------|
| Full user management UI (create/edit/delete users, roles) | 1-2 days |
| Google/GitHub SSO | 1-2 days |
| Access request workflow (new users request, admins approve) | 1 day |
| i18n foundation (framework + English strings extracted) | 1-2 days |
| Natural language schedule parsing | 1 day |
| Calendar view for schedules (day/week/month) | 1-2 days |
| Knowledge graph visualization (Web) | 2-3 days |

### Camp 8: Architecture Cleanup

**Goal:** Codebase is maintainable and well-organized.

| Task | Effort |
|------|--------|
| Core module reorganization (91 flat files → 15 domain directories) | 3-5 days |
| Remove/rewrite eval system (evals.ts, recipe-eval.ts) | 1-2 days |
| Async repo layer for Postgres | 3-5 days |
| CI/CD pipeline for Ark itself (build/test/publish) | 1-2 days |
| Update CLAUDE.md with current architecture | 0.5 day |
| Update all documentation (guide, CLI ref, config ref) | 1-2 days |

---

## Priority Sequence

```
Camp 1: Integration Testing      ████████████   FIRST -- nothing else matters if it doesn't work
Camp 2: Agent Intelligence       ████████       Core value prop -- agents that get smarter
Camp 3: Dashboard & Viz          ████████       Operator experience -- see the fleet
Camp 4: Security                 ██████         Enterprise requirement
Camp 8: Architecture Cleanup     ██████         Maintainability (can run in parallel)
Camp 5: Integrations             ██████         Connect to existing tools
Camp 6: Task Management          ████████       New capability -- work queues
Camp 7: UX Polish                ██████         Professional finish
```

---

## Competitive Landscape & Research

### Direct Competitors Analyzed

| Product | What they do | What we learned | License |
|---------|-------------|-----------------|---------|
| **Mission Control** (builderz-labs) | 32-panel dashboard, Kanban, Aegis review, trust scoring, webhooks, alerts | UX bar for dashboards. We beat them on compute orchestration, they beat us on operator UX. | Open source |
| **SoulForge** (ProxySoul) | Codebase knowledge graph, PageRank, blast radius, symbol extraction | "1.8x faster, 2.1x cheaper" -- context injection is the highest-ROI optimization | BSL 1.1 (study only) |
| **GitNexus** | Browser-based knowledge graph, Leiden community detection, SKILL.md generation | Zero-server approach, skill auto-generation from codebase analysis | PolyForm NC (study only) |
| **Goose** (Block) | Recipe-based SDLC orchestration, server mode | ISLC recipes converted to Ark native flows. We replace Goose. | Open source |
| **Axon** (harshkedia) | Graph-powered code intelligence, MCP tools, 33+ languages | Integrated as codebase indexer subprocess (MIT licensed) | MIT |
| **Higress** (Alibaba/CNCF) | AI-native API gateway, model routing, MCP support | Production gateway for enterprise. Our router is dev-grade; Higress is enterprise-grade. | Apache 2.0 |

### LLM Router Research

From the product spec and research doc analyzed:
- **Market split**: Intelligent routers (Martian, Not Diamond, RouteLLM) vs Infrastructure gateways (Portkey, LiteLLM, TensorZero, Bifrost) vs Unified APIs (OpenRouter)
- **Production reality**: Benchmark claims of 85% cost savings compress to 30-60% in production
- **Key insight**: Prompt caching (90% savings), batch APIs (50%), and semantic caching (31% of queries) should come BEFORE routing
- **Our router**: Rule-based classifier v1. Needs real API testing, bandit-based learning, and cascade mode validation.
- **Higress integration**: Consider for enterprise deployments (CNCF, 99.99% uptime guarantee)

### Internal Team Context (from Slack)

- Team is converting workflows to Goose recipes -- Ark replaces this
- Server mode for multi-user: "server mode is the answer" -- our control plane addresses this
- "Send to dev" workflow: PRD ready → remote devbox → everything → tested PR at 95% readiness -- this is our SDLC flow
- Risk team needs: PAI-32794 -- server-oriented solution with per-user MCP credentials and chat history
- Connected with Sreerag/Rohit/Atul for Goose scripts on server -- Ark hosted mode replaces this

### Foundry 2.0 (Internal Initiative)

Two tracks converging by Apr 20 deadline:
- **Track 1: QA Infra in Cloud** -- on-demand testing infrastructure, CLI-based, 24x7 availability
- **Track 2: AI Monitor** -- Prometheus-backed monitoring with AI agent, Slack-first alerts
- **Vision**: Fully Automated QA + Self-Healing Systems

---

## Evaluation System (Current → Target)

### Current (broken -- needs rewrite)

| File | Problem |
|------|---------|
| `evals.ts` | Keyword matching against expected output strings. `output.includes(keyword)`. No semantic evaluation. |
| `recipe-eval.ts` | Creates sessions but doesn't dispatch them. Comment: "does NOT dispatch -- requires real agents". Tests creation, not performance. |

### Target

| Layer | What it measures | How |
|-------|-----------------|-----|
| **Output evals** | Did the agent complete the task? Were tests passing? Was the PR accepted? | Parse session outcome, test results, PR status |
| **Trace evals** | How many turns to completion? Any loops? Convergence speed? | Analyze event timeline |
| **Component evals** | Tool call latency (p50/p95/p99). Which tools fail most? | Instrument tool calls with timing |
| **Drift detection** | Is this agent getting worse over time? | Compare recent 7-day scores to 4-week rolling baseline |
| **Trust scoring** | Weighted history: success (+0.02), failure (-0.05), injection (-0.15), secret exposure (-0.20) | Accumulate per agent in knowledge graph |
| **Benchmarks** | Run known tasks against different agents/runtimes/models, compare | Actually dispatch and evaluate results |

All eval results stored as `type=eval` nodes in knowledge graph, linked to sessions and agents.

---

## Surface Parity (Web / TUI / CLI)

Every feature must exist in all three surfaces:

| Feature | Web | TUI | CLI | Status |
|---------|-----|-----|-----|--------|
| Sessions | ✅ | ✅ | ✅ | Done |
| Agents+Runtimes | ✅ | ✅ | ✅ | Done |
| Flows | ✅ | ✅ | ✅ | Done |
| Compute | ✅ | ✅ | ✅ | Done |
| History | ✅ | ✅ | ✅ | Done |
| Memory/Knowledge | ✅ | ✅ | ✅ | Done |
| Tools/Skills | ✅ | ✅ | ✅ | Done |
| Schedules | ✅ | ✅ | ✅ | Done |
| Costs | ✅ | ✅ | ✅ | Done (no charts) |
| Settings | ✅ | ✅ | ✅ | Done |
| Dashboard Overview | 🔄 | ❌ | ❌ | In progress |
| Cost Charts | ❌ | ❌ | N/A | Not started |
| Router Status | ❌ | ❌ | ✅ | CLI only |
| Tenant/User Mgmt | ❌ | ❌ | ✅ | CLI only |
| Knowledge Search | ❌ | ❌ | ✅ | CLI only |
| Task Board | ❌ | ❌ | ❌ | Not started |
| Security | ❌ | ❌ | ❌ | Not started |
| Audit Trail | ❌ | ❌ | ❌ | Not started |
| Webhooks | ❌ | ❌ | ❌ | Not started |
| Alerts | ❌ | ❌ | ❌ | Not started |
| Agent Evals | ❌ | ❌ | ❌ | Not started |
| Standup Reports | ❌ | ❌ | ❌ | Not started |

---

## Key Learnings from This Session

1. **Architecture before features.** DI, database abstraction, and compute provider interfaces had to come first. Everything after was easier because the foundation was right.

2. **Global state is poison.** 225 `getApp()` calls created hidden dependencies everywhere. Awilix container + explicit parameter passing fixed testability and multi-tenancy in one move.

3. **Process leaks are insidious.** Fan-out dispatch + async tmux + fire-and-forget = orphaned claude/tmux processes. Fixed by: awaiting dispatches, stopAll in shutdown, proper provider-based kill chain.

4. **Build ≠ integrated.** We built 7 compute providers, a router, auth, Postgres adapter, Redis SSE, control plane. None have been tested against real services. Unit tests prove logic, not deployment.

5. **Knowledge should be unified.** 7 fragmented knowledge systems (memories, search, learnings, transcripts, skills, knowledge, sessions) converged into one graph. Agents go from "grep and pray" to "query the graph."

6. **The ISLC recipes are a goldmine.** Converting Goose ISLC stages into Ark native flows gave us a complete SDLC pipeline with quality-tested prompts.

7. **Theme consistency matters.** Every hardcoded `"cyan"` or `"gray"` had to be replaced with `theme.accent` / `theme.dimText`. One color system, one source of truth.

8. **Mission Control sets the UX bar.** 32 panels, Kanban board, security posture, agent evals, cost charts, webhooks, audit trail. We have stronger orchestration; they have stronger dashboard.
