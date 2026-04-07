# Ark User Guide

Ark orchestrates AI coding agents through multi-stage workflows. You define the workflow, Ark manages the agents.

## Quickstart (60 seconds)

### Install

```bash
# Prerequisites: Bun, tmux, Claude CLI
brew install tmux
curl -fsSL https://bun.sh/install | bash

# Install Ark
git clone https://github.com/your-org/ark.git
cd ark && make install
```

### Fix a bug

```bash
ark session start --repo . --summary "Fix the login timeout bug" --dispatch --attach
```

That's it. Ark creates a session, assigns an agent, launches it in tmux, and attaches you to watch it work. The agent reads your codebase, writes code, runs tests, and commits.

### Build a feature (multi-stage)

```bash
ark session start --repo . --summary "Add OAuth2 login" --flow default --dispatch
```

The `default` flow runs: plan > implement > PR > review > merge. Each stage uses a specialized agent. Gates between stages let you review before the next agent starts.

### Use the dashboard

```bash
ark tui    # Terminal dashboard (7 tabs, keyboard-driven)
ark web    # Web dashboard (browser-based, SSE live updates)
make desktop  # Desktop app (Electron, native window)
```

### Use a recipe template

```bash
ark recipe list                                          # See available templates
ark session start --recipe quick-fix --repo . --dispatch # One-command session from template
```

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

### Interrupting Agents

Interrupt a running agent without killing its tmux session. The agent pauses (receives Ctrl+C) and can be re-engaged:

```bash
ark session interrupt s-a1b2c3    # Pause the agent
ark session send s-a1b2c3 "Continue with the API layer"  # Re-engage
```

In the TUI, press `I` to interrupt the selected session.

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

### Archiving Sessions

Archive completed sessions for long-term reference without deleting them:

```bash
ark session archive s-a1b2c3     # Archive (hidden from default list)
ark session restore s-a1b2c3     # Restore to stopped status
ark session list --archived       # Show archived sessions
```

In the TUI, press `Z` to archive/restore.

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

### Session Actions

| Key | Action |
|-----|--------|
| `I` | Interrupt running agent |
| `V` | Run verification |
| `Z` | Archive/restore session |
| `W` | Worktree finish overlay (with diff preview) |

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

## Desktop App

Ark ships as an Electron desktop app that wraps the Web UI in a native window.

### Running

```bash
make desktop                         # Build web + launch Electron app
```

### Building for Distribution

```bash
make desktop-build                   # Package for macOS/Windows/Linux
```

This produces distributable binaries in `packages/desktop/out/`:
- macOS: `.dmg` and `.zip`
- Windows: `.exe` (NSIS installer) and `.zip`
- Linux: `.AppImage` and `.deb`

### How it works

The desktop app boots the Ark web server (`ark web`) as a child process on a free port, then opens a BrowserWindow. All features work identically to the browser-based dashboard. The native window provides:
- macOS traffic light controls with hidden title bar
- Native menu bar (Edit, View, Window)
- External links open in the system browser
- Dark background matches the Ark theme

### Prerequisites

```bash
make desktop-install                 # Install Electron + electron-builder
```

Requires: Bun, Git, `ark` on PATH (`make install`).

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

- **Session management**: create, dispatch, stop, restart, interrupt, pause, advance, complete, fork, send, archive sessions
- **Compute lifecycle**: provision, start, stop, destroy compute resources
- **Scheduling**: create, enable/disable, delete scheduled sessions
- **Verification**: run verification, manage todos
- **Diff preview**: view changes before merging or creating PRs
- **PR creation**: create GitHub PRs from session worktrees
- **Cost tracking**: per-session and aggregate cost display
- **Memory view**: add, search, and delete cross-session memories from the sidebar
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

### Executor System

Agents dispatch through pluggable executors. The `runtime` field selects which executor launches the agent:

- `claude-code` (default) -- launches Claude Code in tmux with hooks + MCP channel
- `subprocess` -- spawns any command as a child process

```yaml
# Custom subprocess agent
name: my-linter
runtime: subprocess
command: ["node", "scripts/lint.js"]
env:
  TARGET: "{workdir}"
```

```bash
ark agent list    # Shows all agents with their runtime type
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

### Verification Gates

Flow stages can require verification scripts to pass before completion:

```yaml
stages:
  - name: implement
    agent: implementer
    gate: auto
    verify:
      - "npm test"
      - "npm run lint"
```

The agent cannot complete the stage until all verify scripts pass. Failed verification steers the agent to fix the issue.

### Todos

Add checklists that block stage completion:

```bash
ark session todo add s-a1b2c3 "Write migration docs"
ark session todo list s-a1b2c3
ark session todo done s-a1b2c3 1          # Toggle todo #1
ark session verify s-a1b2c3               # Run verification manually
ark session complete s-a1b2c3             # Blocked if todos/scripts fail
ark session complete s-a1b2c3 --force     # Override verification
```

Todos are shown in the TUI detail panel. Press `V` to run verification.

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

### Creating and Deleting Skills

```bash
# Create a skill inline
ark skill create my-skill -d "Review checklist" -p "Always check for..."

# Create from a YAML file
ark skill create --from my-skill.yaml

# Create a project-scoped skill (saved to .ark/skills/)
ark skill create my-skill -d "..." -p "..." --scope project --tags "review,quality"

# Delete a skill (global or project scope -- cannot delete builtins)
ark skill delete my-skill
ark skill delete my-skill --scope project
```

### Skill Extraction

When a session completes its flow, Ark automatically analyzes the conversation transcript for reusable patterns -- multi-step procedures, repeated methodology, and structured approaches. High-confidence candidates (scored >= 0.6) are saved as global skills with names like `extracted-<sessionId>-0`. This is best-effort and runs silently; extraction failures never block session completion.

### Recipes

Recipes are session templates with variables. Same three-tier resolution as skills.

```bash
ark recipe list                           # List available recipes
ark recipe show quick-fix                 # Show recipe details
ark session start --recipe quick-fix --repo . --dispatch
```

Builtin recipes: `quick-fix`, `feature-build`, `code-review`, `fix-bug`, `new-feature`.

### Creating and Deleting Recipes

```bash
# Create from a YAML file
ark recipe create --from my-recipe.yaml

# Create from an existing session (captures its flow, agent, repo, summary as a template)
ark recipe create --from-session s-a1b2c3 --name my-recipe

# Project-scoped recipe
ark recipe create --from my-recipe.yaml --scope project

# Delete a recipe (cannot delete builtins)
ark recipe delete my-recipe
ark recipe delete my-recipe --scope project
```

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

### Diff Preview

Preview changes before merging:

```bash
ark worktree diff s-a1b2c3                    # Show diff stat
ark worktree diff s-a1b2c3 --base develop     # Compare against specific branch
```

In the TUI, press `W` to see the worktree finish overlay with diff preview.

### Creating Pull Requests

Create a GitHub PR from a session's worktree branch:

```bash
ark worktree pr s-a1b2c3                      # Push branch + create PR
ark worktree pr s-a1b2c3 --title "My PR"      # Custom title
ark worktree pr s-a1b2c3 --draft              # Create as draft
ark worktree finish s-a1b2c3 --pr             # Finish worktree and create PR
```

**Auto-PR**: When an agent completes and the repo has a git remote, Ark automatically pushes the branch and creates a PR. Disable per-repo with `auto_pr: false` in `.ark.yaml`.

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

## Protocol Server

Ark includes a JSON-RPC 2.0 server that provides a standard interface for all clients.

### Starting the server

```bash
ark server start              # WebSocket on port 19400
ark server start --stdio      # JSONL over stdin/stdout (for embedding)
ark server start --port 9000  # Custom WebSocket port
```

The TUI and CLI embed the server in-process automatically -- you only need to start it explicitly for external clients (IDE extensions, custom dashboards).

### Protocol

The server exposes 80+ methods covering sessions, agents, flows, skills, recipes, compute, search, memory, and costs. Clients connect via WebSocket and receive push notifications for session state changes.

See `packages/protocol/types.ts` for the full method list.

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

## Memory

Ark maintains cross-session persistent memory -- knowledge that agents can recall during future sessions. Memories are stored in `~/.ark/memories.json` with tags, scopes, and importance scores.

### CLI

```bash
ark memory list                                  # List all memories
ark memory list --scope project                  # Filter by scope
ark memory add "Always run tests before merging" --tags "process,testing"
ark memory add "API uses OAuth2" --scope project --importance 0.8
ark memory recall "authentication"               # Search by keyword
ark memory forget mem-1234567890-abc123          # Delete a specific memory
ark memory clear --scope project --force         # Clear all project memories
```

### TUI

Press `Y` in the Sessions tab to open the Memory Manager. Use `j/k` to navigate, `n` to add, `x` to delete, `Esc` to close.

### Web Dashboard

The web dashboard includes a Memory view accessible from the sidebar. Add, search, and delete memories from the browser.

### How memories work

At dispatch time, Ark recalls memories relevant to the session summary (keyword overlap scoring) and injects them into the agent's task prompt. This gives agents context from prior sessions without explicit configuration.

Memories have:
- **content** -- the knowledge to remember
- **tags** -- categorical labels for retrieval
- **scope** -- "global", "project", or custom scopes
- **importance** -- 0-1 score affecting recall ranking

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

### Hybrid Search

Use `--hybrid` to search across memory, knowledge, and transcripts simultaneously. Results are deduplicated and re-ranked by Claude Haiku for relevance (requires `ANTHROPIC_API_KEY`):

```bash
ark search "authentication" --hybrid           # Unified search with LLM re-ranking
ark search "auth" --hybrid --limit 30          # More results
```

Each result shows its source (`memory`, `knowledge`, or `transcript`) and a relevance score. Without an API key, results are returned in score order without LLM re-ranking.

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

## Use Cases

### Quick bug fix

The fastest path from bug report to fix:

```bash
ark session start --repo . --summary "Fix: users can't log in when session expires" --flow bare --dispatch --attach
```

Single agent, no gates, auto-attach. Watch it work, detach when satisfied.

### Feature development with review

Multi-stage flow with human checkpoints:

```bash
ark session start --repo . --summary "Add rate limiting to API" --flow default --dispatch
```

The agent plans first (creates PLAN.md), then implements, creates a PR, and waits for review. You approve each gate in the TUI before the next stage starts.

### Parallel task decomposition

Break a large task into parallel workstreams:

```bash
# Parent session
ark session start --repo . --summary "Migrate to new auth system" --flow bare
# Spawn parallel children
ark session spawn s-parent "Migrate user model"
ark session spawn s-parent "Migrate API middleware"
ark session spawn s-parent "Migrate tests"
# Wait for all to complete
ark session join s-parent
```

### Code review

Use the review-focused flow:

```bash
ark session start --repo . --summary "Review PR #142" --flow pr-review --dispatch
```

The reviewer agent produces structured JSON feedback with P0-P3 severity levels.

### CI/CD automation

Run headless in a CI pipeline:

```bash
ark exec --repo . --summary "Run linter and fix violations" --flow bare --timeout 300
```

Exits with the session's exit code. Use `--output json` for machine-readable results.

### Custom subprocess agent

Run any command as an Ark agent (no Claude needed):

```yaml
# agents/my-linter.yaml
name: my-linter
runtime: subprocess
command: ["node", "scripts/lint-and-fix.js"]
env:
  TARGET: "{workdir}"
```

```bash
ark session start --repo . --summary "Lint pass" --agent my-linter --dispatch
```

### Remote compute (EC2)

Run agents on powerful cloud machines:

```bash
ark compute create gpu-box --provider ec2 --size xl --region us-east-1
ark compute provision gpu-box
ark session start --repo . --summary "Train model" --compute gpu-box --dispatch
```

### Scheduled nightly tasks

Automate recurring work:

```bash
ark schedule add --cron "0 2 * * *" --summary "Nightly test suite" --repo . --flow bare
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

## OTLP Observability

Ark can export session and stage lifecycle as OpenTelemetry traces to any OTLP HTTP collector. No OpenTelemetry SDK is required -- Ark posts OTLP JSON directly.

### Configuration

Add an `otlp:` block to `~/.ark/config.yaml`:

```yaml
otlp:
  enabled: true
  endpoint: "http://localhost:4318/v1/traces"
  headers:
    Authorization: "Bearer my-token"
```

| Key | Required | Description |
|-----|----------|-------------|
| `enabled` | yes | Set to `true` to activate trace export |
| `endpoint` | yes | OTLP HTTP endpoint (e.g., Jaeger, Grafana Tempo, Honeycomb) |
| `headers` | no | Extra HTTP headers (auth tokens, API keys) |

### What gets traced

- **Session span**: one span per session lifecycle (start to completion/failure), tagged with session ID, flow, repo, agent, token counts, and cost.
- **Stage spans**: child spans nested under the session span, one per flow stage (plan, implement, review, etc.), tagged with agent and gate type.

Spans are buffered and flushed every 30 seconds. Export is fire-and-forget -- collector failures do not affect session execution.

---

## Auto-Rollback

Ark can monitor merged PRs for CI failures and automatically create revert PRs when checks fail.

### Configuration

Add a `rollback:` block to `~/.ark/config.yaml`:

```yaml
rollback:
  enabled: true
  timeout: 600          # seconds to wait for CI to complete (default: 600)
  on_timeout: rollback  # "rollback" or "ignore" when CI doesn't finish in time
  auto_merge: false     # auto-merge the revert PR (default: false)
  health_url: null      # optional HTTP URL to check after CI passes
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `false` | Activate post-merge monitoring |
| `timeout` | `600` | Seconds to wait for check suites to complete |
| `on_timeout` | `"ignore"` | Action when CI times out: `"rollback"` creates a revert PR, `"ignore"` does nothing |
| `auto_merge` | `false` | Whether to auto-merge the generated revert PR |
| `health_url` | `null` | HTTP endpoint to probe after all CI checks pass. A non-2xx response triggers rollback |

### How it works

After a session's merge stage completes, Ark polls GitHub check suites on the merge commit SHA every 30 seconds. If any check suite fails, Ark:

1. Creates a `revert-<branch>` branch
2. Opens a revert PR titled "Revert: <original PR title>" with the list of failed checks
3. Logs a `rollback` event on the session
4. Optionally stops the session

If `health_url` is set, Ark also probes that URL after all CI checks pass. A failed health check triggers the same revert flow.

---

## Guardrails

Ark evaluates every tool call against a set of pattern-based guardrail rules before execution. This protects against dangerous commands that an agent might attempt.

### Default Rules

The following patterns are blocked by default:

| Tool | Pattern | Action |
|------|---------|--------|
| Bash | `rm -rf /` (excluding `/tmp`) | Block |
| Bash | `DROP TABLE` / `DROP DATABASE` | Block |
| Bash | Fork bombs | Block |
| Bash | `mkfs`, `fdisk`, `dd if=` | Block |
| Bash | `git push --force` / `git push -f` | Block |
| Read/Write | `.env` files | Warn |
| Read/Write | Files named `credentials` | Warn |

**Block** prevents the tool call entirely. **Warn** allows it but logs a warning event.

### How it works

Guardrails are enforced via the `PreToolUse` hook in `.claude/settings.local.json`, which Ark writes at dispatch time. When Claude attempts a tool call, the hook serializes the tool input to JSON and matches each rule's regex against it. The first matching rule determines the action. If no rule matches, the call is allowed.

### Custom Rules

Custom guardrail rules can be added alongside the defaults. They follow the same format:

```typescript
{ tool: "Bash", pattern: "curl.*\\|.*sh", action: "block" }
```

---

## Prompt Injection Guard

Ark scans task summaries and user messages for prompt injection attempts using heuristic pattern matching.

### When it runs

- **At dispatch time**: the session's task summary is scanned. High-severity detections block dispatch entirely.
- **At send time**: messages sent to running agents via `ark session send` are scanned. High-severity detections block the message. Lower-severity detections are logged as warnings but the message is still delivered.

### Detection patterns

The guard checks for common injection techniques:

- "Ignore previous instructions" / "Disregard your rules" (high severity)
- "You are now a different..." / "Forget everything" (high severity)
- Fake system prompt tags like `[SYSTEM]` or `system: you are` (medium/high)
- "Pretend you are..." / "Reveal your system prompt" (medium)
- Instruction extraction attempts (low)

This is a lightweight heuristic layer, not a security boundary. It catches common patterns but is not exhaustive.

---

## Testing

Tests use `bun:test`. Always run with `bun test` or `make test`, never `npm test` (the package.json test script is wrong).

### Critical: never run tests in parallel

Tests share SQLite databases and hardcoded network ports (19100, 19200, 19300). Running tests in parallel causes port collisions and database corruption. Always use `--concurrency 1`:

```bash
bun test --concurrency 1              # all tests, sequential
bun test --concurrency 1 packages/core    # core tests only
make test                             # uses --concurrency 1 by default
```

### Test isolation

Every test must create and clean up its own context to avoid leaking state:

```bash
const ctx = withTestContext();  # handles setup + teardown automatically
```

Or manually:

```bash
let ctx: TestContext;
beforeEach(() => { ctx = createTestContext(); setContext(ctx); });
afterEach(() => { ctx.cleanup(); });
```

### E2E tests

CLI and TUI E2E tests import from `dist/`. Build first with `make dev` or `tsc`.

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
| `ANTHROPIC_API_KEY` | -- | Required for hybrid search LLM re-ranking |
