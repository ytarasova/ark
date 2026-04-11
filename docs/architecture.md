# Ark Architecture Reference

> Canonical technical reference for the Ark codebase. Terse, factual, no tutorials.
> Last updated: 2026-04-10

## Table of Contents

1. [Overview](#1-overview)
2. [Deployment Modes](#2-deployment-modes)
3. [Core Components](#3-core-components)
4. [ArkD -- Universal Agent Daemon](#4-arkd----universal-agent-daemon)
5. [Conductor](#5-conductor-control-plane-http-server)
6. [MCP Socket Pooling](#6-mcp-socket-pooling)
7. [Channels -- Agent Communication](#7-channels----agent-communication)
8. [Executors](#8-executors)
9. [Compute Providers](#9-compute-providers)
10. [Transcript Parsers](#10-transcript-parsers)
11. [LLM Router + TensorZero](#11-llm-router--tensorzero)
12. [Knowledge Graph + ops-codegraph](#12-knowledge-graph--ops-codegraph)
13. [Multi-Tenancy Details](#13-multi-tenancy-details)
14. [Event Bus + SSE Bus](#14-event-bus--sse-bus)
15. [Ports Reference](#15-ports-reference)
16. [Data Locations](#16-data-locations)
17. [Key Architectural Decisions](#17-key-architectural-decisions)

---

## 1. Overview

Ark is an autonomous agent ecosystem that orchestrates AI coding agents through DAG-based SDLC flows. It ships as a single codebase that runs in two deployment modes -- **local single-user** (SQLite, file-backed stores, no auth) and **hosted control plane** (Postgres, DB-backed stores, API keys, multi-tenant, multi-user) -- with identical code paths toggled by config (`databaseUrl`, `redisUrl`, `auth.enabled`). Core features include 11 compute providers, 3 runtimes (Claude Code, Codex CLI, Gemini CLI), polymorphic transcript parsers, an OpenAI-compatible LLM router, a unified knowledge graph powered by ops-codegraph, MCP socket pooling, bidirectional agent channels, and a universal HTTP daemon (arkd) that runs on every compute target.

---

## 2. Deployment Modes

Ark is deployed in two modes with the same binary and the same code paths. The `AppContext` constructor inspects config and swaps the database adapter, store implementations, and auth middleware accordingly.

### 2.1 Local single-user mode (default)

| Aspect | Value |
|---|---|
| Runtime | Bun (from source or `ark` symlink) |
| Database | SQLite at `~/.ark/ark.db` (WAL mode, 5s busy timeout) |
| Stores | File-backed three-tier (builtin > global `~/.ark/` > project `.ark/`) |
| Auth | None (single user, tenant = `"default"`) |
| Conductor | Started by TUI only (CLI talks to DB directly) |
| ArkD | Started on-demand per compute operation |
| Channels | Unix sockets + localhost HTTP |
| SSE bus | In-memory |
| Cost tracking | Session-level, local DB |
| Config | `~/.ark/config.yaml` |

### 2.2 Hosted / control plane multi-tenant mode

| Aspect | Value |
|---|---|
| Runtime | Bun (containerized) |
| Database | PostgreSQL via `DATABASE_URL` |
| Stores | `DbResourceStore` on `resource_definitions` table (tenant-scoped rows) |
| Auth | API keys REQUIRED (`auth.enabled: true`), format `ark_<tenantId>_<secret>` |
| Conductor | Always running |
| ArkD | Runs on every compute target in the worker pool |
| SSE bus | Redis via `REDIS_URL` (multi-instance safe) |
| Cost tracking | Tenant + user + session, `usage_records` table |
| Scheduler | `WorkerRegistry` + `SessionScheduler` (`hosted.ts`) |
| Deployment | `docker-compose up -d` or `helm install .infra/helm/ark/` |
| Config | Env vars + per-tenant DB rows |

### 2.3 Comparison at a glance

| Aspect | Local | Control plane |
|---|---|---|
| DB | SQLite | Postgres |
| Stores | Files | DB (tenant-scoped) |
| Auth | None | API keys + roles |
| Users | 1 (you) | Many |
| Tenants | 1 (`default`) | Many |
| SSE | In-memory | Redis |
| Compute | Local/Docker/EC2 | Full pool, scheduled |
| Cost tracking | Session-level | Tenant + user + session |
| Scheduler | None | WorkerRegistry + SessionScheduler |
| Config location | `~/.ark/config.yaml` | env vars + per-tenant DB rows |

### 2.4 Same code, two modes

The same codebase handles both modes through two mechanisms:

1. **DB adapter swap.** `AppContext` constructor reads `config.databaseUrl`. If it starts with `postgres://`, it instantiates `PostgresAdapter`, otherwise `BunSqliteAdapter`. Both implement `IDatabase`. All repositories and stores depend only on `IDatabase`.

2. **Tenant scoping via `forTenant(id)`.** `AppContext.forTenant(tenantId)` returns a scoped view of the context. It uses `Object.defineProperty` overrides to wrap each repository and store with `setTenant(tenantId)` so every SQL call is automatically filtered. In local mode this is a no-op (tenant is always `"default"`); in hosted mode every request from the auth middleware is scoped to the caller's tenant.

```ts
// packages/core/app.ts
const app = new AppContext(loadConfig());
await app.boot();
const scoped = app.forTenant("acme-corp");
await scoped.sessions.list(); // WHERE tenant_id = 'acme-corp'
```

---

## 3. Core Components

### 3.1 AppContext (`packages/core/app.ts`)

The root of the dependency graph. An Awilix DI container that owns every singleton: repositories, services, stores, providers, parsers, observability. Created by CLI, TUI, and hosted entry points; disposed on shutdown.

```ts
class AppContext {
  sessions: SessionRepository;
  computes: ComputeRepository;
  computeTemplates: ComputeTemplateRepository;
  events: EventRepository;
  messages: MessageRepository;
  todos: TodoRepository;
  sessionService: SessionService;
  computeService: ComputeService;
  historyService: HistoryService;
  flows: FlowStore;
  skills: SkillStore;
  agents: AgentStore;
  recipes: RecipeStore;
  runtimes: RuntimeStore;
  knowledge: KnowledgeStore;
  transcriptParsers: TranscriptParserRegistry;
  pricing: PricingRegistry;
  usage: UsageRecorder;
  pools: ComputePoolManager;
  tenantPolicies: TenantPolicyManager;
  apiKeys: ApiKeyManager;
  // ... + conductor, eventBus, sseBus, providerRegistry, executorRegistry
  boot(): Promise<void>;
  shutdown(): Promise<void>;
  forTenant(tenantId: string): AppContext;
  static forTest(): AppContext;
}
```

CLI creates it with `skipConductor: true`. TUI and hosted mode start the conductor. Tests use `AppContext.forTest()` which creates a temp dir and isolated DB.

### 3.2 IDatabase abstraction (`packages/core/database/`)

Interface that lets the same repositories work on SQLite or Postgres.

| File | Purpose |
|---|---|
| `database.ts` | `IDatabase` interface + `SqlStatement` + `SqlResult` |
| `database-sqlite.ts` | `BunSqliteAdapter` wrapping `bun:sqlite` |
| `database-postgres.ts` | `PostgresAdapter` wrapping `pg` pool |

All repositories and stores depend only on `IDatabase`, never on `bun:sqlite` or `pg` directly. Schema init is per-adapter (`initSchema()` runs dialect-appropriate SQL).

### 3.3 Repositories (`packages/core/repositories/`)

SQL CRUD behind typed classes. Column whitelists prevent injection. All repositories expose `setTenant(id)` so `forTenant()` can scope them.

| Repository | Table | Notes |
|---|---|---|
| `SessionRepository` | `sessions` | Also tracks `user_id`, `tenant_id` |
| `ComputeRepository` | `computes` | Tenant-scoped |
| `ComputeTemplateRepository` | `compute_templates` | Named presets |
| `EventRepository` | `events` | Session event log |
| `MessageRepository` | `messages` | Inbox + agent messages |
| `TodoRepository` | `todos` | User checklist items |

Access via `app.sessions`, `app.computes`, `app.events`, `app.messages`, `app.todos`, `app.computeTemplates`.

### 3.4 Services (`packages/core/services/`)

Business logic. Split into a simple lifecycle facade and an orchestration module.

| Service | Responsibility |
|---|---|
| `SessionService` (`services/session.ts`) | Lifecycle facade: `start`, `stop`, `resume`, `complete`, `pause`, `delete`. Delegates complex ops via dynamic import |
| `ComputeService` | Compute provisioning, start/stop, cleanup |
| `HistoryService` | Claude Code project history, transcript import |
| `session-orchestration.ts` | Every other operation -- dispatch, advance, fork, clone, spawn, fan-out, handoff, worktree ops, hook status, report handling |

**Critical rule:** every exported function in `session-orchestration.ts` takes `app: AppContext` as its first argument. No `getApp()` calls, no module-level state. This was enforced during the DI migration.

```ts
// correct
await dispatch(app, sessionId);
await fanOut(app, parentId, opts);

// banned
await dispatch(sessionId); // would require getApp() inside
```

### 3.5 Stores (`packages/core/stores/`)

Resource stores for declarative YAML definitions. Two implementations:

| Store | Resource | File path (local) |
|---|---|---|
| `FlowStore` | Flow YAML | `flows/definitions/*.yaml` |
| `SkillStore` | Skill markdown | `skills/*.md` |
| `AgentStore` | Agent YAML | `agents/*.yaml` |
| `RecipeStore` | Recipe YAML | `recipes/*.yaml` |
| `RuntimeStore` | Runtime YAML | `runtimes/*.yaml` |

**Local mode:** file-backed three-tier resolution `builtin > ~/.ark/<kind>/ > .ark/<kind>/`.

**Hosted mode:** `DbResourceStore` reads from the `resource_definitions` table (columns: `name`, `kind`, `tenant_id`, `content`, `version`). Same `list()` / `get()` / `save()` / `delete()` interface. Export/import CLI commands move YAML between file-backed and DB-backed stores for portability.

Access via `app.flows`, `app.skills`, `app.agents`, `app.recipes`, `app.runtimes`.

### 3.6 KnowledgeStore (`packages/core/knowledge/store.ts`)

Unified knowledge graph. Nodes and edges in SQLite/Postgres. Tenant-scoped.

- **Node types:** `file`, `symbol`, `session`, `memory`, `learning`, `skill`, `recipe`, `agent`
- **Edge types:** `depends_on`, `imports`, `modified_by`, `calls`, `contains`, etc.
- **Tables:** `knowledge` (nodes), `knowledge_edges` (edges)

Access via `app.knowledge`. Fed by the codegraph indexer (`indexer.ts`) and by direct writes from agents via MCP tools.

### 3.7 PricingRegistry + UsageRecorder

Universal cost tracking.

- **`PricingRegistry`** (`packages/core/observability/pricing.ts`) -- 300+ models loaded from LiteLLM JSON. Per-token input/output rates.
- **`UsageRecorder`** (`packages/core/observability/usage-recorder.ts`) -- records `usage_records` rows with `cost_mode` column:
  - `api`: per-token cost from `PricingRegistry`
  - `subscription`: `cost_usd = 0`, tokens still recorded for rate limit tracking (e.g. Claude Max)
  - `free`: `cost_usd = 0`

Session-orchestration calls `usage.record()` after parsing transcripts at session completion.

### 3.8 TranscriptParserRegistry

Polymorphic parser per runtime. Registered at boot via `app.transcriptParsers.register(name, parser)`. Session-orchestration looks up the parser by the session's runtime and calls `parse(sessionId, workdir)` to extract token counts and messages. See [Section 10](#10-transcript-parsers).

### 3.9 ComputePoolManager

Tenant-scoped compute pools. A tenant can define named pools (e.g. `"gpu-pool"`, `"staging"`) that restrict which providers and regions sessions can land on. Enforced by the scheduler.

### 3.10 TenantPolicyManager (`packages/core/tenant-policy.ts`)

Per-tenant policy store. Fields:

```ts
interface TenantPolicy {
  tenantId: string;
  allowedProviders: string[];
  defaultProvider: string;
  maxConcurrentSessions: number;
  dailyCostCapUsd: number;
  routerRequired: boolean;       // force LLM router usage
  autoIndexRequired: boolean;    // force auto-index on dispatch
  routerPolicy: "quality" | "balanced" | "cost";
  tensorzeroEnabled: boolean;
  pools: string[];
}
```

Enforced at session start and dispatch time. Blocks requests that violate the policy.

### 3.11 ApiKeyManager (`packages/core/api-keys.ts`)

Only used in hosted mode. Manages API keys in the `api_keys` table.

- Format: `ark_<tenantId>_<secret>`
- Methods: `create`, `validate`, `revoke`, `rotate`, `list`
- Roles: `admin`, `member`, `viewer`
- Secret stored as SHA-256 hash

`auth.ts` middleware extracts the API key from the `Authorization` header, validates it, and builds a `TenantContext` that is passed to handlers.

---

## 4. ArkD -- Universal Agent Daemon

**This is a critical section.** ArkD is what makes Ark's compute layer uniform across local, container, VM, and cloud targets.

### 4.1 What it is

A stateless HTTP server that runs on every compute target on port 19300. Single binary (`packages/arkd/server.ts`, ~800 lines) that exposes agent lifecycle, file ops, exec, metrics, channel relay, and codegraph indexing over HTTP.

### 4.2 Why it exists

Without arkd, the conductor would need to SSH into every compute target for every operation -- slow, auth-fragile, and N different code paths (local shell vs docker exec vs EC2 SSH vs K8s exec). Instead:

- Every compute target runs one arkd instance.
- Conductor speaks HTTP to arkd, always.
- Local, docker, EC2, K8s, firecracker -- all look identical to the control plane.

### 4.3 What it runs

| Endpoint | Purpose |
|---|---|
| `POST /agent/launch` | Launch an agent via tmux (runs the executor command) |
| `POST /agent/kill` | Kill the tmux session |
| `GET /agent/status` | Running/idle/done |
| `POST /agent/send` | Send keys to tmux pane |
| `POST /files/read` | Read a file on the remote target |
| `POST /files/write` | Write a file |
| `POST /files/list` | List a directory |
| `POST /exec` | Run a command with sandbox |
| `GET /metrics` | CPU, memory, disk, uptime |
| `POST /port/probe` | Check if a port is bound |
| `POST /channel/report` | Channel relay (forwards to conductor) |
| `POST /docker/list` | List docker containers on the host |
| `POST /docker/exec` | Exec into a container |
| `POST /codegraph/index` | Run codegraph build locally, return parsed nodes/edges |

### 4.4 How conductor talks to it

Conductor (`http://<conductor>:19100`) issues HTTP calls to arkd at `http://<compute-ip>:19300`. The provider layer (`packages/compute/*`) knows how to find the arkd IP for each target:

- `local` -- `http://localhost:19300`
- `docker` -- `http://<container-ip>:19300`
- `ec2*` -- `http://<ec2-public-ip>:19300`
- `k8s*` -- `http://<pod-ip>:19300`
- `firecracker` -- `http://<vm-ip>:19300`

### 4.5 Where it runs

| Compute target | How arkd is deployed |
|---|---|
| Local machine | `ark arkd` starts it as a user process |
| Docker container | Baked into the image, starts via CMD on boot |
| Devcontainer | Same as Docker |
| EC2 | Installed by cloud-init, runs as systemd service |
| K8s pod | Sidecar container in the agent pod |
| Firecracker VM | Baked into the rootfs, starts on boot |

### 4.6 Auth

When `ARK_ARKD_TOKEN` is set, arkd requires bearer token auth on every request. Conductor fetches the token from the compute record before making calls. In local mode, the token is typically unset.

### 4.7 `/codegraph/index` endpoint

When a session dispatches to remote compute, the conductor must index the remote checkout (not the local one). Instead of copying the tree back, the flow is:

1. Conductor posts `{ workdir }` to `POST /codegraph/index` on the remote arkd.
2. ArkD runs `codegraph build` locally in the remote worktree.
3. ArkD parses `.codegraph/graph.db` and returns nodes + edges as JSON.
4. Conductor writes them into the Ark knowledge store.

Local mode honors `knowledge.auto_index` config. **Remote mode ALWAYS indexes via arkd** regardless of config -- this is the only way agents on remote targets get knowledge context.

### 4.8 Channel relay role

See [Section 7](#7-channels----agent-communication). ArkD is the hop between the in-process `ark-channel` MCP server (stdio, running inside the agent) and the conductor. Every session's agent reports flow `agent -> ark-channel -> arkd -> conductor`. Reverse path: `conductor -> arkd -> ark-channel -> agent`.

---

## 5. Conductor (Control Plane HTTP Server)

The HTTP surface of the control plane. Lives in `packages/core/conductor.ts` (with helpers under `packages/core/conductor/`).

- **Port:** `19100` (hardcoded -- referenced in `conductor.ts`, `channel.ts`, tests, and `constants.ts`)
- **Started by:** TUI (for local mode) and hosted mode entry (`hosted.ts`)
- **NOT started by:** the CLI -- CLI sessions talk directly to the DB through `AppContext`

### 5.1 Routes

| Route | Purpose |
|---|---|
| `POST /hooks/status` | Claude Code hook status events (busy/idle/error/done) |
| `POST /channel/report` | Agent report from `ark-channel` (via arkd) |
| `POST /channel/message` | Human-to-agent message (outbound) |
| `POST /workers/register` | Worker registration (hosted mode) |
| `POST /workers/heartbeat` | Worker health |
| `GET /tenants/:id/policy` | Read tenant policy |
| `POST /tenants/:id/policy` | Write tenant policy |
| `GET /healthz` | Liveness |
| `GET /metrics` | Prometheus metrics |

### 5.2 Delegation pattern

`startConductor(app, port)` receives the `AppContext` explicitly -- no `getApp()` calls. Handlers delegate to `session-orchestration.ts` functions:

```ts
// packages/core/conductor.ts
app.post("/hooks/status", async (req) => {
  const body = await req.json();
  await applyHookStatus(app, body.sessionId, body.status);
});

app.post("/channel/report", async (req) => {
  const body = await req.json();
  await applyReport(app, body.sessionId, body.report);
});
```

### 5.3 Test notes

Conductor tests use offset ports (19199, 19200) to avoid collisions. Integration tests spin up a throwaway conductor, hit it over HTTP, and assert DB state.

---

## 6. MCP Socket Pooling

**This is a critical section.** MCP socket pooling is what lets Ark run dozens of parallel sessions without exhausting memory.

### 6.1 Problem

Each Ark session can have multiple agents. Each agent loads multiple MCP servers (knowledge graph, filesystem, context7, playwright, github, etc.). Without pooling:

```
5 sessions x 6 MCP servers = 30 MCP processes
Each MCP process: 100-300 MB
Total: 3-9 GB just for MCPs
```

### 6.2 Solution

Run **one** process per MCP server. Share it across all sessions via Unix domain sockets.

- Single MCP process listens on `/tmp/ark-mcp-<name>.sock`
- Each session's agent connects via a tiny proxy: `{"command": "ark", "args": ["mcp-proxy", "/tmp/ark-mcp-<name>.sock"]}`
- The proxy speaks the MCP stdio protocol to the agent and forwards to the socket
- ~85-90% memory reduction in practice

### 6.3 SocketProxy architecture

The `SocketProxy` class (`packages/core/mcp-pool.ts`) wraps one MCP process and accepts multiple concurrent stdio clients.

```
agent-1 stdio <-> mcp-proxy <-> unix socket <-> SocketProxy <-> MCP process
agent-2 stdio <-> mcp-proxy <-> unix socket <-^
agent-3 stdio <-> mcp-proxy <-> unix socket <-^
```

Responsibilities:
- Multiplex JSON-RPC requests from N clients to one MCP process
- Track request IDs and route responses back to the right client
- Health monitoring + auto-restart on MCP process crash
- Graceful shutdown on drain

### 6.4 Config toggles

Under `mcp_pool:` in `~/.ark/config.yaml`:

```yaml
mcp_pool:
  enabled: true
  autoStart: true          # start pool at boot
  poolAll: true            # pool every MCP server found in configs
  excludeMcps:             # names to keep as per-session processes
    - ark-channel          # channels are always per-session
    - flaky-mcp
```

### 6.5 CLI entry

```bash
ark mcp-proxy /tmp/ark-mcp-knowledge.sock
```

This is the client side. It speaks MCP stdio on stdin/stdout and opens a Unix socket connection to the pooled process. The session's `.mcp.json` references this command instead of spawning the MCP server directly.

---

## 7. Channels -- Agent Communication

**This is a critical section.** Channels are how agents communicate with the control plane and with humans.

### 7.1 What channels are

Bidirectional communication between the agent and the rest of the system. Based on the **official Claude Code `claude/channel` protocol**. Implemented in `packages/core/conductor/channel.ts` and the `ark-channel` MCP server.

### 7.2 Protocol

The `ark-channel` MCP server declares the `claude/channel` capability. Communication is bidirectional:

**Inbound (control plane -> agent):**
- Transport: `notifications/claude/channel` JSON-RPC notifications
- Agent sees them as `<channel source="ark" ...>` tags in context
- Used for human steering, sub-agent handoff messages, verify gate failures

**Outbound (agent -> control plane):**
Two MCP tools on `ark-channel`:

| Tool | Purpose |
|---|---|
| `report` | Agent reports progress, completion, error, or a question |
| `send_to_agent` | Agent messages other agents (for handoff, fan-out coordination) |

### 7.3 Data flow

```
Agent (Claude Code process)
  |
  | stdio MCP
  v
ark-channel MCP server (in-process, stdio)
  |
  | HTTP POST
  v
arkd (:19300 on the compute target)
  |
  | HTTP POST /channel/report
  v
Conductor (:19100)
  |
  | session-orchestration.applyReport(app, ...)
  v
Database + SSE bus (TUI/Web get live updates)
```

Reverse path (human steering):

```
Human sends message in TUI/Web
  |
  v
Conductor
  |
  | HTTP POST to compute arkd
  v
arkd (:19300)
  |
  | HTTP POST to channel port
  v
ark-channel HTTP listener
  |
  | MCP notifications/claude/channel
  v
Agent sees <channel source="ark" ...> tags
```

### 7.4 Port allocation

Channel ports are derived deterministically from the session ID:

```
channel_port = 19200 + (parseInt(sessionId.replace("s-",""), 16) % 10000)
```

This avoids port allocator races and makes ports reproducible across restarts. The allocation logic lives in `packages/core/channel.ts` and is duplicated in the tests and hooks config writer.

### 7.5 Why not direct conductor <-> agent?

Because agents run on potentially remote compute (EC2, K8s, firecracker). Going through arkd gives one HTTP endpoint per compute target (port 19300), regardless of how many sessions are on it. The control plane only needs to know the compute IP; arkd handles the per-session fan-out.

---

## 8. Executors

Polymorphic agent launchers. Each executor knows how to launch a specific kind of runtime.

### 8.1 Interface

```ts
// packages/core/executor.ts
interface Executor {
  launch(opts: LaunchOptions): Promise<LaunchResult>;
  kill(sessionId: string): Promise<void>;
  status(sessionId: string): Promise<AgentStatus>;
  send(sessionId: string, input: string): Promise<void>;
  capture(sessionId: string): Promise<string>;
}
```

### 8.2 Built-in executors

| Name | Purpose |
|---|---|
| `claude-code` | Launches Claude Code in tmux. Writes `.claude/settings.local.json` with HTTP hooks. Sets up MCP channel server and hooks config |
| `subprocess` | Spawns any command as a child process. Good for linters, test runners, custom scripts |
| `cli-agent` | Runs any CLI tool (codex, gemini, etc.) in tmux with worktree isolation. Uses the runtime's `command` array |

### 8.3 Registration

Executors are registered at boot in `app.ts` via `registerExecutor(name, impl)`. The registry is in `packages/core/executor.ts`. An agent's `runtime` field points to a runtime definition, and that runtime's `type` selects the executor.

```yaml
# runtimes/codex.yaml
name: codex
type: cli-agent            # -> selects the cli-agent executor
command: ["codex", "--auto"]
```

### 8.4 Router env injection

`packages/core/router/router-env.ts` builds environment variables for router URL injection. When the LLM router is enabled, executors inject:

```
ANTHROPIC_BASE_URL=http://router:8430/v1
OPENAI_BASE_URL=http://router:8430/v1
```

This redirects the agent's LLM calls through the Ark router without changing the agent code or config. Used by all three runtimes (claude, codex, gemini).

---

## 9. Compute Providers

11 providers total (+ 3 ec2 sub-variants = 14 compute targets). Brief summary here; full details in `docs/providers.md`. All providers implement the `ComputeProvider` interface, and all (except `local`) talk to a remote arkd via HTTP.

### 9.1 Local worktree only

| Provider | Notes |
|---|---|
| `local` | Runs in a git worktree on the host. No isolation. ArkD on `localhost:19300`. Fastest |

### 9.2 Local isolated

| Provider | Notes |
|---|---|
| `docker` | Local Docker container. Image pre-baked with arkd. Resource limits via Docker |
| `devcontainer` | VS Code devcontainer spec. Same as docker but honors `.devcontainer/devcontainer.json` |
| `firecracker` | Local Firecracker micro-VM. Hardware isolation. Kernel + rootfs managed by Ark |

### 9.3 Remote (EC2 + arkd)

| Provider | Notes |
|---|---|
| `ec2` | Base EC2 instance. ArkD installed via cloud-init |
| `ec2-docker` | EC2 + Docker-in-Docker for extra sandboxing |
| `ec2-devcontainer` | EC2 + devcontainer runtime |
| `ec2-firecracker` | EC2 host running Firecracker micro-VMs -- strongest remote isolation |

### 9.4 Managed / cluster

| Provider | Notes |
|---|---|
| `e2b` | E2B managed sandbox service. Session-scoped, fast cold start |
| `k8s` | Kubernetes pod with arkd sidecar. Vanilla runtime |
| `k8s-kata` | Kubernetes with Kata Containers runtime (VM isolation per pod) |

---

## 10. Transcript Parsers

Polymorphic, DI-based. Each runtime has its own parser that knows where its transcripts live on disk and how to extract token counts and messages.

### 10.1 Interface

```ts
// packages/core/runtimes/transcript-parser.ts
interface TranscriptParser {
  runtime: string;
  parse(sessionId: string, workdir: string): Promise<ParsedTranscript>;
}

interface ParsedTranscript {
  messages: ParsedMessage[];
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  model?: string;
}
```

### 10.2 Implementations

| Runtime | Implementation | Transcript location | Identification |
|---|---|---|---|
| `claude` | `packages/core/runtimes/claude/parser.ts` | `~/.claude/projects/<slug>/<session>.jsonl` | Exact path from session ID |
| `codex` | `packages/core/runtimes/codex/parser.ts` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | Cwd-matched |
| `gemini` | `packages/core/runtimes/gemini/parser.ts` | `~/.gemini/tmp/<slug>/chats/session-*.jsonl` | projectHash-matched |

### 10.3 Registry

`TranscriptParserRegistry` is exposed via `app.transcriptParsers`:

```ts
app.transcriptParsers.register("claude", new ClaudeTranscriptParser());
app.transcriptParsers.register("codex", new CodexTranscriptParser());
app.transcriptParsers.register("gemini", new GeminiTranscriptParser());

const parser = app.transcriptParsers.get(runtimeName);
const parsed = await parser.parse(sessionId, workdir);
```

### 10.4 Session identification

**Session identification uses workdir/cwd matching, not "latest by mtime."** This is deliberate -- the latest-by-mtime heuristic fails in parallel dispatches where two sessions start at the same time in different worktrees. Each parser knows how its runtime encodes the project/workdir into the transcript path and matches exactly.

### 10.5 Usage recording

Session-orchestration calls the parser at session completion and feeds tokens into `UsageRecorder`:

```ts
const parsed = await app.transcriptParsers.get(session.runtime).parse(sessionId, workdir);
await app.usage.record({
  sessionId,
  tenantId,
  userId,
  model: parsed.model,
  tokens: parsed.usage,
  costMode: runtime.costMode, // api | subscription | free
});
```

---

## 11. LLM Router + TensorZero

### 11.1 Router (`packages/router/`)

OpenAI-compatible HTTP proxy. Routes requests across multiple LLM providers with fallback and cost tracking.

- **Endpoint:** `POST /v1/chat/completions` (OpenAI-compatible)
- **Default port:** 8430
- **Start:** `ark router start [--port 8430] [--policy balanced]`

**Routing policies:**

| Policy | Behavior |
|---|---|
| `quality` | Prefer the best model regardless of cost |
| `balanced` | Optimize cost/quality tradeoff |
| `cost` | Minimize cost |

**Features:**

- Circuit breakers per provider with automatic fallback
- Request classification -- classifies prompt complexity to select appropriate model tier
- Cascade mode -- try cheap model first, escalate on low confidence
- Per-request cost accumulation with model/provider breakdown
- `onUsage` callback that wires into `UsageRecorder`

### 11.2 TensorZero integration (`packages/core/router/tensorzero.ts`)

Optional Rust-based gateway (Apache 2.0) that replaces the Bun router for production. Higher throughput and lower latency.

**Lifecycle manager:**

- Start modes (in order): sidecar detect -> native binary -> Docker fallback
- Config generated from configured API keys into `tensorzero.toml`
- Auto-starts on boot when `router.autoStart && tensorZero.enabled`

**Default port:** 3000

### 11.3 Router URL injection

When the router (Bun or TensorZero) is enabled, executors inject base URLs into agent env:

```
ANTHROPIC_BASE_URL=http://router:8430/v1
OPENAI_BASE_URL=http://router:8430/v1
```

Router receives the request, applies policy, fans out to real providers, and calls `onUsage` with the token counts. `UsageRecorder` writes a `usage_records` row with the tenant and session ID.

### 11.4 Cost modes

The router writes costs with the runtime's `cost_mode`:

| Mode | Behavior |
|---|---|
| `api` | Look up per-token rate in `PricingRegistry` (300+ models via LiteLLM JSON) |
| `subscription` | `cost_usd = 0`, but tokens still recorded for rate limit tracking |
| `free` | `cost_usd = 0` |

---

## 12. Knowledge Graph + ops-codegraph

### 12.1 Unified store

One knowledge store holds everything:

- Codebase structure (files, symbols, imports)
- Session history (sessions as nodes, edges to files they touched)
- Memories (explicit `knowledge/remember` writes)
- Learnings (retrospective notes)
- Skills, recipes, agents (registered resources)

All rows are tenant-scoped. Tables: `knowledge` (nodes), `knowledge_edges` (edges).

### 12.2 Indexer: ops-codegraph

Ark uses **`@optave/codegraph`** (ops-codegraph) for codebase parsing. **NOT Axon. NOT a Python implementation.** Key facts:

- Native Rust engine via Bun FFI
- 33 languages via tree-sitter WASM
- npm dependency, installed globally: `npm install -g @optave/codegraph`
- Reads source tree, writes `.codegraph/graph.db` (SQLite)
- Ark's `indexer.ts` reads that DB and upserts into Ark's knowledge store with tenant scoping

### 12.3 Auto-index on dispatch

| Mode | Behavior |
|---|---|
| Local | Honors `knowledge.auto_index: true` in `~/.ark/config.yaml` |
| Remote (via arkd) | **ALWAYS indexes** regardless of config, via `POST http://<compute-ip>:19300/codegraph/index` |

The remote path is unconditional because agents on remote targets have no other way to get knowledge context.

### 12.4 Context injection at dispatch

At session dispatch, `knowledge/context.ts` builds a relevant knowledge context for the agent and injects it into the system prompt.

- Token-budgeted to **~2000 tokens max**
- Relevance computed from ticket/summary + recent session history
- Includes file paths, symbol summaries, co-change hints, recent memories

### 12.5 Agent MCP tools

Six MCP tools exposed to agents via `packages/core/knowledge/mcp.ts`:

| Tool | Purpose |
|---|---|
| `knowledge/search` | Full-text search across nodes |
| `knowledge/context` | Build a relevant context slice |
| `knowledge/impact` | What depends on this file/symbol |
| `knowledge/history` | Sessions that touched this node |
| `knowledge/remember` | Write a memory node |
| `knowledge/recall` | Read memories by tag or query |

---

## 13. Multi-Tenancy Details

### 13.1 Tenant scoping on every entity

Every tenant-relevant table has a `tenant_id` column:

```
sessions, compute, events, messages, todos, groups, schedules,
compute_pools, compute_templates, usage_records,
resource_definitions, knowledge, knowledge_edges, api_keys
```

Sessions additionally have a `user_id` column that tracks which user inside the tenant owns the session.

### 13.2 `AppContext.forTenant(id)`

Creates a tenant-scoped view of the context. Implementation uses `Object.defineProperty` to override each repository and store with one that has `setTenant(tenantId)` applied.

```ts
const scoped = app.forTenant("acme-corp");
await scoped.sessions.list();    // WHERE tenant_id = 'acme-corp'
await scoped.flows.list();       // DB-backed flows filtered to acme-corp
await scoped.knowledge.search(); // tenant-scoped knowledge search
```

### 13.3 TenantPolicyManager

Enforced at session start and dispatch. Fields include:

| Field | Purpose |
|---|---|
| `allowedProviders` | Whitelist of compute providers |
| `defaultProvider` | Fallback if request doesn't specify |
| `maxConcurrentSessions` | Hard cap |
| `dailyCostCapUsd` | Enforced via `UsageRecorder` totals |
| `routerRequired` | Force LLM router usage (reject direct provider calls) |
| `autoIndexRequired` | Force auto-index on dispatch |
| `routerPolicy` | Override agent's router policy |
| `tensorzeroEnabled` | Force TensorZero backend |
| `pools` | Restrict to specific compute pools |

### 13.4 DbResourceStore for hosted mode

In hosted mode, file-backed stores are replaced with `DbResourceStore` on the `resource_definitions` table.

```sql
CREATE TABLE resource_definitions (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,  -- flow | skill | agent | recipe | runtime
  name       TEXT NOT NULL,
  content    TEXT NOT NULL,  -- YAML or markdown
  version    INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, kind, name)
);
```

Same `list() / get() / save() / delete()` interface as file-backed stores. Each tenant has their own copy of any resource they've customized.

### 13.5 Export/import for portability

`ark resource export` and `ark resource import` move YAML between file-backed (local) and DB-backed (hosted) stores. Users can author resources locally and push them to a hosted tenant, or pull a hosted tenant's resources into a local workspace.

---

## 14. Event Bus + SSE Bus

### 14.1 In-memory event bus

Pub/sub for in-process listeners. Used by:

- Session-orchestration to emit lifecycle events (`dispatched`, `stage_advanced`, `completed`, etc.)
- Metrics polling to emit sample events
- TUI to subscribe to events for live refresh

All listeners are in-process; the event bus does not cross process boundaries.

### 14.2 SSE bus

Server-Sent Events bus for UI live updates (TUI, Web, Desktop).

| Mode | Implementation | File |
|---|---|---|
| Local / single instance | In-memory | `packages/core/sse-bus.ts` |
| Hosted / multi-instance | Redis-backed | `packages/core/sse-redis.ts` |

The Redis backend uses Redis pub/sub so that events produced on one control plane instance reach SSE clients connected to a different instance. Enabled when `REDIS_URL` is set.

Clients subscribe to `/sse?tenant=<id>` (hosted) or `/sse` (local) and get a stream of JSON events for the tenant's sessions.

---

## 15. Ports Reference

| Service | Default port | Configurable | Notes |
|---|---|---|---|
| Conductor | `19100` | No (hardcoded) | References in `conductor.ts`, `channel.ts`, `constants.ts`, tests |
| ArkD | `19300` | Yes (`ARK_ARKD_PORT`) | Universal agent daemon |
| Channel | `19200 + hash` | Deterministic per session | `19200 + (parseInt(sessionId.replace("s-",""), 16) % 10000)` |
| LLM Router | `8430` | Yes | OpenAI-compatible proxy |
| TensorZero | `3000` | Yes | Rust gateway |
| Web UI | `8420` | Yes | Vite dev server / production |
| Test conductor | `19199` | Offset | Avoids collision with real conductor |

---

## 16. Data Locations

| Path | Purpose |
|---|---|
| `~/.ark/ark.db` | SQLite database (WAL mode, 5s busy timeout). Includes knowledge graph tables, `resource_definitions`, `usage_records`, `api_keys` |
| `~/.ark/config.yaml` | User config (router, knowledge, tensorzero, compute templates, budgets, hotkeys, auth) |
| `~/.ark/tracks/<sessionId>/` | Launcher scripts, channel configs |
| `~/.ark/worktrees/<sessionId>/` | Git worktrees for isolated sessions |
| `~/.ark/skills/` | Global skill definitions (user tier for SkillStore) |
| `~/.ark/recipes/` | Global recipe definitions (user tier for RecipeStore) |
| `~/.ark/flows/` | Global flow definitions (user tier for FlowStore) |
| `~/.ark/agents/` | Global agent definitions (user tier for AgentStore) |
| `~/.ark/runtimes/` | Global runtime definitions (user tier for RuntimeStore) |
| `~/.ark/logs/` | Structured JSONL logs |
| `~/.claude/projects/` | Claude Code session transcripts (JSONL). Read by history + search + parser |
| `~/.codex/sessions/` | Codex CLI transcripts |
| `~/.gemini/tmp/` | Gemini CLI transcripts |
| `.claude/settings.local.json` | Per-session hook config (written at dispatch, cleaned on stop) |
| `.mcp.json` | Per-session MCP server config (includes `ark-channel`) |
| `.codegraph/graph.db` | ops-codegraph output, consumed by `indexer.ts` |
| `.ark/` | Project-tier resource overrides (flows, skills, agents, recipes, runtimes) |
| `.infra/` | Dockerfile, docker-compose, Helm chart |

In hosted mode, the `resource_definitions`, `sessions`, `knowledge`, `usage_records`, and `api_keys` tables live in Postgres instead of SQLite.

---

## 17. Key Architectural Decisions

- **Awilix DI over module-level `getApp()`.** Every service and orchestration function takes `app: AppContext` as its first argument. Eliminated 225 `getApp()` calls and made test isolation trivial (`AppContext.forTest()`).

- **`IDatabase` abstraction.** SQLite for local, Postgres for hosted, same repositories. No ORM. Raw SQL with column whitelists. Same code paths run in both modes.

- **Polymorphism over switch statements.** `TranscriptParserRegistry`, `ExecutorRegistry`, `ComputeProviderRegistry`, `DbResourceStore` vs `FileResourceStore` -- everything swappable via registration, not `if runtime === "claude"` branches.

- **ArkD as universal HTTP daemon.** Instead of per-provider SSH/exec logic, one HTTP daemon runs on every compute target. Conductor speaks HTTP. Local, docker, EC2, K8s, firecracker all look the same.

- **MCP socket pooling over per-session processes.** Shared MCP processes via Unix sockets give ~85-90% memory reduction at the cost of one small proxy binary.

- **Workdir/cwd-based session identification.** Transcript parsers match by exact workdir, not "latest by mtime." Parallel dispatches don't clobber each other's identification.

- **Tenant-scoped from day one.** Every entity has `tenant_id`. `forTenant(id)` is a cheap view that re-uses the same repositories and stores. No separate "tenant-aware" code path.

- **Conductor separate from CLI.** CLI talks to the DB directly via `AppContext`; only TUI and hosted mode run the conductor. Keeps short-lived CLI commands from racing HTTP server boot.

- **Channels through arkd, not direct.** Agent `->` arkd `->` conductor gives one HTTP endpoint per compute target. Scales to N sessions on one host without N open conductor connections.

- **ops-codegraph, not Axon.** Rust + tree-sitter, 33 languages, Bun FFI. Replaces the earlier Python-based indexing experiments. Auto-indexed remote by going through arkd.

- **Cost modes (`api`, `subscription`, `free`).** Subscription runtimes (Claude Max) still record tokens for rate limit tracking but bill zero. Universal cost tracking without special-casing subscription billing.
