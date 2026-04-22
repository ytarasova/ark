# Roadmap Status (2026-04-10)

## Completed & Verified (unit tests pass, behavior confirmed)

| Item | Tests | Confidence |
|------|-------|------------|
| Awilix DI container | Yes | High |
| DatabaseAdapter abstraction (SQLite adapter) | Yes | High |
| Fan-out / DAG flows | Yes | High |
| Auto-join on child completion | Yes | High |
| Session launcher abstraction | Yes | High |
| Resource stores (flow/skill/agent/recipe/runtime) | Yes | High |
| API key management | Yes | High |
| Tenant-scoped repositories | Yes | High |
| Worker registry + scheduler | Yes | High |
| Tenant compute policies | Yes | High |
| Compute pool manager | Yes | High |
| SSE bus (in-memory) | Yes | High |
| LLM Router -- classifier | Yes | High |
| LLM Router -- routing engine | Yes | High |
| CLI split (14 modules) | Yes | High |
| Web UI domain modularization | Yes | High |
| TUI theme system | Yes | High |
| Code quality fixes (v0.11.0) | Yes | High |
| SDLC flow + agents + skills | Yes (YAML valid) | Medium |
| Runtime/role separation | Yes | High |
| ESLint + CI lint | Yes | High |
| Process leak prevention | Yes | High |

## Built but NOT Integration Tested

| Item | What exists | What's untested |
|------|------------|-----------------|
| LLM Router -- provider dispatch | Server code | Real API calls to Anthropic/OpenAI/Google |
| LLM Router -- streaming | SSE proxy code | Streaming through real providers |
| LLM Router -- Anthropic adapter | Format conversion | Against real Anthropic Messages API |
| Cost tracking -- router integration | In-memory tracker | Feed costs back to Ark's DB |
| Postgres adapter | Sync-over-async wrapper | Real Postgres under load |
| Redis SSE bus | Pub/sub code | Real Redis server |
| K8s compute provider | Pod creation code | Real K8s cluster |
| E2B compute provider | Sandbox creation code | Real E2B API |
| Auth middleware in web server | Token extraction | Multi-user web sessions |
| Control plane -- hosted mode | Entry point code | Docker-compose / Helm deployment |
| Control plane -- worker registration | ArkD registration code | Workers registering with control plane |
| OTLP observability | Span export code | Real Jaeger/Tempo collector |
| MCP config stubs | JSON templates | Real Jira/GitHub/Figma MCP servers |
| SDLC flow -- end-to-end | Flow + agent YAML | Real Jira ticket through full pipeline |
| Remote client mode (--server) | WebSocket transport | TUI/CLI connecting to remote server |
| Compute pools -- auto-provision | Pool manager code | Provisioning under load |
| Codebase knowledge graph | Plan only | Nothing built yet |

## Not Started

| Item | Priority | Notes |
|------|----------|-------|
| Knowledge graph (codebase + sessions + memories) | High | Plan written, Axon MCP integration needed |
| Async repository layer for Postgres | High | Current sync-over-async won't scale |
| Integration test suite (real APIs) | High | Need test accounts for Anthropic/OpenAI/Jira |
| Workflow checkpoint/restore | Medium | Resume from exact point, not stage start |
| Higress gateway integration | Medium | Replace custom router for enterprise |
| User management UI | Medium | Web UI for creating users/tenants |
| CI/CD pipeline for Ark itself | Medium | Build/test/deploy automation |
| Docker image published to registry | Medium | No image built/pushed yet |
| Helm chart tested | Medium | Chart exists but never `helm install`-ed |
| Worker failover | Medium | Reassign sessions from dead workers |
| Rate limiting per tenant | Low | Needed for hosted but not urgent |
| Audit logging | Low | Track who did what |

## Critical Path for "Send to Dev" (Harinder's ask)

To deliver: "PRD ready → send to dev → returns tested PR at 95% readiness"

1. ✅ SDLC flow with stages (intake → plan → execute → verify → close)
2. ✅ Fan-out execution (parallel subtasks)
3. ✅ Remote compute (EC2/K8s/E2B)
4. ✅ Verification gates (tests + lint must pass)
5. ⚠️ Codebase knowledge graph (agents need to understand the repo)
6. ⚠️ Real MCP integrations (Jira, GitHub tested end-to-end)
7. ⚠️ LLM Router tested with real APIs
8. ❌ End-to-end test: Jira ticket → merged PR

## What to do next (in order)

1. **Integration tests with real APIs** -- test router against Anthropic, test MCP with real Jira
2. **Codebase knowledge graph** -- Axon MCP + session knowledge nodes
3. **Async Postgres adapter** -- make repos async for real hosted deployments
4. **End-to-end "send to dev" test** -- one real Jira ticket through the full SDLC flow
5. **Docker image + Helm test** -- actually deploy and verify
