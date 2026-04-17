# Ark User Guide

Ark is an autonomous agent ecosystem. It orchestrates AI coding agents through DAG-based SDLC flows on top of 11 compute providers, with a unified knowledge graph, an LLM router, universal cost tracking, and a multi-tenant control plane.

This guide covers every user-visible concept. Start at the top for the 60-second quickstart, then dive into whichever section you need.

## Table of Contents

1. Quickstart
2. Sessions
3. Flows
4. Agents and Runtimes
5. Skills
6. Recipes
7. Compute
8. Compute Templates
9. Knowledge Graph
10. Cost Tracking
11. LLM Router
12. Auth and Multi-Tenancy
13. Git Worktrees
14. Search
15. Dashboards (CLI, Web)
16. Knowledge Export and Import
17. MCP Integration
18. Remote Client Mode
19. Control Plane (Hosted Mode)
20. Deployment

---

## 1. Quickstart

Sixty seconds from zero to a running agent.

```bash
# 1. Install
git clone https://github.com/your-org/ark.git
cd ark
make install          # bun install + symlink `ark` to /usr/local/bin

# 2. Verify
ark --version
ark agent list        # shows 12 builtin agents
ark flow list         # shows 14 builtin flows

# 3. Start a session from a recipe and dispatch it
ark session start \
  --recipe quick-fix \
  --repo . \
  --summary "Add a README badge for build status" \
  --dispatch

# 4. Watch it work
ark web               # web dashboard (or launch the Electron desktop app)
# or
ark session list
ark session events <sessionId>
```

You now have:
- a git worktree at `~/.ark/worktrees/<sessionId>/`
- a tmux session (`ark-s-<id>`) running Claude Code inside it
- an MCP channel, knowledge context injected into the prompt, and hook-based status reporting
- events streaming to the CLI and Web dashboards

Requirements: bun, tmux, git, and (for auto-PR) the `gh` CLI. Ark is bun-only -- it uses `bun:sqlite`, `Bun.serve`, and Bun FFI.

---

## 2. Sessions

A session is the unit of work in Ark. Each session has a repo, a summary, an agent or flow, a compute target, a git worktree, and a lifecycle.

### Lifecycle operations

| Command | What it does |
|---------|--------------|
| `ark session start` | Creates the session row and worktree. Does not launch the agent. |
| `ark session dispatch <id>` | Launches the agent executor in tmux (or remote via arkd). |
| `ark session advance <id>` | Moves a flow to the next stage. |
| `ark session complete <id>` | Marks stage/session complete. Runs verify gates. |
| `ark session pause <id>` | Pauses a running session. |
| `ark session resume <id>` | Resumes a paused session. |
| `ark session stop <id>` | Kills the tmux session and cleans hooks. |
| `ark session fork <id>` | Spawns N child sessions from a parent (fan-out). |
| `ark session clone <id>` | Duplicates a session with the same config. |
| `ark session handoff <id>` | Transfers control to another agent/runtime. |
| `ark session archive <id>` | Hides from default list without deleting. |
| `ark session delete <id>` | Removes session, worktree, and events. |
| `ark session interrupt <id>` | Sends Ctrl+C to the running agent (tmux stays up). |

Sessions use a `status` field with states: `pending`, `dispatched`, `running`, `busy`, `idle`, `paused`, `completed`, `error`, `archived`.

### Start and dispatch examples

```bash
# One-shot: start + dispatch in a single command
ark session start \
  --repo . \
  --summary "Fix flaky test in session.test.ts" \
  --agent implementer \
  --flow quick \
  --dispatch

# Start first, configure, then dispatch
ark session start --repo . --summary "Add auth middleware"
ark session update <id> --agent implementer --compute docker
ark session dispatch <id>

# Start on a specific runtime (override the agent default)
ark session start --repo . --summary "Refactor router" \
  --agent implementer --runtime codex --dispatch

# Start from a recipe
ark session start --recipe feature-build --repo . --dispatch
```

### Flow control

```bash
# Advance to next stage (manual gate)
ark session advance <id>

# Mark stage complete (runs verify gates)
ark session complete <id>

# Force complete (skip verify -- use sparingly)
ark session complete <id> --force

# Run verify gates without completing
ark session verify <id>

# Add a human todo that must be checked before completion
ark session todo add <id> "Update the CHANGELOG"
ark session todo list <id>
```

### Fan-out and children

Fan-out decomposes a task into N parallel child sessions. The parent waits for all children to complete.

```bash
ark session fork <parentId> --count 4 --summaries "feature A,feature B,feature C,feature D"
ark session join <parentId>     # block until children finish
```

The `fan-out` and `dag-parallel` builtin flows are wired for this pattern. Parent auto-joins when the last child hits `completed`.

### Interrupt, archive, delete

```bash
ark session interrupt <id>      # Ctrl+C into the agent, keep tmux alive
ark session archive <id>        # hide from `list`
ark session archive <id> --restore
ark session delete <id>         # hard delete (worktree + rows)
```

---

## 3. Flows

A flow is a DAG of stages. Each stage has an agent, a gate type, optional verify scripts, and optional dependencies. Flows live in `flows/definitions/*.yaml` and follow the same three-tier resolution as other resources (builtin, `~/.ark/flows/`, `.ark/flows/`).

### Builtin flows (14)

| Name | Purpose |
|------|---------|
| `bare` | Single stage -- just run one agent. |
| `quick` | Plan plus implement, no review. |
| `default` | Plan, audit, implement, verify, review, document, close. |
| `autonomous` | Single agent, fully autonomous with auto gate. |
| `autonomous-sdlc` | Fully autonomous SDLC: plan -> implement -> verify -> review -> PR -> merge. No human needed. |
| `brainstorm` | Interactive ideation: explore ideas -> synthesize -> plan. Manual gates for human steering. |
| `conditional` | Conditional routing -- branch based on review outcome (approved/needs_changes/rejected), converge at PR. |
| `docs` | Lightweight doc flow: plan -> implement -> PR. No verify or review. |
| `parallel` | Independent stages that run in parallel. |
| `fan-out` | Parent dispatches N child sessions then joins. |
| `dag-parallel` | DAG with explicit `depends_on` edges. |
| `pr-review` | Review-only flow targeting a PR diff. |
| `islc` | Full ISLC loop (Intake, Spec, Landing, Close). |
| `islc-quick` | Condensed ISLC for small tickets. |

### YAML structure

```yaml
name: default
description: Plan, audit, implement, verify, review, document, close
stages:
  - name: plan
    agent: spec-planner
    gate: manual              # manual | auto | condition
  - name: audit
    agent: plan-auditor
    depends_on: [plan]
    gate: auto
  - name: implement
    agent: implementer
    depends_on: [audit]
    gate: auto
    verify:
      - "bun test"
      - "bun run lint"
    on_failure: "retry(3)"    # fail-loopback: retry with error context injected
  - name: review
    agent: reviewer
    depends_on: [implement]
    gate: auto
  - name: document
    agent: documenter
    depends_on: [review]
    gate: auto
  - name: close
    agent: closer
    depends_on: [document]
    gate: auto
```

Key fields:
- `gate`: `manual` blocks until `ark session advance`, `auto` moves on when the agent reports completion, `condition` uses a predicate expression.
- `verify`: list of shell commands that must exit 0 before completion. Agents that report done while verify fails are steered back to fix it. Use `ark session complete --force` to bypass.
- `on_failure: retry(N)`: fail-loopback. Re-dispatches the stage with the failure context injected, up to N retries.
- `depends_on`: list of prior stage names for DAG ordering. Enables parallel execution of stages with no ordering constraint.
- `action`: built-in action instead of an agent (e.g. `create_pr`, `auto_merge`). Used in terminal stages like PR creation.
- `optional: true`: stage can be skipped without blocking downstream stages.
- `task`: inline task prompt injected into the agent. Supports template variables (`{summary}`, `{repo}`, `{workdir}`).
- `edges`: explicit edge list with `from`, `to`, `condition`, and `label` fields. Used by the `conditional` flow for branching logic (e.g. route based on review outcome).
- Fan-out stages wait for all their spawned children before the parent advances (auto-join on child completion).

```bash
ark flow list
ark flow show default
ark session start --flow dag-parallel --repo . --summary "..." --dispatch
```

---

## 4. Agents and Runtimes

Ark cleanly separates the role of an agent from the tool that runs it.

- **Agent** (role): what the agent does. System prompt, tools, skills, max turns, permission mode.
- **Runtime** (tool): how the agent runs. LLM backend, CLI command, model catalog, task delivery, billing mode.

At dispatch, agent config and runtime config are merged. Agent-level values take precedence over runtime defaults. You can override the runtime on the CLI with `--runtime`.

### Agents (12 builtin roles)

| Role | Purpose |
|------|---------|
| `ticket-intake` | Parse tickets, extract requirements. |
| `spec-planner` | Write the spec/plan. |
| `plan-auditor` | Audit a plan before implementation. |
| `planner` | General planning role. |
| `implementer` | Write code for a spec. |
| `task-implementer` | Implement a single task (fan-out child). |
| `verifier` | Run and interpret verification. |
| `reviewer` | Structured code review (P0-P3 JSON output). |
| `documenter` | Update docs. |
| `closer` | Final checks, PR/merge. |
| `retro` | Post-session retrospective and learnings. |
| `worker` | Generic task runner (fan-out child). |

```bash
ark agent list
ark agent show implementer
```

### Agent YAML

```yaml
# agents/implementer.yaml
name: implementer
description: Implements a plan into working code
runtime: claude             # default runtime; override with --runtime
model: sonnet               # opus | sonnet | haiku (claude models)
max_turns: 200
system_prompt: |
  You are working on {repo} (branch {branch}).
  Ticket: {ticket}
  Task: {summary}
  Workdir: {workdir}
  Write minimal, correct code. Run tests before claiming done.
skills: [test-writing, self-review, sanity-gate]
tools: [Bash, Read, Write, Edit, Glob, Grep, WebSearch]
permission_mode: bypassPermissions
env: {}
```

Template variables substituted at dispatch time: `{ticket}`, `{summary}`, `{repo}`, `{branch}`, `{workdir}`.

### Runtimes (4 tools + 1 subscription variant)

| Name | Tool | Billing | Transcript parser |
|------|------|---------|-------------------|
| `claude` | Claude Code CLI | api (per token) | claude |
| `claude-max` | Claude Code (Max sub) | subscription ($200/mo flat) | claude |
| `codex` | OpenAI Codex CLI | api | codex (default model: gpt-5-codex) |
| `gemini` | Google Gemini CLI | api | gemini |
| `goose` | Goose (Block / AAIF) | api | goose (default model: claude-sonnet-4-6) |

```bash
ark runtime list
ark runtime show codex

# Override runtime at dispatch time
ark session start --repo . --summary "Port module" \
  --agent implementer --runtime codex --dispatch

ark session start --repo . --summary "UI polish" \
  --agent worker --runtime gemini --dispatch

# Use Goose (routes through Ark's LLM router)
ark session start --repo . --summary "Add tests" \
  --agent implementer --runtime goose --dispatch

# Use Max subscription (zero per-token cost tracked, tokens still recorded)
ark session start --repo . --summary "Big refactor" \
  --agent implementer --runtime claude-max --dispatch
```

### Runtime YAML

```yaml
# runtimes/codex.yaml
name: codex
description: OpenAI Codex CLI
type: cli-agent             # claude-code | cli-agent | subprocess
command: ["codex", "--auto"]
task_delivery: stdin        # stdin | file | arg
billing_mode: api           # api | subscription | free
transcript_parser: codex    # selects CodexTranscriptParser
models:
  - id: gpt-5-codex
    label: "GPT-5 Codex"
  - id: gpt-5
    label: "GPT-5"
default_model: gpt-5-codex
env:
  OPENAI_API_KEY: "${OPENAI_API_KEY}"
```

Four executor types are registered at boot:
- `claude-code` -- launches Claude Code in tmux with hooks and an MCP channel.
- `goose` -- launches Goose in tmux with MCP extension, model pinning, and LLM router injection.
- `cli-agent` -- any other CLI tool in tmux, with worktree isolation.
- `subprocess` -- generic child process, no tmux.

Each executor implements 5 methods: `launch`, `kill`, `status`, `send`, `capture`.

---

## 5. Skills

Skills are reusable prompt fragments. They are markdown files injected into an agent's system prompt when attached.

### Builtin skills (7)

| Skill | Purpose |
|-------|---------|
| `code-review` | Structured review checklist. |
| `plan-audit` | Checks a plan against a spec. |
| `sanity-gate` | Quick sanity check before completion. |
| `security-scan` | Security-focused review. |
| `self-review` | Self-critique prior to reporting done. |
| `spec-extraction` | Extract requirements from a ticket. |
| `test-writing` | TDD guidance for writing tests. |

### Three-tier resolution

Skills resolve in priority order:

1. Project: `.ark/skills/<name>.md` in the repo
2. Global: `~/.ark/skills/<name>.md`
3. Builtin: `skills/<name>.md` shipped with Ark

A project-level skill with the same name overrides a global or builtin one.

### Attaching to agents

```yaml
# agents/reviewer.yaml
name: reviewer
runtime: claude
skills: [code-review, security-scan, self-review]
```

At dispatch, each listed skill's markdown content is inlined into the agent's system prompt.

### CLI

```bash
ark skill list
ark skill show code-review
```

---

## 6. Recipes

Recipes are session templates with variables. They let you quick-launch a common configuration.

### Builtin recipes (10)

| Recipe | Purpose |
|--------|---------|
| `quick-fix` | Small bug fix with minimal flow. |
| `fix-bug` | Bug fix with audit and review. |
| `feature-build` | Full feature development loop. |
| `new-feature` | Alias for feature-build with different defaults. |
| `code-review` | Review-only session targeting an existing branch/PR. |
| `ideate` | Brainstorming and spec drafting. |
| `islc` | Full ISLC (Intake/Spec/Landing/Close) pipeline. |
| `islc-quick` | Shortened ISLC. |
| `self-dogfood` | Dispatch an ark agent to work on the ark repo itself using the full autonomous-sdlc flow. |
| `self-quick` | Quick single-agent dispatch against the ark repo for trivial tasks (docs, config, small fixes). |

### CLI

```bash
ark recipe list
ark recipe show quick-fix
ark session start --recipe quick-fix --repo . \
  --summary "Fix off-by-one in pager" --dispatch
```

### Creating a recipe from an existing session

```bash
ark recipe from-session <sessionId> --name my-recipe --save
```

Recipes resolve three-tier like skills: `.ark/recipes/` > `~/.ark/recipes/` > `recipes/`.

---

## 7. Compute

Ark supports 11 compute providers across four isolation modes. Each provider launches an agent either directly (local) or via the universal `arkd` daemon on the remote target.

### Provider matrix

| Mode | Provider | Isolation | When to use |
|------|----------|-----------|-------------|
| Local | `local` | None (git worktree only) | Fastest, trusted code. |
| Local isolated | `docker` | Docker container | Isolate deps from host. |
| Local isolated | `devcontainer` | VS Code devcontainer | Reuse existing devcontainer. |
| Local isolated | `firecracker` | Firecracker micro-VM | Strong isolation on a laptop. |
| Remote via arkd | `ec2` | EC2 instance + arkd | Offload compute to cloud. |
| Remote via arkd | `ec2-docker` | EC2 + docker-in-docker | Cloud plus container isolation. |
| Remote via arkd | `ec2-devcontainer` | EC2 + devcontainer | Cloud devcontainer. |
| Remote via arkd | `ec2-firecracker` | EC2 + Firecracker | Cloud plus VM isolation. |
| Managed | `e2b` | E2B managed sandbox | Hands-off managed sandbox. |
| Cluster | `k8s` | Kubernetes Pod | Existing k8s fleet. |
| Cluster | `k8s-kata` | K8s with Kata VM runtime | Hardware-isolated pods. |

Remote providers all run the `arkd` daemon on port 19300. The daemon is stateless and handles agent lifecycle, file ops, metrics, channel relay, and the `/codegraph/index` endpoint for remote knowledge indexing.

### Isolation guidance

- `local`: fastest, no sandbox. Only for code you trust and day-to-day work on your own machine.
- `docker` / `devcontainer`: dependency isolation without VM overhead. Good default for CI-like runs.
- `firecracker` / `ec2-firecracker` / `k8s-kata`: VM-grade isolation for untrusted input, multi-tenant, or regulated workloads.
- `ec2-*`: offload compute, free up your laptop, share big instances across sessions.
- `e2b`: managed sandbox with no ops overhead.

### CLI

```bash
ark compute list
ark compute show <id>
ark compute create --provider docker --name my-sandbox
ark compute create --provider ec2-firecracker --region us-west-2
ark compute start <id>
ark compute stop <id>
ark compute clean <id>
ark compute delete <id>
```

### Selecting a compute at dispatch

```bash
ark session start --repo . --summary "..." --compute docker --dispatch
ark session start --repo . --summary "..." --compute ec2-firecracker --dispatch
```

If no compute is specified, the session uses the `default_compute` field from `~/.ark/config.yaml`, falling back to `local`.

---

## 8. Compute Templates

Compute templates are named presets in `~/.ark/config.yaml`. They let you define a one-line name instead of re-typing provider and config every time.

### Define in config

```yaml
# ~/.ark/config.yaml
compute_templates:
  fast-local:
    provider: docker
    config:
      image: ark/sandbox:latest
      memory_gb: 8
      cpus: 4
  heavy-cloud:
    provider: ec2-firecracker
    config:
      region: us-west-2
      instance_type: c6a.4xlarge
      vcpus: 16
      memory_gb: 32
  review-sandbox:
    provider: e2b
    config:
      template: ark-sandbox
```

### CLI

```bash
ark compute template list
ark compute template show fast-local
ark compute template create heavy-cloud \
  --provider ec2-firecracker \
  --config '{"region":"us-west-2"}'
ark compute template delete fast-local

# Use at compute creation time
ark compute create --from-template heavy-cloud

# Or directly at session dispatch
ark session start --repo . --summary "..." \
  --compute-template heavy-cloud --dispatch
```

Compute templates are tenant-scoped in hosted mode and stored in the `compute_templates` table.

---

## 9. Knowledge Graph

Ark has a unified knowledge graph that stores codebase structure, session history, memories, learnings, skills, recipes, and agents -- all as nodes and edges in SQLite (or Postgres in hosted mode). The tables are `knowledge` and `knowledge_edges`, tenant-scoped.

### Indexer: ops-codegraph

The indexer is [@optave/codegraph](https://www.npmjs.com/package/@optave/codegraph) -- a TypeScript plus native Rust engine using tree-sitter WASM. It supports 33 languages out of the box and does not require Python.

```bash
npm install -g @optave/codegraph
# or let Ark pick it up as a local npm dependency
```

Ark reads `.codegraph/graph.db` after indexing and maps nodes and edges into its own `knowledge` table. A git co-change pass then adds co-modification edges.

### Auto-index on dispatch

- **Local compute**: honors `knowledge.auto_index` in `~/.ark/config.yaml`. Skip entirely with `auto_index: false`.
- **Remote compute**: always indexes via the arkd `/codegraph/index` endpoint. There is no way to skip it remotely -- the remote filesystem is the only place the indexer can see the code.

```yaml
# ~/.ark/config.yaml
knowledge:
  auto_index: true         # local dispatches index the repo
  incremental_index: true  # only re-index changed files
```

### MCP tools for agents

When an agent runs, it gets 6 MCP tools against the knowledge store:

| Tool | Purpose |
|------|---------|
| `knowledge/search` | Full-text search over nodes (files, symbols, sessions, memories). |
| `knowledge/context` | Build a token-budgeted context bundle for a question. |
| `knowledge/impact` | Find impact/blast radius of changing a file or symbol. |
| `knowledge/history` | Session and edit history for a file. |
| `knowledge/remember` | Save a memory node. |
| `knowledge/recall` | Retrieve memories (by query or label). |

### Context injection at dispatch

At dispatch time, Ark builds a token-budgeted context bundle from the knowledge graph (max around 2000 tokens) and injects it into the agent's system prompt. This gives the agent immediate situational awareness without inflating the prompt.

### CLI

```bash
ark knowledge search "auth middleware"
ark knowledge index <repo>
ark knowledge stats
ark knowledge remember "Router port is 8430" --tags router,ports
ark knowledge recall "router port"
ark knowledge ingest <path>
ark knowledge export --out ~/notes
ark knowledge import ~/notes
```

---

## 10. Cost Tracking

Ark has universal cost tracking across every runtime. Every LLM call is recorded via a transcript parser or router callback, priced through a local registry, and written to the `usage_records` table.

### Components

- **PricingRegistry** -- 300+ models with per-token prices, loaded from the LiteLLM public JSON. Lazy-refreshed.
- **UsageRecorder** -- appends rows to `usage_records` with input/output tokens, cost, session, user, tenant, model, provider, runtime, agent.
- **TranscriptParserRegistry** -- polymorphic parsers per runtime.

Per-runtime transcript parsers:

| Parser | Location |
|--------|----------|
| `ClaudeTranscriptParser` | `~/.claude/projects/<slug>/<session>.jsonl` (exact path resolved from session id) |
| `CodexTranscriptParser` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (matched by cwd) |
| `GeminiTranscriptParser` | `~/.gemini/tmp/<slug>/chats/session-*.jsonl` (matched by projectHash) |
| `GooseTranscriptParser` | Goose transcript logs (matched by session) |

### cost_mode column

Each usage row has a `cost_mode`:

| Mode | Meaning |
|------|---------|
| `api` | Per-token cost from PricingRegistry. |
| `subscription` | Flat-rate plan -- `cost_usd = 0`, tokens still recorded for rate-limit tracking. |
| `free` | `cost_usd = 0`. |

`claude-max` is the canonical subscription runtime (Claude Max $200/month). Its tokens feed dashboards but never add to the cost ledger.

### CLI

```bash
ark costs                       # summary with charts
ark costs --session <id>
ark costs --tenant acme
ark costs --by model
ark costs --by runtime
ark costs --by agent
ark costs --since 7d
ark costs-sync                  # rescan transcripts and fill gaps
ark costs-export --format csv --out costs.csv
```

Attribution works across session, user, tenant, model, provider, runtime, and agent dimensions.

### Budgets

Set daily, weekly, and monthly limits in `~/.ark/config.yaml`. When a limit is hit, new dispatches are blocked until the window rolls over (admins can override).

```yaml
budgets:
  daily_usd: 25
  weekly_usd: 100
  monthly_usd: 300
  warn_at_percent: 80
```

---

## 11. LLM Router

The LLM Router (`packages/router/`) is an OpenAI-compatible HTTP proxy that routes requests across providers with policies, circuit breakers, and an optional TensorZero backend.

### Policies

| Policy | Behavior |
|--------|----------|
| `quality` | Prefer the best model for each request class. |
| `balanced` | Trade off cost and quality. Default. |
| `cost` | Minimize cost. |

Each request is classified (complexity, length, tool calls) and routed to an appropriate model tier. Circuit breakers track per-provider failure rates and fail over to the next provider automatically. Cascade mode retries progressively stronger models on failure. Per-provider adapters normalize the request and response shape.

### TensorZero backend (optional)

TensorZero is an open-source Rust LLM gateway (Apache 2.0). When enabled, Ark generates a `tensorzero.toml` from your API keys and starts TensorZero in one of three modes:

1. Detect an existing sidecar on the configured port.
2. Start the native TensorZero binary if installed.
3. Fall back to Docker.

`packages/core/router/tensorzero.ts` is the lifecycle manager. Auto-start happens on boot when both `router.auto_start` and `tensorzero.enabled` are true.

### Injection into executors

When the router is enabled, executors inject `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL` (and provider variants) into the agent's environment. Every LLM call from the agent then flows: Agent -> Router -> (TensorZero) -> Provider. An `onUsage` callback feeds the `UsageRecorder`.

### Config

```yaml
# ~/.ark/config.yaml
router:
  enabled: true
  url: http://localhost:8430
  policy: balanced
  auto_start: true

tensorzero:
  enabled: true
  port: 3000
  config_dir: ~/.ark/tensorzero
  auto_start: true
```

### CLI

```bash
ark router start --port 8430 --policy balanced
ark router status
ark router costs
```

---

## 12. Auth and Multi-Tenancy

Ark is multi-tenant from the ground up. All entities are tenant-scoped: sessions, compute, events, messages, todos, groups, schedules, compute pools, compute templates, usage records, resource definitions, knowledge, knowledge edges.

### API keys

Format: `ark_<tenantId>_<secret>`. Example: `ark_acme_9f8a7b...`.

```bash
ark auth key create --tenant acme --role admin --label "CI key"
ark auth key list
ark auth key revoke <keyId>
ark auth key rotate <keyId>
```

### Roles

| Role | Permissions |
|------|-------------|
| `admin` | Full access, manage keys, set policies. |
| `member` | Start/stop sessions, read all tenant data. |
| `viewer` | Read-only. |

### Tenant policies

`TenantPolicyManager` enforces per-tenant rules:

```yaml
# applied via `ark tenant policy set --tenant acme --file policy.yaml`
allowed_providers: [local, docker, ec2-firecracker]
default_provider: docker
max_concurrent_sessions: 20
daily_cost_cap_usd: 200
compute_pools: [pool-fast, pool-gpu]

# integration enforcement
router_required: true
auto_index_required: true
router_policy: balanced
tensorzero_enabled: true
```

When `router_required` is on, dispatches fail unless the router is up. `auto_index_required` forces knowledge indexing for every dispatch (local and remote). `router_policy` locks the router policy for the tenant. `tensorzero_enabled` requires TensorZero to be the active backend.

### Sessions have user_id

Every session carries both `tenant_id` and `user_id`. Cost attribution, quotas, and audit all work per-user within a tenant.

### Tenant-scoped app context

```ts
const appAcme = app.forTenant("acme");
appAcme.sessions.list();                     // only acme sessions
appAcme.computes.list();                     // only acme compute
appAcme.knowledge.search("auth middleware"); // only acme knowledge
```

---

## 13. Git Worktrees

Every session gets its own git worktree at `~/.ark/worktrees/<sessionId>/` on a branch named after the session. This keeps work isolated and reviewable.

### Workflow

```bash
# Dispatch creates the worktree automatically
ark session start --repo . --summary "..." --dispatch

# See a diff stat
ark worktree diff <sessionId>

# Finish the session: merge or open a PR
ark worktree finish <sessionId>      # interactive: merge, PR, or discard
ark worktree merge <sessionId>       # merge into base branch
ark worktree pr <sessionId>          # push and create a PR via `gh`
```

The web dashboard shows a diff preview per session, with a "Finish" action that triggers the same merge/PR flow.

### Auto-PR

When an agent completes and the repo has a git remote, Ark auto-pushes the branch and creates a PR via `gh pr create`. Disable per-repo with `auto_pr: false` in `.ark.yaml`.

---

## 14. Search

Ark ships a FTS5 full-text search index across sessions, events, messages, and Claude Code transcripts.

```bash
ark search "race condition in scheduler"
ark search "auth middleware" --transcripts   # also scan ~/.claude/projects JSONL
ark search "pager bug" --index               # rebuild the FTS5 index
ark index                                    # alias for --index
```

Search uses FTS5 when the `transcript_index` virtual table exists, and falls back to file scanning only when the table is absent. If you see unexpectedly empty results on an existing DB, run `ark index` to build the FTS table.

---

## 15. Dashboards (CLI, Web)

Ark has two UI surfaces plus a desktop shell. Surface parity is a hard rule -- every feature that exists in one surface must exist in the other.

### CLI

```bash
ark dashboard           # top-like summary dashboard
ark session list
ark session events <id>
ark costs
ark compute list
```

Seventeen command modules cover sessions, compute, flows, skills, recipes, agents, runtimes, auth, router, knowledge, search, worktree, history, todo, config, tenant, and costs.

### Web

```bash
ark web                 # starts Vite dev server
make web-build          # production build
```

Vite + React + shadcn/ui with a custom design system (theme tokens, consistent component library). SSE live updates, Recharts cost charts (theme-aware, no animations), pipeline visualization with @xyflow/react + d3-dag. Pages: Dashboard, Sessions, Agents, Flows, Compute, History, Memory, Tools, Schedules, Costs, Settings. Login page for auth-required (hosted) mode.

### Desktop (Electron)

```bash
make desktop            # launches Electron wrapper
make desktop-build      # packages for distribution
```

Self-contained Electron shell wrapping the web dashboard. Includes auto-start for the daemon, single-instance lock, and health probes.

---

## 16. Knowledge Export and Import

Memories and learnings live in the knowledge graph, not in plain files. Ark provides a portable markdown format for backup, sharing, and cross-machine sync.

```bash
# Export all memories and learnings as markdown files
ark knowledge export --out ~/notes/ark

# Directory layout: one .md file per memory, YAML front matter for metadata
# ~/notes/ark/memory-<id>.md
# ---
# id: mem_01
# tags: [router, ports]
# created: 2026-04-01
# ---
# Router port is 8430

# Import back (idempotent by id)
ark knowledge import ~/notes/ark
```

Export and import are tenant-scoped in hosted mode. The old `~/.ark/memories.json` and `~/.ark/LEARNINGS.md` files are no longer used -- memories are nodes in the knowledge graph.

---

## 17. MCP Integration

Ark ships stub MCP server configs for four vendors: Atlassian (Jira/Confluence), GitHub, Linear, and Figma. These live in `mcp-configs/` and get merged into the agent's MCP server list at dispatch.

```bash
ls mcp-configs/
# atlassian.json  figma.json  github.json  linear.json
```

### MCP socket pooling

Spawning one MCP server process per agent is memory-expensive. Ark pools MCP server sockets and shares a single server process across agents on the same compute target. In measurements this drops memory use by 85-90 percent compared to per-agent spawning.

The pool is transparent -- agents see a normal MCP server and Ark routes requests through the shared socket.

---

## 18. Remote Client Mode

The CLI and Web can connect to a remote Ark server instead of running locally. They open a WebSocket `ArkClient` and delegate every operation.

```bash
# Env vars
export ARK_SERVER=https://ark.company.com
export ARK_TOKEN=ark_default_9f8a7b...

ark session list
ark web

# Or pass flags explicitly
ark --server https://ark.company.com --token ark_default_xxx session list
ark --server https://ark.company.com --token ark_default_xxx web
```

When remote mode is active, the CLI does not boot a local AppContext -- all state lives on the server.

---

## 19. Control Plane (Hosted Mode)

`ark server start --hosted` boots Ark as a multi-tenant control plane.

### What changes in hosted mode

| Subsystem | Local mode | Hosted mode |
|-----------|------------|-------------|
| Database | SQLite (`~/.ark/ark.db`) | Postgres (`DATABASE_URL`) |
| Resource stores | File-backed (`~/.ark/skills/`, etc.) | DB-backed (`DbResourceStore`, `resource_definitions` table) |
| SSE bus | In-memory | Redis (`REDIS_URL`) |
| Auth | Not enforced | API keys required |
| Workers | Single machine | Worker registry + scheduler |
| Tenants | Single `default` tenant | Multi-tenant with policies |

### Worker registry and scheduler

Workers register with the control plane via HTTP. The registry health-checks them every 60s and prunes stale workers after 90s. The session scheduler assigns new sessions to available workers, respecting tenant policies (allowed providers, max concurrency, cost caps, compute pools).

### Start

```bash
DATABASE_URL=postgres://ark:secret@localhost:5432/ark \
REDIS_URL=redis://localhost:6379/0 \
ark server start --hosted --port 19100
```

### Tenant setup

```bash
ark tenant create acme --name "Acme Corp"
ark auth key create --tenant acme --role admin --label "bootstrap"
ark tenant policy set --tenant acme --file policy.yaml
```

---

## 20. Deployment

### Dockerfile

The single Dockerfile in `.infra/Dockerfile` builds a bun-based image containing Ark, tmux, git, and the `gh` CLI. It is used for both the control plane and workers.

```bash
docker build -f .infra/Dockerfile -t ark:latest .
docker run --rm -it -p 19100:19100 ark:latest ark server start --hosted
```

### docker-compose

`docker-compose.yaml` in `.infra/` brings up the full hosted stack.

```yaml
services:
  ark:         # control plane (:19100)
  postgres:    # hosted DB
  redis:       # SSE bus
  tensorzero:  # optional LLM gateway
  worker-1:    # arkd worker
  worker-2:    # arkd worker
```

```bash
cd .infra && docker compose up -d
```

Ark auto-creates tables, starts the router and TensorZero (if enabled), and registers workers.

### Helm chart

`.infra/helm/ark/` is a production Helm chart with:

- Separate deployments for control plane and workers
- Postgres and Redis sub-charts (or external via values)
- Horizontal Pod Autoscaler on the scheduler
- Kata Containers runtime class for `k8s-kata` sessions
- Firecracker support via a privileged daemonset
- Ingress with TLS

```bash
helm install ark .infra/helm/ark \
  --set postgres.external=true \
  --set postgres.url=postgres://... \
  --set redis.external=true \
  --set redis.url=redis://... \
  --set router.enabled=true \
  --set tensorzero.enabled=true
```

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ARK_CONDUCTOR_PORT` | `19100` | Conductor HTTP port. |
| `ARK_CONDUCTOR_URL` | `http://localhost:19100` | Conductor URL for channels. |
| `ARK_ARKD_URL` | `http://localhost:19300` | arkd daemon URL. |
| `ARK_ARKD_PORT` | `19300` | arkd daemon port. |
| `ARK_CHANNEL_PORT` | auto | Per-session MCP channel port. |
| `ARK_SERVER` | - | Remote Ark server URL (remote client mode). |
| `ARK_TOKEN` | - | API key for remote server. |
| `DATABASE_URL` | - | Postgres URL (hosted mode). |
| `REDIS_URL` | - | Redis URL (hosted SSE bus). |
| `ARK_TEST_DIR` | - | Temp dir for test isolation. |

---

## Appendix: Key file locations

| Path | Purpose |
|------|---------|
| `~/.ark/ark.db` | SQLite database (local mode). Includes knowledge graph tables. |
| `~/.ark/worktrees/<sessionId>/` | Session git worktrees. |
| `~/.ark/tracks/<sessionId>/` | Launcher scripts, channel configs. |
| `~/.ark/skills/` | Global user skills. |
| `~/.ark/recipes/` | Global user recipes. |
| `~/.ark/flows/` | Global user flows. |
| `~/.ark/agents/` | Global user agents. |
| `~/.ark/runtimes/` | Global user runtimes. |
| `~/.ark/config.yaml` | User config (router, knowledge, tensorzero, compute templates, budgets). |
| `~/.ark/logs/` | Structured JSONL logs. |
| `.ark/` | Per-repo project config, skills, recipes, flows, agents, runtimes. |
| `.ark.yaml` | Per-repo config (auto_pr, default verify scripts). |
| `.claude/settings.local.json` | Hook config written at dispatch, cleaned on stop. |
| `~/.claude/projects/` | Claude Code JSONL transcripts. |
| `~/.codex/sessions/` | Codex JSONL transcripts. |
| `~/.gemini/tmp/` | Gemini JSONL transcripts. |

## Appendix: Common tasks cheat sheet

```bash
# Start a quick fix session
ark session start --recipe quick-fix --repo . --summary "..." --dispatch

# Run a feature build on a remote Firecracker VM
ark session start --recipe feature-build --repo . \
  --summary "Add SSO" --compute ec2-firecracker --dispatch

# Fan-out 4 children for independent subtasks
ark session fork <parentId> --count 4 --summaries "a,b,c,d"

# Swap runtime to Codex for one session
ark session start --repo . --summary "Refactor parser" \
  --agent implementer --runtime codex --dispatch

# Use Goose runtime
ark session start --repo . --summary "Add endpoint tests" \
  --agent implementer --runtime goose --dispatch

# Fully autonomous SDLC (no human gates)
ark session start --repo . --summary "Add health-check endpoint" \
  --flow autonomous-sdlc --dispatch

# Self-dogfood: ark works on itself
ark session start --recipe self-dogfood \
  --summary "Add health-check endpoint" --dispatch

# Use Max subscription (no per-token cost)
ark session start --repo . --summary "Long refactor" \
  --agent implementer --runtime claude-max --dispatch

# Inspect costs
ark costs --by runtime --since 7d
ark costs-export --format csv --out last-week.csv

# Check router health
ark router status

# Connect to a hosted server
ark --server https://ark.company.com --token ark_default_xxx web
```

---

That is the full tour. Every concept is documented here: sessions, 14 flows (including autonomous-sdlc, brainstorm, and conditional routing), agents, 5 runtimes (Claude, Codex, Gemini, Goose, and Claude Max), skills, 10 recipes, all 11 compute providers, compute templates, the ops-codegraph knowledge graph, universal cost tracking with cost modes, the LLM router with optional TensorZero backend, multi-tenant auth, git worktrees, search, dashboards across CLI/Web/Desktop (Electron), knowledge export/import, MCP integration with socket pooling, remote client mode, the hosted control plane, and deployment via Dockerfile, docker-compose, and Helm.
