# Ark User Guide

## Getting Started

### Installation

Ark requires [Bun](https://bun.sh), [tmux](https://github.com/tmux/tmux), and the [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli).

```bash
# Install Bun (if not already installed)
curl -fsSL https://bun.sh/install | bash

# Install tmux (macOS)
brew install tmux

# Clone and install Ark
git clone https://github.com/your-org/ark.git
cd ark
make install
```

This installs dependencies and symlinks `ark` to `/usr/local/bin` so it is available system-wide.

### First Session

Create a session and dispatch an agent in one command:

```bash
ark session start --repo . --summary "Add user authentication" --dispatch
```

This creates a session record, resolves the flow and agent, and spawns a Claude agent in a tmux session. The agent works autonomously until the flow stage completes.

To attach to the running agent and watch it work:

```bash
ark session start --repo . --summary "Add user auth" --dispatch --attach
```

### Launching the TUI

```bash
ark tui
```

The terminal dashboard gives you a full-screen view of sessions, agents, tools, flows, history, compute resources, and costs. See the [TUI Reference](tui-reference.md) for all keyboard shortcuts.

### Launching the Web Dashboard

```bash
ark web
```

Opens a web dashboard at `http://localhost:8420` with session management, cost tracking, and live updates via SSE.

---

## Sessions

Sessions are the core unit of work in Ark. Each session tracks a task through one or more flow stages, with an assigned agent working in an isolated environment.

### Creating Sessions

```bash
# Basic session
ark session start --repo . --summary "Fix login bug"

# With a specific flow
ark session start --repo . --summary "Add API endpoints" --flow quick

# From a recipe template
ark session start --recipe quick-fix --repo . --dispatch

# From an existing Claude Code session
ark session start --claude-session abc123 --flow bare
```

### Dispatching Agents

Dispatching launches the assigned agent for the current flow stage:

```bash
# Dispatch separately
ark session dispatch s-a1b2c3

# Or dispatch on creation
ark session start --repo . --summary "Task" --dispatch
```

When dispatched, Ark:
1. Resolves the agent definition for the current stage
2. Builds the task prompt with context (PLAN.md, git log, prior stages)
3. Generates a launcher script at `~/.ark/tracks/<sessionId>/`
4. Spawns a tmux session running the agent
5. The agent connects back to the conductor for status reporting

### Stopping and Resuming

```bash
ark session stop s-a1b2c3      # Stop a running session
ark session resume s-a1b2c3    # Resume a stopped session
ark session pause s-a1b2c3 --reason "Waiting for review"
```

### Forking (Conversation Branching)

Fork creates a copy of a session with its own identity, useful for exploring alternative approaches:

```bash
ark session fork s-a1b2c3 --task "Try approach B" --dispatch
```

For parallel decomposition (parent waits for children):

```bash
ark session spawn s-parent "Subtask 1"
ark session spawn s-parent "Subtask 2"
ark session join s-parent          # Wait for all children
```

### Deleting with Undo

Deletion is soft by default with a 90-second undo window:

```bash
ark session delete s-a1b2c3
# Output: Session deleted (undo available for 90s)

ark session undelete s-a1b2c3    # Restore within 90s
```

In the TUI, press `x` to delete, then `Ctrl+Z` to undo.

### Session Output

View what the agent is currently doing:

```bash
ark session output s-a1b2c3           # Last 30 lines
ark session output s-a1b2c3 -n 100    # Last 100 lines
```

### Sending Messages

Send a message to a running agent:

```bash
ark session send s-a1b2c3 "Focus on the API layer first"
```

### Session Sharing (Export/Import)

```bash
ark session export s-a1b2c3 session-backup.json
ark session import session-backup.json
```

### Session Groups

Organize sessions into named groups:

```bash
ark session group s-a1b2c3 backend
ark session list --group backend
```

---

## TUI Dashboard

Launch with `ark tui`. The dashboard has 7 tabs, switched with number keys `1`-`7`:

| # | Tab | Purpose |
|---|-----|---------|
| 1 | Sessions | Session list, detail pane, dispatch/stop/fork |
| 2 | Agents | Browse and manage agent definitions |
| 3 | Tools | MCP Servers, Commands, Skills, Recipes, Context |
| 4 | Flows | Flow definitions and stage visualization |
| 5 | History | Claude Code session discovery and import |
| 6 | Compute | Compute resource lifecycle management |
| 7 | Costs | Token usage and cost tracking |

### Session List Navigation

| Key | Action |
|-----|--------|
| `j/k` | Move up/down |
| `g/G` | Jump to top/bottom |
| `f/b` | Page forward/back |
| `Tab` | Toggle between list and detail pane |

### Status Filters

Quickly filter the session list by status:

| Key | Filter |
|-----|--------|
| `!` | Running sessions only |
| `@` | Waiting sessions only |
| `#` | Stopped sessions only |
| `$` | Failed sessions only |
| `0` | Clear filter (show all) |

### Fuzzy Search

Press `/` to open fuzzy search. Type to filter sessions by name, summary, or ID. Use `Ctrl+j/k` to navigate results, `Enter` to select, `Esc` to cancel.

### MCP Manager

Press `M` on any session to open the MCP server manager. Toggle servers on/off with `Space`, apply with `Enter`.

### Fork Sessions

Press `f` on any session to fork it. Enter a task description for the forked session.

### Session Replay

Press `r` on a completed/stopped/failed session to open the replay view. Step through the session timeline event by event with `j/k`.

See the [TUI Reference](tui-reference.md) for the complete keyboard shortcut table.

---

## Web Dashboard

### Starting

```bash
ark web                              # Default: http://localhost:8420
ark web --port 9000                  # Custom port
ark web --read-only                  # No mutations allowed
ark web --token my-secret-token      # Require Bearer token auth
```

### Features

- **Session management**: create, dispatch, stop, restart, delete sessions
- **Cost tracking**: per-session and aggregate cost display
- **System status**: conductor health, active sessions count
- **SSE live updates**: real-time session status changes pushed to the browser
- **Token auth**: protect the dashboard with a Bearer token
- **Read-only mode**: view sessions without mutation capability

---

## Cost Tracking

Ark automatically collects token usage from Claude sessions and calculates costs using per-model pricing.

### Pricing (per million tokens)

| Model | Input | Output | Cache Read | Cache Write |
|-------|-------|--------|------------|-------------|
| Opus | $15.00 | $75.00 | $1.50 | $18.75 |
| Sonnet | $3.00 | $15.00 | $0.30 | $3.75 |
| Haiku | $0.80 | $4.00 | $0.08 | $1.00 |

### CLI Cost Summary

```bash
ark costs                # Show cost summary across all sessions
ark costs --limit 50     # Show more sessions
```

### Cost Budgets

Set spending limits in `~/.ark/config.yaml`:

```yaml
budgets:
  dailyLimit: 50       # USD per day
  weeklyLimit: 200     # USD per week
  monthlyLimit: 500    # USD per month
```

When a budget limit is approached or exceeded, Ark warns before dispatching.

### TUI Costs Tab

Press `7` in the TUI to view the Costs tab, which shows per-session cost breakdown and aggregate totals.

---

## Flows & Agents

### Agent Definitions

Agents are defined in YAML files with three-tier resolution:
1. **Project**: `.ark/agents/<name>.yaml` in the repo
2. **Global**: `~/.ark/agents/<name>.yaml`
3. **Builtin**: `agents/<name>.yaml` shipped with Ark

```yaml
# agents/my-agent.yaml
name: my-agent
description: What this agent does
model: opus          # opus | sonnet | haiku
max_turns: 200
system_prompt: |
  You are working on {repo}. Task: {summary}
  Ticket: {ticket}. Branch: {branch}
tools: [Bash, Read, Write, Edit, Glob, Grep, WebSearch]
mcp_servers: []
skills: [code-review]
memories: []
permission_mode: bypassPermissions
env:
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80"
```

Template variables `{ticket}`, `{summary}`, `{workdir}`, `{repo}`, and `{branch}` are substituted at dispatch time.

### Builtin Agents

| Agent | Model | Purpose |
|-------|-------|---------|
| `planner` | Sonnet | Creates PLAN.md with architecture and implementation strategy |
| `implementer` | Opus | Writes code, tests, and commits |
| `reviewer` | Sonnet | Reviews PRs and produces structured JSON feedback (P0-P3) |
| `documenter` | Sonnet | Generates project documentation |
| `worker` | Opus | General-purpose lightweight agent |

### Managing Agents

```bash
ark agent list                    # List all agents (builtin + custom)
ark agent show implementer        # Show agent details
ark agent create my-agent         # Create new agent (opens editor)
ark agent edit my-agent           # Edit agent definition
ark agent copy implementer fast   # Copy agent for customization
ark agent delete my-agent         # Delete a custom agent
```

### Flow Definitions

Flows define multi-stage workflows:

```yaml
# flows/definitions/my-flow.yaml
name: my-flow
description: Custom workflow
stages:
  - name: plan
    agent: planner
    gate: manual          # manual | auto | condition
    on_failure: retry(3)  # retry up to 3 times on failure
    artifacts: [PLAN.md]
  - name: implement
    agent: implementer
    gate: auto
```

### Builtin Flows

| Flow | Stages | Use Case |
|------|--------|----------|
| `default` | plan > implement > pr > review > build > merge > close > docs | Full SDLC pipeline |
| `quick` | implement > pr | Fast implementation |
| `bare` | implement | Single-agent, no gates |
| `parallel` | Fork/join pattern | Parallel workstreams |
| `fan-out` | Multiple parallel children | Task decomposition |
| `pr-review` | Review-focused | PR review workflow |

### Managing Flows

```bash
ark flow list              # List all flows
ark flow show default      # Show flow stages and gates
```

---

## Skills & Recipes

### Skills

Skills are reusable prompt fragments injected into agent system prompts at dispatch time. Three-tier resolution (highest priority first):

1. **Project**: `.ark/skills/<name>.md` in the repo
2. **Global**: `~/.ark/skills/<name>.md`
3. **Builtin**: `skills/<name>.md` shipped with Ark

Attach skills to agents via the `skills` field in agent YAML:

```yaml
skills: [code-review, test-writing]
```

```bash
ark skill list              # List available skills
ark skill show code-review  # Show skill content
```

### Recipes

Recipes are session templates with variables. Same three-tier resolution as skills.

```bash
ark recipe list                           # List available recipes
ark recipe show quick-fix                 # Show recipe details
ark session start --recipe quick-fix --repo . --dispatch
```

Builtin recipes: `quick-fix`, `feature-build`, `code-review`, `fix-bug`, `new-feature`.

---

## Git Worktrees

When dispatching a session, Ark automatically creates a git worktree so the agent works on an isolated branch without affecting your working directory.

### Worktree Lifecycle

```bash
ark worktree list                             # List sessions with active worktrees

ark worktree finish s-a1b2c3                  # Merge + remove worktree + delete session
ark worktree finish s-a1b2c3 --into develop   # Merge into specific branch
ark worktree finish s-a1b2c3 --no-merge       # Remove worktree without merging
ark worktree finish s-a1b2c3 --keep-branch    # Keep branch after merge
```

Worktrees are stored at `~/.ark/worktrees/<sessionId>/`.

---

## Compute

Ark supports multiple compute providers for running agents.

### Local Provider

The default. Runs agents in tmux sessions on your machine. No provisioning needed.

### Docker Provider

```bash
ark compute create my-docker --provider docker --image ubuntu:22.04
ark compute create my-dev --provider docker --devcontainer
ark compute provision my-docker
```

Options:
- `--image <image>`: Docker image (default: `ubuntu:22.04`)
- `--devcontainer`: Use devcontainer.json from project
- `--volume <mount>`: Extra volume mount (repeatable)

### EC2 Provider

```bash
ark compute create my-ec2 --provider ec2 --size m --region us-east-1 --profile yt
ark compute provision my-ec2
```

Size options:

| Size | vCPU | RAM |
|------|------|-----|
| `xs` | 2 | 8 GB |
| `s` | 4 | 16 GB |
| `m` | 8 | 32 GB |
| `l` | 16 | 64 GB |
| `xl` | 32 | 128 GB |
| `xxl` | 48 | 192 GB |
| `xxxl` | 64 | 256 GB |

Additional options: `--arch` (x64/arm), `--region`, `--profile` (AWS profile), `--subnet-id`, `--tag key=value`.

### Compute Lifecycle

```bash
ark compute list                    # List all compute resources
ark compute status my-ec2           # Show status + metrics
ark compute metrics my-ec2          # Detailed metrics (CPU, MEM, DISK, NET)
ark compute start my-ec2            # Start stopped compute
ark compute stop my-ec2             # Stop running compute
ark compute destroy my-ec2          # Tear down infrastructure
ark compute delete my-ec2           # Remove from database
ark compute ssh my-ec2              # SSH into remote compute
ark compute sync my-ec2             # Sync environment files to compute
ark compute update my-ec2 --size l  # Update configuration
```

---

## Conductor

The conductor is an HTTP server (port 19100) that coordinates agent sessions. It receives status reports from agents via hooks, relays messages through channels, and manages session lifecycle.

### Starting the Conductor

The TUI starts the conductor automatically. For standalone use:

```bash
ark conductor start                 # Start on default port 19100
ark conductor start --port 19200    # Custom port
```

### Learning System

The conductor tracks recurring patterns during orchestration. After a pattern occurs 3 times, it is promoted from a learning to a policy.

```bash
ark conductor learnings             # Show all learnings and policies
ark conductor learn "Always run tests before merge" "Catches regressions early"
```

Learnings are stored in `~/.ark/conductor/`.

---

## Messaging Bridges

Connect Ark to external messaging platforms for remote monitoring and control.

### Setup

Create `~/.ark/bridge.json`:

```json
{
  "telegram": {
    "botToken": "123456:ABC-DEF...",
    "chatId": "12345678"
  },
  "slack": {
    "webhookUrl": "https://hooks.slack.com/services/T00/B00/xxx"
  },
  "discord": {
    "webhookUrl": "https://discord.com/api/webhooks/..."
  }
}
```

You can configure one or more platforms. Only the ones with credentials will be activated.

### Telegram Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and get the bot token
2. Get your chat ID (send a message to your bot, then check `https://api.telegram.org/bot<token>/getUpdates`)
3. Add `botToken` and `chatId` to `~/.ark/bridge.json`

### Slack Setup

1. Create an [Incoming Webhook](https://api.slack.com/messaging/webhooks) in your Slack workspace
2. Add the `webhookUrl` to `~/.ark/bridge.json`

### Discord Setup

1. Create a webhook in your Discord channel settings (Integrations > Webhooks)
2. Add the `webhookUrl` to `~/.ark/bridge.json`

### Using the Bridge

```bash
ark conductor bridge                  # Start the bridge (listens for commands)
ark conductor notify "Deploy done"    # Send a one-off notification
```

The bridge responds to commands sent via chat:
- `/status` or `status` -- summary of running sessions
- `/sessions` or `sessions` -- list recent sessions

---

## Profiles

Profiles provide isolated session namespaces, useful for separating work contexts or multiple Claude accounts.

### Managing Profiles

```bash
ark profile list                          # List all profiles
ark profile create work "Work projects"   # Create a profile
ark profile delete old-profile            # Delete a profile
```

### Using Profiles

```bash
ark -p work session list                  # List sessions in work profile
ark -p work session start --repo . --summary "Task"
```

Sessions in a profile are scoped via a group name prefix, so they do not appear in other profiles.

---

## MCP Socket Pooling

By default, each Claude session spawns its own MCP server processes. With socket pooling, MCP servers run as long-lived daemons with Unix socket connections, shared across sessions. This reduces memory usage by 85-90%.

### How It Works

1. Ark starts each configured MCP server once as a background process
2. The server listens on a Unix socket at `~/.ark/mcp-pool-<name>.sock`
3. Sessions use `ark mcp-proxy <socket>` as their MCP command, which bridges stdin/stdout to the shared socket

### The Proxy

```bash
ark mcp-proxy /path/to/socket     # Internal command used by pooled MCP configs
```

This is an internal command -- you do not call it directly. Ark writes the proxy config into `.mcp.json` automatically when pooling is active.

---

## Configuration

Ark reads configuration from `~/.ark/config.yaml`. Open it with:

```bash
ark config                    # Opens in $EDITOR
ark config --path             # Print the config file path
```

See the [Configuration Reference](configuration.md) for all options.

### Per-Repository Config

Create `.ark.yaml` (or `.ark.yml` or `ark.yaml`) in your repo root:

```yaml
flow: quick
group: my-team
compute: my-ec2
agent: implementer
env:
  CUSTOM_VAR: "value"
```

These defaults are used when starting sessions in that repository. CLI flags override repo config values.

---

## Search

### Session Search

Search across session metadata, events, and messages:

```bash
ark search "authentication"                    # Basic search
ark search "auth" --transcripts                # Also search Claude transcripts
ark search "auth" --index --transcripts        # Rebuild index first, then search
ark search "auth" --limit 50                   # More results
```

### Global Conversation Search

Search across all Claude Code conversations on disk (not just Ark sessions):

```bash
ark search-all "database migration"            # Search all conversations
ark search-all "error" --days 30               # Last 30 days only
ark search-all "refactor" --limit 50           # More results
```

### FTS5 Index

For fast transcript search, build the full-text search index:

```bash
ark index                                      # Build/rebuild the FTS5 index
```

The index is stored in `~/.ark/ark.db` and speeds up transcript searches significantly.

---

## Headless / CI Mode

Run sessions non-interactively for CI/CD pipelines:

```bash
ark exec --repo . --summary "Run linter" --flow bare
ark exec --repo . --summary "Fix tests" --flow bare --timeout 300
ark exec --repo . --summary "Task" --output json    # JSON output
```

Options:
- `--autonomy <level>`: `full`, `execute`, `edit`, `read-only`
- `--output <format>`: `text` or `json`
- `--timeout <seconds>`: `0` for unlimited

The process exits with the session's exit code.

---

## Sandboxed Sessions

Run one-shot sandboxed sessions that auto-clean up:

```bash
ark try "Run the test suite and fix any failures"
ark try "Refactor the auth module" --image node:20
```

The session is automatically deleted when it finishes. If Docker is not available, runs without sandboxing.

---

## Scheduled Sessions

Create recurring sessions on a cron schedule:

```bash
ark schedule add --cron "0 2 * * *" --summary "Nightly tests" --repo . --flow bare
ark schedule list
ark schedule enable sched-abc123
ark schedule disable sched-abc123
ark schedule delete sched-abc123
```

---

## Issue Watching

Automatically create sessions from GitHub issues with a specific label:

```bash
ark watch --label ark --dispatch                    # Watch for 'ark' labeled issues
ark watch --label ark --dispatch --interval 30000   # Poll every 30s
```

---

## Authentication

Set up Claude authentication for local and remote compute:

```bash
ark auth                           # Local auth setup (runs claude setup-token)
ark auth --host my-ec2             # Run setup-token on a remote compute
```

The OAuth token is saved to `~/.ark/claude-oauth-token` and picked up automatically by dispatch.

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ARK_CONDUCTOR_PORT` | `19100` | Conductor HTTP server port |
| `ARK_CONDUCTOR_URL` | `http://localhost:19100` | Conductor URL |
| `ARK_ARKD_URL` | `http://localhost:19300` | ArkD daemon URL |
| `ARK_ARKD_PORT` | `19300` | ArkD daemon port |
| `ARK_CHANNEL_PORT` | auto-assigned | Per-session MCP channel port |
| `ARK_SESSION_ID` | -- | Set in channel context |
| `ARK_STAGE` | -- | Current flow stage in channel |
| `ARK_PROFILE` | `default` | Active profile name |
| `ARK_TEST_DIR` | -- | Temp directory for test isolation |
