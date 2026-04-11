# Ark Configuration Reference

## Overview

Ark uses several configuration files:

| File | Purpose | Managed by |
|------|---------|------------|
| `~/.ark/config.yaml` | Global user preferences | User |
| `~/.ark/bridge.json` | Messaging bridge credentials | User |
| `~/.ark/profiles.json` | Profile definitions | `ark profile` commands |
| `~/.ark/ui-state.json` | TUI state persistence | Auto-managed by TUI |
| `.ark.yaml` (repo root) | Per-repository defaults | User |
| `~/.ark/router.yaml` | LLM router configuration (optional) | User |

## Local vs Hosted Mode

Ark runs in one of two deployment modes and the scope of each config key depends on which mode is active.

| Aspect | Local (default) | Hosted control plane |
|--------|-----------------|----------------------|
| Entry point | `ark tui`, `ark cli`, `ark web` | `ark server start --hosted` |
| Database | SQLite at `~/.ark/ark.db` | PostgreSQL via `DATABASE_URL` |
| Stores (flows/agents/skills/recipes/runtimes) | File-backed, three-tier (builtin > `~/.ark/...` > `.ark/...`) | DB-backed `DbResourceStore`, tenant-scoped rows in `resource_definitions` |
| SSE bus | In-memory | Redis via `REDIS_URL` |
| Auth | None (single user, tenant = `"default"`) | API keys required (`auth.enabled: true`), roles: `admin`/`member`/`viewer` |
| Tenants | 1 | Many |
| Users | 1 | Many (tracked via `user_id` on sessions) |
| Scheduler | None | `WorkerRegistry` + `SessionScheduler` |
| Cost tracking | Session-level | Tenant + user + session |
| Config source | `~/.ark/config.yaml` | Env vars + per-tenant DB rows |
| Compute templates | `~/.ark/config.yaml` under `compute_templates:` | Per-tenant `compute_templates` table |

Unless noted otherwise, config keys in `~/.ark/config.yaml` apply to **both** modes. Hosted mode additionally reads env vars (`DATABASE_URL`, `REDIS_URL`, `ANTHROPIC_API_KEY`, ...) and tenant policy rows from the DB.

## ~/.ark/config.yaml

The main configuration file. Open it with `ark config` (creates a default if missing).

```yaml
# ── Hotkeys ─────────────────────────────────────────────────────────
# Remap any TUI keyboard shortcut. Keys map action names to key bindings.
# Set a value to null to disable the shortcut.
hotkeys:
  dispatch: Enter
  stop: s
  restart: r
  fork: f
  delete: x
  attach: a
  talk: t
  mcp: M
  move: m
  search: /
  newSession: n
  complete: d
  clone: C
  group: o
  inbox: T
  events: e
  filterRunning: "!"
  filterWaiting: "@"
  filterStopped: "#"
  filterFailed: "$"
  filterClear: "0"
  undo: ctrl+z
  markUnread: u
  skills: K
  memory: Y
  settings: P
  advance: A
  worktreeFinish: W
  interrupt: I
  verify: V
  archive: Z

# ── Budgets ─────────────────────────────────────────────────────────
# Spending limits in USD. Ark warns when approaching/exceeding limits.
budgets:
  dailyLimit: 50        # USD per day
  weeklyLimit: 200      # USD per week
  monthlyLimit: 500     # USD per month

# ── Theme ───────────────────────────────────────────────────────────
# Theme mode for the TUI. Options: dark, light, system
# "system" auto-detects macOS dark mode setting.
theme: dark

# ── Default Compute ────────────────────────────────────────────────
# Name of a provisioned compute resource to use by default.
# Also settable via ARK_DEFAULT_COMPUTE env var.
default_compute: null

# ── OTLP (OpenTelemetry Traces) ───────────────────────────────────
# Export session + stage spans to any OTLP/HTTP collector.
otlp:
  enabled: false
  endpoint: http://localhost:4318/v1/traces
  headers:
    Authorization: "Bearer ..."

# ── Rollback (Auto-Revert on CI Failure) ──────────────────────────
# Revert merged PRs when CI fails post-merge.
rollback:
  enabled: false
  timeout: 600        # seconds to wait for CI
  on_timeout: ignore  # rollback | ignore
  auto_merge: false   # auto-merge revert PR
  health_url: null    # optional custom health endpoint

# ── Notifications ─────────────────────────────────────────────────
# Enable/disable notifications for session events.
notifications: true

# ── Telemetry ─────────────────────────────────────────────────────
# Optional usage telemetry. Also enabled via ARK_TELEMETRY=1.
telemetry:
  enabled: false
  endpoint: null      # HTTP endpoint for telemetry events
```

### Hotkey Remapping

All TUI keyboard shortcuts can be remapped. The format is `action: key`.

Available actions and their defaults:

| Action | Default | Description |
|--------|---------|-------------|
| `dispatch` | `Enter` | Dispatch or restart a session |
| `stop` | `s` | Stop a running session |
| `restart` | `r` | Restart a session / open replay |
| `fork` | `f` | Fork (branch) a session |
| `delete` | `x` | Delete a session |
| `attach` | `a` | Attach to a running session |
| `talk` | `t` | Send a message to agent |
| `mcp` | `M` | Open MCP manager |
| `move` | `m` | Move session to a group |
| `search` | `/` | Open fuzzy search |
| `newSession` | `n` | Create a new session |
| `complete` | `d` | Mark session as done |
| `clone` | `C` | Clone a session |
| `group` | `o` | Open group manager |
| `inbox` | `T` | Open inbox / threads |
| `events` | `e` | Expand event log |
| `filterRunning` | `!` | Filter to running sessions |
| `filterWaiting` | `@` | Filter to waiting sessions |
| `filterStopped` | `#` | Filter to stopped sessions |
| `filterFailed` | `$` | Filter to failed sessions |
| `filterClear` | `0` | Clear status filter |
| `undo` | `ctrl+z` | Undo last delete |
| `markUnread` | `u` | Mark session as unread |
| `skills` | `K` | Open skills manager |
| `settings` | `P` | Open settings |
| `advance` | `A` | Advance session to next flow stage |
| `worktreeFinish` | `W` | Finish worktree (merge branch and clean up) |
| `interrupt` | `I` | Interrupt running agent |
| `verify` | `V` | Run verification |
| `archive` | `Z` | Archive/restore session |

To disable a shortcut, set it to `null`:

```yaml
hotkeys:
  clone: null       # Disable the clone shortcut
  fork: F           # Remap fork to uppercase F
  undo: ctrl+z      # Ctrl+ prefix for modifier keys
```

### Budget Configuration

Set spending limits to prevent runaway costs:

```yaml
budgets:
  dailyLimit: 50
  weeklyLimit: 200
  monthlyLimit: 500
```

All values are in USD. Omit a field to have no limit for that period. When a limit is approached or exceeded, Ark displays a warning before dispatching new sessions.

Budget tracking uses token usage data collected from completed sessions.

### OTLP (OpenTelemetry Traces)

Export session and stage spans as OpenTelemetry traces.

```yaml
otlp:
  enabled: true
  endpoint: http://localhost:4318/v1/traces
  headers:
    Authorization: "Bearer ..."
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable OTLP trace export |
| `endpoint` | string | -- | HTTP endpoint for OTLP/HTTP JSON traces |
| `headers` | object | -- | Optional headers (e.g. auth tokens) sent with each request |

When enabled, Ark emits one trace per session with child spans for each flow stage. Spans include session ID, agent, stage name, and duration. Compatible with any OTLP/HTTP collector (Jaeger, Grafana Tempo, Honeycomb, etc.).

### Rollback (Auto-Revert on CI Failure)

Automatically revert merged PRs when CI fails after merge.

```yaml
rollback:
  enabled: false
  timeout: 600        # seconds to wait for CI
  on_timeout: ignore  # rollback | ignore
  auto_merge: false   # auto-merge the revert PR
  health_url: null    # optional custom health endpoint
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable auto-rollback pipeline |
| `timeout` | number | `600` | Seconds to wait for CI check suites to complete |
| `on_timeout` | `"rollback"` \| `"ignore"` | `"ignore"` | Action when CI times out |
| `auto_merge` | boolean | `false` | Automatically merge the generated revert PR |
| `health_url` | string \| null | `null` | Optional URL to poll after merge (returns non-2xx = failure) |

When a session's PR is merged, the conductor receives a GitHub webhook at `POST /hooks/github/merge`. It polls CI check suites for the merge commit. If any check fails (or the health URL returns non-2xx), Ark creates a revert PR. If `auto_merge` is true, the revert PR is merged automatically.

### Telemetry

Optional anonymous usage telemetry.

```yaml
telemetry:
  enabled: false
  endpoint: null      # HTTP endpoint for telemetry events
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable telemetry event collection |
| `endpoint` | string \| null | `null` | HTTP endpoint to POST telemetry events to |

Disabled by default. Can also be enabled via the `ARK_TELEMETRY=1` environment variable. Events are buffered and flushed periodically or at shutdown.

### Default Compute

Set a default compute resource for new sessions.

```yaml
default_compute: my-ec2
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `default_compute` | string \| null | `null` | Name of the compute resource to use by default |

Can also be set via the `ARK_DEFAULT_COMPUTE` environment variable. CLI flags and per-repo `.ark.yaml` `compute` field override this value.

### Notifications

```yaml
notifications: true    # Enable/disable desktop notifications (default: not set)
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `notifications` | boolean | -- | Enable or disable notifications for session events |

### Theme Configuration

```yaml
theme: dark      # Options: dark, light, system
```

- `dark`: dark color scheme (default)
- `light`: light color scheme
- `system`: auto-detect from macOS system appearance

The dark theme uses Tokyo Night colors. The light theme is adapted for light terminal backgrounds.

Theme colors:

| Element | Dark | Light |
|---------|------|-------|
| Accent | `#7aa2f7` | `#2e7de9` |
| Running | `#9ece6a` | `#587539` |
| Waiting | `#e0af68` | `#8c6c3e` |
| Error | `#f7768e` | `#f52a65` |
| Idle | `#787fa0` | `#6172b0` |
| Surface | `#24283b` | `#e1e2e7` |
| Text | `#c0caf5` | `#3760bf` |
| Dim text | `#565f89` | `#8990b3` |

### Router Configuration

Configure the LLM router (used by `ark router start`, the TUI, and hosted mode).

```yaml
router:
  enabled: false
  url: http://localhost:8430
  port: 8430
  policy: balanced     # quality | balanced | cost
  auto_start: false
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable LLM router for this Ark instance |
| `url` | string | `http://localhost:8430` | Base URL that executors should target |
| `port` | number | `8430` | Router listen port (used when auto-starting) |
| `policy` | string | `balanced` | Default routing policy: `quality`, `balanced`, or `cost` |
| `auto_start` | boolean | `false` | Start the router automatically on Ark boot (TUI, CLI, or control plane) |

Providers are auto-detected from environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`). Advanced provider configuration can be placed in `~/.ark/router.yaml`.

**URL injection into executors.** When `router.enabled` is true, the claude-code and cli-agent executors transparently set the appropriate base URL env var on agent processes:

- `ANTHROPIC_BASE_URL` for Claude Code (`claude`, `claude-max` runtimes)
- `OPENAI_BASE_URL` for Codex and any OpenAI-compatible runtime

Agents call the router instead of the provider directly. The router records usage via an `onUsage` callback that writes into the `usage_records` table, respecting each runtime's `cost_mode` (`api`, `subscription`, `free`).

### TensorZero Gateway

TensorZero is an optional Rust-based OpenAI-compatible gateway (Apache 2.0) that the router can delegate to. Enable it to get production-grade circuit breakers, per-request fallbacks, and observability in front of your model providers.

```yaml
tensorZero:
  enabled: false
  port: 3000
  config_dir: ~/.ark/tensorzero
  auto_start: false
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable TensorZero as the router's backend |
| `port` | number | `3000` | Port to bind the gateway to (used on auto-start) |
| `config_dir` | string | `~/.ark/tensorzero` | Directory for the generated `tensorzero.toml` and any model configs |
| `auto_start` | boolean | `false` | Launch TensorZero at boot when `router.auto_start` is also true |

At boot, the TensorZero lifecycle manager (`packages/core/router/tensorzero.ts`) tries three strategies in order:

1. **Sidecar detect** -- probe `http://localhost:<port>/health`; if it responds, reuse it.
2. **Native binary** -- launch the `tensorzero` Rust binary if it is on `PATH`.
3. **Docker fallback** -- run the official TensorZero image via Docker.

The `tensorzero.toml` config is generated on the fly from the provider API keys in your environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`), so you normally don't need to touch `config_dir` unless you want to pin custom model families.

### Auth Configuration

Configure multi-tenant authentication. Required for hosted mode, optional for local mode.

```yaml
auth:
  enabled: false
  apiKeyEnabled: false
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable auth middleware |
| `apiKeyEnabled` | boolean | `false` | Enable API key validation for all requests |

When auth is disabled (the default for local use), all requests get the `"default"` tenant context with `admin` role and everything behaves as a single-user install.

When auth is enabled, the control plane expects an API key on every incoming request.

**API key format:** `ark_<tenantId>_<secret>`

The key encodes its tenant ID in the middle segment so the middleware can route it without a DB lookup; the `<secret>` is the only part that is hashed in the database. Keys are managed via `ark auth create-key`, `ark auth list-keys`, `ark auth revoke-key`, and `ark auth rotate-key`.

**Roles:**

| Role | Description |
|------|-------------|
| `admin` | Full tenant control -- sessions, compute, policies, keys, billing |
| `member` | Create and operate sessions and compute; cannot manage tenant policy or other users' keys |
| `viewer` | Read-only: list sessions, view events, watch logs; no mutations |

Roles are assigned per API key and checked at the JSON-RPC handler layer.

**Tenant scoping.** Every tenant-owned entity carries a `tenant_id` column: sessions, compute, events, messages, todos, groups, schedules, compute_pools, compute_templates, usage_records, resource_definitions, knowledge, knowledge_edges. `AppContext.forTenant(tenantId)` returns a tenant-scoped view that rewrites queries with the tenant id -- no handler needs to remember to filter manually.

### Tenant Policies

Hosted mode enforces per-tenant policies via the `TenantPolicyManager`. Policies live in the DB (one row per tenant) and are edited with `ark tenant policy set`.

```bash
ark tenant policy set acme \
  --providers k8s,e2b,ec2 \
  --default-provider k8s \
  --max-sessions 20 \
  --max-cost 100
```

| Field | Type | Description |
|-------|------|-------------|
| `allowed_providers` | string[] | Compute providers this tenant may use |
| `default_provider` | string | Provider to use when a session does not specify one |
| `max_sessions` | number | Maximum concurrent sessions for the tenant |
| `max_cost_per_day` | number | Daily USD cap (enforced against `usage_records`) |
| `compute_pools` | string[] | Compute pools the tenant is allowed to schedule into |
| `router_required` | boolean | Force all traffic through the LLM router (block direct provider env vars) |
| `auto_index_required` | boolean | Force `knowledge.auto_index: true` regardless of user config |
| `router_policy` | string | Lock the router policy (`quality`, `balanced`, or `cost`) for this tenant |
| `tensorzero_enabled` | boolean | Force TensorZero backend on for this tenant |

The `router_required`, `auto_index_required`, `router_policy`, and `tensorzero_enabled` fields are integration enforcement flags: the scheduler refuses to dispatch a session whose runtime/config would bypass them.

### Knowledge Graph

Configure the codebase indexer and the unified knowledge graph.

```yaml
knowledge:
  auto_index: true        # run the indexer automatically at session dispatch
  incremental_index: true # only re-index files changed since last run
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `auto_index` | boolean | `true` | Index the repo automatically when a session is dispatched |
| `incremental_index` | boolean | `true` | Skip files whose mtime is older than the last index run |

**Auto-index behavior:**

- **Local compute** honors the `auto_index` flag. Set it to `false` to skip indexing and shave a second or two off dispatch.
- **Remote compute** (Docker, EC2, K8s, Firecracker, E2B) **always** indexes via `POST /codegraph/index` on the remote arkd daemon, regardless of config. The conductor ships the results back over HTTP into Ark's tenant-scoped `knowledge` + `knowledge_edges` tables. This guarantees every dispatched session has a fresh graph even when the operator disabled local indexing.

**Indexer backend:** Ark uses [ops-codegraph](https://www.npmjs.com/package/@optave/codegraph) (`@optave/codegraph`) -- a TypeScript + Rust native indexer that parses 33 languages via tree-sitter WASM. No Python dependency. Install with:

```bash
bun add @optave/codegraph        # per-project
npm install -g @optave/codegraph # system-wide
```

The indexer runs `codegraph build` in the repo, reads the resulting `.codegraph/graph.db`, and streams nodes + edges into the knowledge store.

### MCP Socket Pooling

Shared MCP server processes across sessions. Without pooling each session spawns its own copy of every MCP server (knowledge-graph, filesystem, context7, playwright, ...); with N sessions and M MCP servers that is N*M processes, which blows up memory fast. Pooling runs one MCP process per server and multiplexes all sessions through a Unix domain socket.

```yaml
mcp_pool:
  enabled: false
  autoStart: true
  poolAll: false
  excludeMcps: []
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Turn pooling on |
| `autoStart` | boolean | `true` | Start the pool at Ark boot when `enabled` is true |
| `poolAll` | boolean | `false` | Pool every MCP server found across session configs. When `false`, only servers explicitly wired through `ark mcp-proxy` are pooled |
| `excludeMcps` | string[] | `[]` | Names of MCP servers to keep as per-session processes (e.g., servers with per-session state) |

When pooling is enabled, each pooled server exposes a socket at `/tmp/ark-mcp-<name>.sock`. Sessions reference it via `{"command": "ark", "args": ["mcp-proxy", "/tmp/ark-mcp-<name>.sock"]}` in their `.mcp.json`. A `SocketProxy` wraps the single MCP process and accepts multi-client connections; the pool also monitors health and auto-restarts dead servers. In practice this cuts MCP memory by ~85-90%.

### Compute Templates

Named presets for `ark compute create --from-template <name>`. Define reusable provider configurations in `~/.ark/config.yaml`:

```yaml
compute_templates:
  gpu-large:
    provider: ec2
    config:
      size: xxl
      region: us-west-2
      arch: x64
  sandbox:
    provider: docker
    config:
      image: node:20
  isolated:
    provider: ec2-firecracker
    config:
      size: l
      region: us-east-1
  k8s-pool:
    provider: k8s-kata
    config:
      namespace: ark-workers
```

| Field | Type | Description |
|-------|------|-------------|
| `<name>` | object | Template name -- used as `--from-template <name>` |
| `<name>.provider` | string | Provider type (same list as `ark compute create`): `local`, `docker`, `devcontainer`, `firecracker`, `ec2`, `ec2-docker`, `ec2-devcontainer`, `ec2-firecracker`, `e2b`, `k8s`, `k8s-kata` |
| `<name>.config` | object | Provider-specific config dict merged into the resulting compute |

In hosted mode, templates live in the `compute_templates` DB table (tenant-scoped) and are created via `ark compute template create`. In local mode they can be edited directly in `~/.ark/config.yaml` or managed via the same CLI.

### Database Configuration

```yaml
database_url: null    # PostgreSQL connection URL for hosted mode
redis_url: null       # Redis URL for SSE bus (multi-instance deployments)
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `database_url` | string \| null | `null` | PostgreSQL connection string. When null, uses SQLite at `~/.ark/ark.db` |
| `redis_url` | string \| null | `null` | Redis connection string for SSE bus. When null, uses in-memory bus |

Can also be set via `DATABASE_URL` and `REDIS_URL` environment variables.

### Channels

Every Ark session spawns an ark-channel MCP server over stdio (see `ark channel` in the CLI reference). Each channel opens an HTTP port for inbound traffic using a deterministic offset from the session id:

```
channel_port = 19200 + (hash(sessionId) % 10000)
```

So the port is stable across restarts and two live sessions almost never collide. The channel reports flow agent -> ark-channel (stdio) -> arkd HTTP (`:19300`) -> conductor HTTP (`:19100`). Port 19100 (conductor) is hardcoded; port 19300 (arkd) is the default and can be overridden with `ARK_ARKD_PORT` / `ARK_ARKD_URL`; the per-session channel port is computed and cannot be overridden.

---

## ~/.ark/bridge.json

Configuration for messaging bridges (Telegram, Slack, Discord). All fields are optional -- only configure the platforms you want to use.

```json
{
  "telegram": {
    "botToken": "123456789:AABBccDDeeFFggHHiiJJ",
    "chatId": "12345678"
  },
  "slack": {
    "webhookUrl": "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXX"
  },
  "discord": {
    "webhookUrl": "https://discord.com/api/webhooks/1234567890/abcdef..."
  }
}
```

### Telegram

| Field | Description |
|-------|-------------|
| `botToken` | Bot token from [@BotFather](https://t.me/BotFather) |
| `chatId` | Chat ID to send notifications to |

### Slack

| Field | Description |
|-------|-------------|
| `webhookUrl` | Incoming Webhook URL from your Slack workspace |

### Discord

| Field | Description |
|-------|-------------|
| `webhookUrl` | Webhook URL from your Discord channel settings |

---

## ~/.ark/profiles.json

Managed by `ark profile` commands. Do not edit directly.

```json
[
  {
    "name": "default",
    "createdAt": "2025-01-01T00:00:00.000Z"
  },
  {
    "name": "work",
    "description": "Work projects",
    "createdAt": "2025-01-15T10:30:00.000Z"
  }
]
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Profile name (used with `ark -p <name>`) |
| `description` | string? | Optional description |
| `config` | object? | Optional per-profile configuration |
| `createdAt` | string | ISO timestamp |

---

## ~/.ark/ui-state.json

Auto-managed by the TUI. Persists cursor position, active tab, and scroll state across restarts.

```json
{
  "activeTab": 0,
  "selectedSessionId": "s-a1b2c3",
  "scrollOffset": 5,
  "statusFilter": null,
  "previewMode": null
}
```

| Field | Type | Description |
|-------|------|-------------|
| `activeTab` | number | Active tab index (0-6) |
| `selectedSessionId` | string? | Currently selected session |
| `scrollOffset` | number | Scroll position in session list |
| `statusFilter` | string? | Active status filter |
| `previewMode` | string? | Active preview mode |

Do not edit this file manually -- it is overwritten on every TUI state change.

---

## .ark.yaml (Per-Repository)

Place in your repository root. Ark reads it when starting sessions in that repo. Recognized file names (in priority order):

1. `.ark.yaml`
2. `.ark.yml`
3. `ark.yaml`

```yaml
# Default flow for sessions in this repo
flow: quick

# Default group name
group: my-team

# Default compute resource
compute: my-ec2

# Default agent
agent: implementer

# Environment variables passed to agents
env:
  CUSTOM_VAR: "value"
  DB_HOST: "localhost"

# Verification scripts for all stages (overridden by flow-level verify)
verify:
  - "npm test"
  - "npm run lint"

# Auto-create PR on agent completion (default: true for repos with remotes)
auto_pr: true
```

| Field | Type | Description |
|-------|------|-------------|
| `flow` | string | Default flow name |
| `group` | string | Default group name |
| `compute` | string | Default compute resource |
| `agent` | string | Default agent name |
| `env` | object | Environment variables for agents |
| `verify` | string[] | Verification scripts run before stage completion |
| `auto_pr` | boolean | Auto-create PR on agent completion (default: true for repos with remotes) |

CLI flags always override `.ark.yaml` defaults. For example:

```bash
# Uses flow from .ark.yaml
ark session start --repo .

# Overrides flow to "bare"
ark session start --repo . --flow bare
```

---

## Agent YAML

Agent definitions live in `agents/<name>.yaml` (builtin), `.ark/agents/<name>.yaml` (project), or `~/.ark/agents/<name>.yaml` (global). Create or edit with `ark agent create` / `ark agent edit`.

```yaml
name: my-agent
description: What it does
model: opus            # opus | sonnet | haiku
max_turns: 200
system_prompt: |
  Working on {repo}. Task: {summary}. Ticket: {ticket}.
tools: [Bash, Read, Write, Edit, Glob, Grep, WebSearch]
permission_mode: bypassPermissions
skills: [code-review]  # optional - skill names injected into system prompt
env:
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80"
runtime:               # optional - executor system configuration
  type: docker         # local | docker | devcontainer | firecracker
  image: node:20       # Docker image (docker/devcontainer types)
```

### Agent Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Agent identifier (matches filename) |
| `description` | string | Short description shown in `ark agent list` |
| `model` | string | Model alias: `opus`, `sonnet`, `haiku`, or tool-specific (e.g., `o4-mini`) |
| `max_turns` | number | Maximum conversation turns before stopping |
| `system_prompt` | string | System prompt. Supports `{ticket}`, `{summary}`, `{workdir}`, `{repo}`, `{branch}` template variables |
| `tools` | string[] | Allowed Claude tools |
| `permission_mode` | string | Claude permission mode (e.g. `bypassPermissions`) |
| `mcp_servers` | string[] | MCP server names to attach to the agent |
| `skills` | string[] | Skill names to inject into the system prompt |
| `memories` | string[] | Memory categories recalled and injected at dispatch |
| `context` | string[] | Files included as context at dispatch (e.g., `CLAUDE.md`, `PLAN.md`) |
| `env` | object | Environment variables exported before agent launch |
| `runtime` | object | Executor system configuration (see below) |
| `command` | string[] | Command for `cli-agent` and `subprocess` runtimes |
| `task_delivery` | string | How task is sent to CLI agents: `stdin`, `file`, or `arg` (default) |

See the [Agents Reference](agents-reference.md) for detailed documentation of all builtin agents.

### Runtime YAML

Runtime definitions live in `runtimes/<name>.yaml` (builtin), `.ark/runtimes/<name>.yaml` (project), or `~/.ark/runtimes/<name>.yaml` (global). Built-in runtimes: `claude`, `claude-max`, `codex`, `gemini`.

```yaml
name: my-runtime
description: "Custom LLM backend"
type: cli-agent        # claude-code | cli-agent | subprocess
command: ["my-tool", "--auto"]
task_delivery: arg     # stdin | file | arg
models:
  - id: default
    label: "Default Model"
default_model: default
billing:
  mode: api            # api | subscription | free
  transcript_parser: claude
env:
  CUSTOM_VAR: "value"
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Runtime identifier (matches filename) |
| `description` | string | Short description |
| `type` | string | Executor type: `claude-code`, `cli-agent`, or `subprocess` |
| `command` | string[] | Command to run (for cli-agent and subprocess) |
| `task_delivery` | string | How task is sent: `stdin`, `file`, or `arg` (default) |
| `models` | object[] | Available models with id and label |
| `default_model` | string | Default model id |
| `permission_mode` | string | Permission mode override |
| `env` | object | Environment variables |
| `billing` | object | Billing + cost tracking config (see below) |

CLI: `ark runtime list`, `ark runtime show <name>`.

At dispatch, runtime config is merged with agent config. The `--runtime` flag on `ark session start` overrides the agent's default runtime.

#### Billing Section

Every runtime declares a `billing` block that tells the `UsageRecorder` how to account for its token usage. Each row in the `usage_records` table carries a `cost_mode` column that mirrors the runtime's billing mode.

```yaml
# runtimes/claude.yaml (API billing)
billing:
  mode: api
  transcript_parser: claude
```

```yaml
# runtimes/claude-max.yaml (Claude Max subscription, $200/mo)
billing:
  mode: subscription
  plan: claude-max
  cost_per_month: 200
  transcript_parser: claude
```

```yaml
# runtimes/codex.yaml
billing:
  mode: api
  transcript_parser: codex
```

```yaml
# runtimes/gemini.yaml
billing:
  mode: api
  transcript_parser: gemini
```

| Field | Type | Description |
|-------|------|-------------|
| `mode` | string | `api`, `subscription`, or `free`. Controls how `cost_usd` is computed per turn |
| `plan` | string | Human-readable plan label (e.g., `claude-max`, `openai-plus`) |
| `cost_per_month` | number | Fixed monthly price for subscription plans (used for amortization reports) |
| `transcript_parser` | string | Which `TranscriptParserRegistry` backend to use: `claude`, `codex`, or `gemini` |

**Cost modes:**

| Mode | `cost_usd` on each row | Tokens recorded | Example runtimes |
|------|------------------------|-----------------|------------------|
| `api` | Per-token from `PricingRegistry` (300+ models via LiteLLM JSON) | Yes | `claude`, `codex`, `gemini` |
| `subscription` | `0` (fixed monthly, amortized separately) | Yes (for rate-limit tracking) | `claude-max` |
| `free` | `0` | Yes | Local or zero-cost runtimes |

The transcript parser is picked polymorphically via the `TranscriptParserRegistry`:

- `ClaudeTranscriptParser` reads `~/.claude/projects/<slug>/<sessionId>.jsonl` (exact path from session id)
- `CodexTranscriptParser` reads `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (matched by cwd)
- `GeminiTranscriptParser` reads `~/.gemini/tmp/<projectHash>/chats/session-*.jsonl`

`ark costs-sync` uses the same registry for backfills.

### runtime Field (in Agent YAML)

The `runtime` field controls which executor launches the agent process.

```yaml
runtime:
  type: docker         # local | docker | devcontainer | firecracker
  image: node:20       # Docker image (docker and devcontainer types)
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | string | `local` | Executor type: `local`, `docker`, `devcontainer`, or `firecracker` |
| `image` | string | -- | Docker image to use (required for `docker` and `devcontainer` types) |

When `runtime` is omitted the agent runs in the local environment (same machine, same shell). Use `docker` to isolate the agent in a container, `devcontainer` to run inside the repo's `.devcontainer` config, or `firecracker` for micro-VM isolation.

---

## Data Locations

| Path | Purpose |
|------|---------|
| `~/.ark/ark.db` | SQLite database (WAL mode, 10s busy timeout) |
| `~/.ark/config.yaml` | User configuration |
| `~/.ark/bridge.json` | Messaging bridge credentials |
| `~/.ark/profiles.json` | Profile definitions |
| `~/.ark/ui-state.json` | TUI state persistence |
| `~/.ark/claude-oauth-token` | Saved OAuth token from `ark auth` |
| `~/.ark/tracks/<sessionId>/` | Launcher scripts, channel configs per session |
| `~/.ark/worktrees/<sessionId>/` | Git worktrees for isolated sessions |
| `~/.ark/skills/` | Global skill definitions |
| `~/.ark/recipes/` | Global recipe definitions |
| `~/.ark/agents/` | Global agent definitions |
| `~/.ark/flows/` | Global flow definitions |
| `~/.ark/runtimes/` | Global runtime definitions |
| `~/.ark/tensorzero/` | Generated TensorZero config (when enabled) |
| `~/.ark/logs/` | Log files |
| `~/.ark/conductor/` | Conductor learnings and policies |
| `~/.claude/projects/` | Claude Code session transcripts (read by search/import) |

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ARK_CONDUCTOR_PORT` | `19100` | Conductor HTTP server port |
| `ARK_CONDUCTOR_URL` | `http://localhost:19100` | Conductor URL (fallback if arkd unavailable) |
| `ARK_ARKD_URL` | `http://localhost:19300` | ArkD URL -- channel reports go here first |
| `ARK_ARKD_PORT` | `19300` | ArkD daemon port |
| `ARK_ARKD_TOKEN` | -- | Optional bearer token for authenticating against ArkD |
| `ARK_CHANNEL_PORT` | auto-assigned | Per-session MCP channel port (`19200 + (hash(sessionId) % 10000)`) |
| `ARK_SESSION_ID` | -- | Set in channel context |
| `ARK_STAGE` | -- | Current flow stage in channel |
| `ARK_SERVER` | -- | Remote Ark server URL (enables remote client mode) |
| `ARK_TOKEN` | -- | API key for remote server authentication |
| `ARK_PROFILE` | `default` | Active profile name |
| `ARK_DEFAULT_COMPUTE` | -- | Default compute resource name for new sessions |
| `ARK_TELEMETRY` | -- | Set to `1` to enable telemetry (overrides config) |
| `ARK_TEST_DIR` | -- | Temp directory for test isolation (development only) |
| `DATABASE_URL` | -- | PostgreSQL connection URL (hosted mode; defaults to SQLite) |
| `REDIS_URL` | -- | Redis URL for SSE bus (hosted mode; defaults to in-memory) |
| `ANTHROPIC_API_KEY` | -- | API key for Anthropic (LLM router) |
| `OPENAI_API_KEY` | -- | API key for OpenAI (LLM router) |
| `GOOGLE_API_KEY` | -- | API key for Google (LLM router) |
| `E2B_API_KEY` | -- | API key for E2B compute provider |
| `EDITOR` | `vi` | Editor for `ark config` and `ark agent create/edit` |
