# Ark

Autonomous agent ecosystem — JIRA to production.

Ark orchestrates multi-stage software development workflows using Claude AI agents, with support for local, Docker, and EC2 compute providers. Define a task, pick a flow, and Ark handles planning, implementation, review, and merge through coordinated agent sessions.

## Quick Start

```bash
# Prerequisites: Bun (https://bun.sh)
make install

# Start a session and dispatch the first agent
ark session start --repo . --summary "Add user auth" --dispatch

# Or launch the terminal UI
ark tui
```

## Architecture

```
ark/
├── packages/
│   ├── cli/        # Commander.js CLI (ark command)
│   ├── core/       # Session lifecycle, store, flows, agents, channels
│   ├── compute/    # Compute providers (local, docker, ec2)
│   └── tui/        # React + Ink terminal dashboard
├── agents/         # Agent definitions (YAML)
├── flows/          # Flow definitions (YAML)
└── recipes/        # Flow recipe templates
```

### Core Concepts

| Concept | Description |
|---------|-------------|
| **Session** | A unit of work tracking an SDLC task through stages. Has a ticket, summary, repo, branch, status, and assigned agent. |
| **Flow** | A YAML-defined multi-stage workflow (e.g., plan → implement → review → merge). Gates control stage transitions. |
| **Agent** | A Claude model with a specialized system prompt, tools, and configuration. Defined in `agents/*.yaml`. |
| **Compute** | An execution environment — local machine, Docker container, or EC2 instance. |
| **Conductor** | HTTP server (port 19100) that receives agent reports, relays messages, and polls metrics. |
| **Channel** | MCP server running alongside each Claude session for bidirectional Ark ↔ agent communication. |
| **Store** | SQLite database at `~/.ark/ark.db` tracking sessions, events, messages, and compute resources. |

### How Dispatch Works

```
ark session start --repo . --summary "Add auth" --dispatch
  → Create session record in SQLite
  → Load flow definition, resolve agent for current stage
  → Build task prompt with handoff context (PLAN.md, git log, prior stages)
  → Generate Claude CLI args (model, system prompt, tools, MCP config)
  → Write launcher script to ~/.ark/tracks/{sessionId}/
  → Spawn tmux session running the launcher
  → Claude connects back to conductor via channel MCP server
  → Agent works, reports progress/completion via HTTP to conductor
```

## CLI Reference

### Sessions

```bash
ark session start [ticket] [options]   # Create a new session
  -r, --repo <path>       Repository path
  -s, --summary <text>    Task summary
  -p, --flow <name>       Flow name (default: "default")
  -c, --compute <name>    Compute provider
  -g, --group <name>      Group name
  -d, --dispatch          Auto-dispatch the first stage agent
  -a, --attach            Dispatch and attach

ark session list                       # List all sessions
ark session show <id>                  # Show session details
ark session dispatch <id>              # Dispatch agent for current stage
ark session attach <id>                # Attach to a running session (tmux)
ark session stop <id>                  # Stop a running session
ark session resume <id>                # Resume a stopped session
ark session advance <id>               # Move to next flow stage
ark session complete <id>              # Mark session as completed
ark session pause <id> [reason]        # Pause with optional reason
ark session output <id>                # View agent output
ark session events <id>                # View event log
ark session send <id> <message>        # Send message to agent
ark session clone <id>                 # Clone a session
ark session fork <id>                  # Fork into parallel child sessions
ark session join <id>                  # Join forked children back
ark session handoff <id> <agent>       # Switch to a different agent
ark session delete <id>                # Delete a session
ark session group <id> <group>         # Assign session to a group
```

### Compute

```bash
ark compute create <name> [options]    # Create a compute resource
  --provider <type>       local | docker | ec2
  --size <size>           EC2: nano|micro|small|medium|large|xl|2xl|4xl
  --region <region>       EC2: AWS region
  --image <image>         Docker: image name
  --volumes <v>           Docker: volume mounts

ark compute list                       # List compute resources
ark compute provision <name>           # Provision infrastructure
ark compute start <name>               # Start a stopped compute
ark compute stop <name>                # Stop a running compute
ark compute destroy <name>             # Tear down infrastructure
ark compute delete <name>              # Remove from store
ark compute status <name>              # Show current status
ark compute metrics <name>             # Show CPU/memory/disk metrics
ark compute ssh <name>                 # SSH into remote compute
ark compute sync <name>                # Sync files to/from compute
```

### Other

```bash
ark agent list                         # List available agents
ark agent show <name>                  # Show agent definition
ark flow list                          # List available flows
ark flow show <name>                   # Show flow definition
ark tui                                # Launch terminal UI
ark conductor                          # Start conductor HTTP server
```

## Terminal UI

Launch with `ark tui`. Navigate with keyboard:

| Key | Action |
|-----|--------|
| `1-5` | Switch tabs (Sessions, Compute, Agents, Flows, Recipes) |
| `Tab` | Toggle left/right pane focus |
| `↑/↓` | Navigate lists |
| `n` | New session/compute |
| `d` | Dispatch session |
| `a` | Attach to session |
| `s` | Stop session |
| `r` | Resume session |
| `e` | Expand event log |
| `p` | Copy snapshot to clipboard |
| `q` | Quit |

## Agents

Built-in agents live in `agents/`. Each is a YAML file:

| Agent | Model | Purpose |
|-------|-------|---------|
| `planner` | Sonnet | Creates PLAN.md with architecture and implementation strategy |
| `implementer` | Opus | Writes code, tests, and commits |
| `reviewer` | Sonnet | Reviews PRs and suggests improvements |
| `documenter` | Sonnet | Generates project documentation |
| `worker` | Opus | General-purpose lightweight agent |

### Creating a Custom Agent

```yaml
# agents/my-agent.yaml
name: my-agent
description: What this agent does
model: opus          # opus | sonnet | haiku
max_turns: 200
system_prompt: |
  You are working on {repo}. Task: {summary}
  Ticket: {ticket}
  Working directory: {workdir}
tools: [Bash, Read, Write, Edit, Glob, Grep, WebSearch]
permission_mode: bypassPermissions
```

Template variables `{ticket}`, `{summary}`, `{workdir}`, `{repo}`, and `{branch}` are substituted at dispatch time.

## Flows

Built-in flows live in `flows/definitions/`:

| Flow | Stages | Use Case |
|------|--------|----------|
| `default` | plan → implement → pr → review → build → merge → close → docs | Full SDLC pipeline |
| `quick` | implement → pr | Fast implementation |
| `bare` | implement | Single-agent, no gates |
| `parallel` | Fork/join pattern | Parallel workstreams |

### Creating a Custom Flow

```yaml
# flows/definitions/my-flow.yaml
name: my-flow
description: Custom workflow
stages:
  - name: plan
    agent: planner
    gate: manual          # manual | auto | condition
    on_failure: retry(3)
    artifacts: [PLAN.md]
  - name: implement
    agent: implementer
    gate: auto
```

## Compute Providers

| Provider | Provisioning | Best For |
|----------|-------------|----------|
| **local** | None (uses your machine + tmux) | Development, quick tasks |
| **docker** | Pulls/builds image, devcontainer support | Isolated environments |
| **ec2** | Pulumi IaC, SSH keys, cloud-init | Heavy workloads, remote execution |

EC2 instances are provisioned via Pulumi and managed through SSH. File sync uses rsync, and a reverse tunnel connects the remote agent back to your local conductor.

## Development

```bash
make install       # Install deps, symlink ark to /usr/local/bin
make dev           # TypeScript watch mode
make test          # Run tests (vitest)
make test-watch    # Tests in watch mode
make lint          # Lint
make clean         # Remove build artifacts
make uninstall     # Remove ark symlink
```

### Runtime

Ark requires [Bun](https://bun.sh) — it uses Bun-native SQLite, FFI for POSIX syscalls, and fast TypeScript execution without a build step. The `./ark` entry script runs `packages/cli/index.ts` directly via Bun.

### Testing

Tests use Vitest with isolated SQLite databases per test. Each test creates a temp store via `createTestContext()` that cleans up automatically.

```bash
bun test                              # Run all tests
bun test packages/core                # Run core tests only
bun test --watch                      # Watch mode
```

### Data

- **Database:** `~/.ark/ark.db` (SQLite, WAL mode)
- **Tracks:** `~/.ark/tracks/{sessionId}/` (launcher scripts, channel configs)
- **Worktrees:** `~/.ark/worktrees/{sessionId}/` (git worktrees for sessions)
