# Ark Platform Roadmap

**Vision:** Ark is the orchestration platform for AI-powered software development. It manages the full lifecycle -- from ticket to merged PR -- across any agent, any model, any compute target. Runs locally or as a hosted multi-tenant service.

---

## Done (2026-04-09)

### Core Platform
- [x] Awilix DI container -- all services resolve from AppContext
- [x] 225 getApp() calls eliminated, 0 ARK_DIR() calls, paths.ts deleted
- [x] Resource stores (app.flows, app.skills, app.agents, app.recipes) with swappable backends
- [x] Proper process lifecycle -- stopAll via provider, zero test leaks
- [x] ESLint configured + CI lint step
- [x] 2414 tests pass, 0 fail

### Flows & Orchestration
- [x] Fan-out / DAG flows with depends_on
- [x] Auto-join on child completion with branch merge
- [x] fan_out stage type in flow engine
- [x] Firecracker compute inheritance for fan-out children
- [x] Async dispatch (no fire-and-forget)

### Compute Providers (7 total)
- [x] Local (tmux)
- [x] Docker
- [x] DevContainer
- [x] Firecracker (local + EC2)
- [x] EC2 + ArkD (remote-arkd)
- [x] E2B (managed Firecracker sandboxes)
- [x] Kubernetes (vanilla + Kata/Firecracker)

### Surfaces
- [x] CLI split into 14 command modules (from 2367-line monolith)
- [x] Web UI modularized by domain (queries, pages, hooks)
- [x] TUI modularized per tab, all colors theme-driven
- [x] Desktop app (Electron)

### Code Quality (v0.11.0)
- [x] 39 code quality issues fixed (security, runtime crashes, React hooks, error handling)
- [x] Shell injection protection, OAuth token safety, validation bypass fixes
- [x] ES module compliance (all require() and __dirname eliminated)
- [x] Documentation overhaul (README, CLI reference, guide, CHANGELOG)

---

## In Flight

### SDLC Flow (converting ISLC Goose recipes to native Ark)
- [ ] 5 skills: spec-extraction, sanity-gate, plan-audit, security-scan, self-review
- [ ] 7 agents: ticket-intake, planner, auditor, implementer, verifier, closer, retro
- [ ] 2 flows: `sdlc` (full 7-stage), `sdlc-quick` (5-stage)
- [ ] 3 recipes: sdlc, sdlc-quick, ideate
- [ ] MCP config stubs: Atlassian, GitHub, Linear, Figma

---

## Phase 1: LLM Router (1-2 weeks)

First-class model routing. Ark agents route through the router for cost optimization without quality loss.

### Architecture
```
Agent → Claude Code → LLM Router (OpenAI-compatible proxy) → Providers
                           ↓
                     Classify → Route → Dispatch → Feedback
```

### What to build

**`packages/router/`** -- standalone HTTP service, also embeddable in Ark

| Component | Description |
|-----------|-------------|
| **Proxy server** | OpenAI-compatible API (`/v1/chat/completions`). Drop-in replacement -- apps change base URL only |
| **Request classifier** | Lightweight complexity scoring (rule-based v1, DeBERTa v2). Task type + difficulty |
| **Routing engine** | Policy modes: `quality` (always frontier), `balanced` (cost/quality tradeoff), `cost` (maximize savings) |
| **Sticky sessions** | Multi-turn conversations stay on same model unless complexity escalates |
| **Tool-call routing** | Route to models with verified tool-calling reliability per schema |
| **Cascade fallback** | Try cheap model first, escalate if confidence low or latency high |
| **Provider fallback** | Circuit breakers per provider. If Anthropic is down, route to OpenAI |
| **Feedback loop** | Per-route quality tracking. Bandit-based online learning from outcomes |
| **Cost attribution** | Per-session, per-route, per-model cost breakdowns fed back to Ark |

### Ark Integration

```yaml
# Agent YAML -- model: auto routes through the router
name: implementer
model: auto                    # NEW: router picks the model
routing_policy: balanced       # NEW: quality/balanced/cost
max_cost_per_token: 0.005      # NEW: cost ceiling
```

```yaml
# ~/.ark/config.yaml
router:
  enabled: true
  url: http://localhost:8430   # Router service URL
  policy: balanced
  quality_floor: 0.9
  providers:
    - name: anthropic
      api_key: ${ANTHROPIC_API_KEY}
      models: [claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5]
    - name: openai
      api_key: ${OPENAI_API_KEY}
      models: [gpt-4.1, gpt-4.1-mini, gpt-4.1-nano]
    - name: google
      api_key: ${GOOGLE_API_KEY}
      models: [gemini-2.5-pro, gemini-2.5-flash]
```

### Phased rollout
1. **Proxy + observability** (week 1) -- OpenAI-compatible proxy with logging, cost tracking, provider fallback
2. **Rule-based routing** (week 1) -- per-agent model selection, per-flow cost policies
3. **Intelligent routing** (week 2) -- complexity classifier, bandit-based learning, cascade

### CLI
```bash
ark router start                           # Start the router service
ark router start --port 8430 --policy balanced
ark router status                          # Show routing stats
ark router costs                           # Per-model cost breakdown
```

---

## Phase 2: Database Abstraction (2-3 days)

Swap SQLite for Postgres without touching business logic.

- [ ] `IDatabase` interface (prepare, exec, transaction, close)
- [ ] `BunSqliteAdapter` implements IDatabase (local mode)
- [ ] Update all repos to use IDatabase
- [ ] `config.databaseUrl` -- sqlite:// or postgres://
- [ ] Versioned schema migrations

---

## Phase 3: Network & Port Abstraction (1-2 days)

- [ ] Config-driven URLs (conductorUrl, arkdUrl, channelBaseUrl)
- [ ] Dynamic port allocation (port 0 + conductor service discovery)
- [ ] `ARK_CONDUCTOR_HOST` env var

---

## Phase 4: Auth & Multi-Tenancy (3-5 days)

- [ ] `TenantContext { tenantId, userId, role }` type
- [ ] `tenant_id` column on all entities
- [ ] JWT/OIDC auth middleware in web server
- [ ] Tenant context injected into RPC handlers
- [ ] Per-tenant AppContext factory
- [ ] API key management (create, rotate, revoke)
- [ ] Per-user MCP credentials (from Slack thread requirement)

---

## Phase 5: Session Launcher Abstraction (3-5 days)

- [ ] `SessionLauncher` interface (launch, kill, status, send, capture)
- [ ] `TmuxLauncher` (local)
- [ ] `ContainerLauncher` (Docker/K8s)
- [ ] `ArkdLauncher` (remote via ArkD)
- [ ] Wire into orchestration (replace direct tmux calls)

---

## Phase 6: Remote-First Features (3-5 days)

- [ ] `--remote-repo <git-url>` on session start
- [ ] Compute pools with auto-scaling
- [ ] Web dashboard as primary UI (login, tenant switcher)
- [ ] SSE scaling (Redis pub/sub for multi-instance)

---

## Phase 7: Foundry 2.0 Product Features

### Track 1: QA Infra in Cloud
- [ ] Test suite fan-out recipe (discover tests, fan-out to compute)
- [ ] CI/CD integration (GitHub Actions plugin)
- [ ] Test result aggregation and reporting

### Track 2: AI Monitor
- [ ] Persistent/daemon agent mode
- [ ] Prometheus MCP server
- [ ] Escalation rules (route alerts to right person/channel)
- [ ] Health check schedules

---

## Compute Provider Matrix

| Provider | Isolation | Local | Remote | Fan-out | Status |
|----------|-----------|-------|--------|---------|--------|
| Local (tmux) | Process | Yes | No | Yes | Done |
| Docker | Container | Yes | Yes | Yes | Done |
| DevContainer | Container | Yes | Yes | Yes | Done |
| Firecracker | MicroVM | Linux | EC2 | Yes | Done |
| EC2 + ArkD | Process/Container/VM | No | Yes | Yes | Done |
| E2B | Managed MicroVM | No | Yes | Yes | Done |
| K8s | Pod | No | Yes | Yes | Done |
| K8s + Kata | MicroVM on K8s | No | Yes | Yes | Done |

---

## LLM Router Model Pool

| Provider | Models | Routing strengths |
|----------|--------|-------------------|
| Anthropic | Opus 4.6, Sonnet 4.6, Haiku 4.5 | Reasoning, code, tool use, long context |
| OpenAI | GPT-4.1, GPT-4.1 mini, GPT-4.1 nano | Broad coverage, function calling |
| Google | Gemini 2.5 Pro, Flash | Multimodal, speed |
| Self-hosted | Llama, Mistral (via vLLM/Ollama) | Cost floor for bulk workloads |

---

## Success Criteria

| Milestone | Criteria |
|-----------|---------|
| SDLC flow | `ark session start --ticket IN-1234 --flow sdlc --dispatch` runs full pipeline |
| LLM Router | `model: auto` routes correctly, 30%+ cost reduction vs frontier-only |
| Phase 2 | `bun:sqlite` imported only in `database-sqlite.ts` |
| Phase 3 | Zero hardcoded `localhost` in production code |
| Phase 4 | Two tenants run sessions without seeing each other's data |
| Phase 5 | `tmux` imported only in `tmux-launcher.ts` |
| Phase 6 | Session via web, remote compute, no local CLI needed |
| Phase 7 | QA fan-out to cloud, AI monitor watches Prometheus |

---

## Timeline

```
Done        ████████████████████████████  Core platform, DI, flows, compute, quality
In flight   ████                          SDLC flow + agents + skills
Phase 1     ████████                      LLM Router (1-2 weeks)
Phase 2     ███                           Database abstraction (2-3 days)
Phase 3     ██                            Network abstraction (1-2 days)
Phase 4     █████                         Auth + multi-tenancy (3-5 days)
Phase 5     █████                         Session launcher (3-5 days)
Phase 6     █████                         Remote-first (3-5 days)
Phase 7     ████████████                  Foundry 2.0 (ongoing)
```
