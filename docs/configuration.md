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
| `ARK_TEST_DIR` | -- | Temp directory for test isolation (development only) |
| `EDITOR` | `vi` | Editor for `ark config` and `ark agent create/edit` |
