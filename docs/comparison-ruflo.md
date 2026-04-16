# Ruflo vs Ark -- UX Comparison

Side-by-side comparison of two Claude-centric agent orchestration platforms from an operator's perspective.

| | **Ruflo** (v3.5) | **Ark** (v0.15) |
|---|---|---|
| Stars | ~32k | early-stage |
| Package | `npx ruflo@latest` (npm) | `make install` (Bun symlink) |
| Runtime | Node 20+ | Bun-only |
| License | MIT | MIT |

---

## 1. Installation and First Run

### Ruflo

```bash
# One-liner (recommended)
curl -fsSL https://cdn.jsdelivr.net/gh/ruvnet/ruflo@main/scripts/install.sh | bash

# Or via npx
npx ruflo@latest init --wizard
```

`init --wizard` generates `.claude/settings.json` (hook config), `.claude/mcp.json` (MCP server), agent YAMLs, and helper scripts. After init, the user doesn't need to invoke ruflo directly -- hooks intercept Claude Code prompts and route them automatically.

### Ark

```bash
make install   # bun install + symlinks ./ark to PATH
ark session start --repo . --summary "Fix the auth bug" --flow autonomous-sdlc --dispatch
```

No wizard. The operator picks a flow, passes a summary, and the system dispatches immediately. `ark server daemon start --detach` runs the conductor (19100) and arkd (19300) as prerequisites.

### Verdict

Ruflo optimizes for zero-friction onboarding via hooks -- the operator installs once and forgets. Ark requires the operator to understand sessions, flows, and the daemon topology but gives explicit control from the first command.

---

## 2. Mental Model

### Ruflo: Hook-Driven Autonomy

```
User types prompt -> Hook intercepts -> Router picks agent -> Swarm coordinates -> Result
```

The user works in Claude Code as normal. Hooks silently intercept every prompt submission, route it to the best agent via Q-Learning, and coordinate multi-agent work behind the scenes. The operator doesn't manage sessions or stages -- the system decides.

### Ark: DAG-Driven SDLC

```
Operator starts session -> Flow defines stages -> Conductor dispatches agents -> Agents report -> Next stage
```

The operator explicitly starts a session with a flow. The flow is a DAG of stages (plan -> implement -> verify -> review -> PR). Each stage runs one agent. The conductor advances through stages based on agent reports and gate conditions.

### Verdict

Ruflo hides orchestration behind hooks -- lower cognitive load, less control. Ark exposes orchestration as a first-class DAG -- higher cognitive load, full control over stage ordering, gating, and retry policies.

---

## 3. CLI Surface

### Ruflo (38+ top-level commands)

Core: `init`, `start`, `status`, `task`, `session`, `config`
Agents: `agent`, `swarm`, `hive-mind`
Memory: `memory`, `embeddings`, `ruvector`
Ops: `daemon`, `autopilot`, `guidance`, `route`
DevOps: `deployment`, `claims`, `migration`
Advanced: `neural`, `security`, `performance`, `plugins`, `hooks`, `mcp`
Utility: `doctor`, `update`, `cleanup`, `completions`

### Ark (22 command groups)

Core: `session`, `agent`, `flow`, `runtime`, `skill`, `recipe`
Ops: `compute`, `conductor`, `router`, `daemon`, `server`
Data: `knowledge`, `search`, `memory`, `costs`
Multi-tenant: `auth`, `tenant`
Dev: `worktree`, `schedule`, `eval`, `dashboard`, `profile`

### Verdict

Both have large CLI surfaces. Ruflo's is wider (38+ commands including neural, embeddings, benchmark, plugins) but most operators only use `init`, `status`, and `swarm`. Ark's is narrower (22 groups) but every command is load-bearing -- sessions, flows, and compute are used daily.

---

## 4. Agent Model

### Ruflo

- 5 built-in YAML agents (architect, coder, reviewer, tester, security-architect)
- Claims 100+ via dynamic spawning in swarms (queen + workers pattern)
- Agent metadata: type, version, capabilities, optimizations, health score, model routing
- Agent dispatch: implicit via hook routing (Q-Learning selects best agent for prompt)
- No explicit agent-to-stage binding

### Ark

- 12 built-in YAML agents (planner, implementer, verifier, reviewer, spec-planner, plan-auditor, ticket-intake, closer, retro, task-implementer, documenter, worker)
- Agents are bound to flow stages explicitly
- Agent metadata: name, runtime, model, max_turns, system_prompt, tools, mcp_servers, skills, memories
- Agent dispatch: explicit via session + flow + conductor
- Template variables: `{ticket}`, `{summary}`, `{workdir}`, `{repo}`, `{branch}`

### Verdict

Ruflo's agent model is swarm-first -- many anonymous workers coordinated by queens. Ark's model is role-first -- named agents bound to named stages in a flow. Ruflo is better for emergent, unpredictable workloads. Ark is better for predictable SDLC pipelines where each stage has clear entry/exit criteria.

---

## 5. Coordination and State

### Ruflo

- Swarm topologies: mesh, hierarchical, ring, star
- Consensus: Raft, Byzantine (f < n/3), Gossip, weighted voting
- Queen types: Strategic (planning), Tactical (execution), Adaptive (optimization)
- State: SQLite (v2) or AgentDB (v3) with HNSW vector indexing
- Self-learning loop: RETRIEVE -> JUDGE -> DISTILL -> CONSOLIDATE -> ROUTE
- Memory: vector store with TTL, namespaces, semantic retrieval

### Ark

- DAG-based flow execution with depends_on edges
- Gates: auto, manual, condition-based
- State: SQLite (local) or PostgreSQL (hosted) with FTS5 transcript indexing
- No consensus protocol -- single conductor makes all decisions
- Session events logged as structured records (session_created, stage_started, etc.)
- Knowledge graph: ops-codegraph indexer with per-repo `.codegraph/graph.db`

### Verdict

Ruflo is distributed-first with consensus protocols for multi-agent agreement. Ark is centralized -- the conductor is the single source of truth. Ruflo's approach handles agent disagreement gracefully. Ark's approach is simpler to reason about and debug.

---

## 6. Compute Targets

### Ruflo

- Local subprocess only (Node.js)
- No remote execution, Docker, or cloud compute

### Ark

- 11 providers: local, docker, devcontainer, firecracker, EC2, EC2-docker, EC2-devcontainer, EC2-firecracker, E2B, Kubernetes, K8s-kata
- Arkd daemon runs on every compute target
- Remote execution with health-checked worker registry

### Verdict

Ark wins decisively on compute flexibility. Ruflo runs locally only. Ark can dispatch agents to Docker containers, Kubernetes pods, EC2 instances, Firecracker VMs, or E2B sandboxes -- critical for enterprise isolation and scaling.

---

## 7. LLM Routing

### Ruflo

- Q-Learning router with 8 expert mixture-of-experts (MoE)
- Providers: Claude, GPT, Gemini, Cohere, Ollama (local)
- Smart routing by complexity: simple (WASM, free) -> medium (Haiku/Sonnet) -> complex (Opus + Swarm)
- Agent Booster: WASM-based code transforms skip LLM entirely for simple edits (<1ms)
- Claims 250% subscription extension via smart routing

### Ark

- OpenAI-compatible proxy at `/v1/chat/completions`
- 3 routing policies: quality, balanced, cost
- Circuit breakers per provider
- Optional TensorZero backend (sidecar/native/Docker)
- 300+ model pricing registry for cost tracking
- Runtime-level model selection (opus/sonnet/haiku per agent)

### Verdict

Both offer multi-model routing. Ruflo's Q-Learning approach is more autonomous -- it learns which model works best over time. Ark's approach is policy-driven -- the operator picks quality/balanced/cost and the router executes. Ruflo's WASM Agent Booster for trivial edits is a unique cost-saving feature Ark lacks.

---

## 8. Observability

### Ruflo

- `status --watch` (polling CLI)
- Swarm metrics via MCP tools
- No web dashboard
- No cost tracking or token accounting

### Ark

- Web dashboard (Vite + React, port 5173) with session list, detail, flow graphs, compute config, terminal embed
- SSE live updates (in-memory or Redis)
- Per-session cost tracking: input/output/cache tokens, USD cost, 300+ model pricing
- OpenTelemetry span export (sessionSpan, stageSpan)
- Structured logging (logError, logWarn)
- Session event history (full audit trail)

### Verdict

Ark is significantly more observable. Real-time web dashboard, cost tracking, OTLP export, and structured event logs give operators full visibility. Ruflo relies on CLI polling and MCP tool queries -- sufficient for development, insufficient for production monitoring.

---

## 9. Extensibility

### Ruflo

- Plugin SDK with IPFS-based decentralized marketplace
- `plugins install/remove/enable/disable`
- Hook system: PreToolUse, PostToolUse, UserPromptSubmit, SessionStart
- 118+ MCP tools across 28+ modules
- 130+ skills, 27 hooks

### Ark

- Three-tier resource resolution: builtin > global (~/.ark/) > project (.ark/)
- Agents, flows, skills, recipes, runtimes all overridable via YAML
- Plugin executors: `~/.ark/plugins/executors/*.js`
- MCP configs per agent via mcp_servers field
- 7 builtin skills, 8 recipes, 13 flows

### Verdict

Ruflo has a broader extension surface (plugins, MCP tools, hooks). Ark's three-tier override system is simpler but powerful -- operators drop YAML files into known directories without learning a plugin SDK.

---

## 10. Who Should Use What

| Scenario | Ruflo | Ark |
|----------|-------|-----|
| Solo dev wanting Claude Code superpowers | Best fit -- install and forget | Overengineered |
| Team running SDLC pipeline on PRs | Needs manual flow setup | Best fit -- flows define the pipeline |
| Enterprise needing isolated compute | No remote compute | Best fit -- 11 compute providers |
| Cost-sensitive API usage | Agent Booster saves tokens | Cost tracking but no WASM bypass |
| Multi-model routing with learning | Q-Learning adapts over time | Policy-driven, operator-controlled |
| Production monitoring | CLI-only observability | Web dashboard + OTLP + cost tracking |
| Extending with custom tools | Plugin SDK + IPFS marketplace | Drop YAML in three-tier directories |
| Multi-tenant SaaS | Not supported | Built-in hosted mode with tenant policies |

---

## Summary

Ruflo and Ark solve the same problem -- orchestrating AI agents for software engineering -- but optimize for different operators.

**Ruflo** is a **developer-first tool** that enhances Claude Code transparently via hooks. It minimizes the cognitive overhead of orchestration by making routing, coordination, and memory automatic. The tradeoff is less visibility and control.

**Ark** is an **operations-first platform** that makes orchestration explicit via DAG flows, named stages, and a centralized conductor. It gives operators full control over what happens, when, and where. The tradeoff is higher upfront learning cost.

In practice, a team might use Ruflo for individual developer productivity (hook-driven, self-learning) and Ark for team-level CI/CD pipelines (flow-driven, multi-compute, observable).
