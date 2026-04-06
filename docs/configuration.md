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
```

| Field | Type | Description |
|-------|------|-------------|
| `flow` | string | Default flow name |
| `group` | string | Default group name |
| `compute` | string | Default compute resource |
| `agent` | string | Default agent name |
| `env` | object | Environment variables for agents |

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
| `model` | string | Model alias: `opus`, `sonnet`, or `haiku` |
| `max_turns` | number | Maximum conversation turns before stopping |
| `system_prompt` | string | System prompt. Supports `{ticket}`, `{summary}`, `{workdir}`, `{repo}`, `{branch}` template variables |
| `tools` | string[] | Allowed Claude tools |
| `permission_mode` | string | Claude permission mode (e.g. `bypassPermissions`) |
| `skills` | string[] | Skill names to inject into the system prompt |
| `env` | object | Environment variables exported before agent launch |
| `runtime` | object | Executor system configuration (see below) |

### runtime Field

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
| `ARK_CHANNEL_PORT` | auto-assigned | Per-session MCP channel port |
| `ARK_SESSION_ID` | -- | Set in channel context |
| `ARK_STAGE` | -- | Current flow stage in channel |
| `ARK_PROFILE` | `default` | Active profile name |
| `ARK_DEFAULT_COMPUTE` | -- | Default compute resource name for new sessions |
| `ARK_TELEMETRY` | -- | Set to `1` to enable telemetry (overrides config) |
| `ARK_TEST_DIR` | -- | Temp directory for test isolation (development only) |
| `EDITOR` | `vi` | Editor for `ark config` and `ark agent create/edit` |
