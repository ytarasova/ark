# Ark

**The orchestration layer for AI coding agents.** Manage sessions, workflows, and compute so your agents ship code -- not just write it.

AI coding agents are powerful but ephemeral. They spin up, do work, and vanish -- leaving you to manage context, coordinate stages, track costs, and wire up infrastructure yourself. Ark handles all of that. Define a task, pick a workflow, and Ark drives your agents through planning, implementation, review, and documentation -- across local machines, Docker containers, or EC2 instances. It works with any CLI coding tool: Claude Code, OpenAI Codex, Google Gemini CLI, Aider, or your own.

## Prerequisites

- [Bun](https://bun.sh) (runtime)
- [tmux](https://github.com/tmux/tmux) (session management)
- At least one CLI coding agent ([Claude Code](https://docs.anthropic.com/en/docs/claude-cli), [Codex](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Aider](https://aider.chat), etc.)

## Installation

```bash
make install    # bun install + symlink ark to /usr/local/bin
```

Run `ark doctor` to verify your environment (Bun version, tmux, agent CLIs, database).

## Quick Start

```bash
# Create and dispatch a session in one command
ark session start --repo . --summary "Add user auth" --dispatch

# Or use a recipe template
ark session start --recipe quick-fix --repo . --dispatch

# Launch the terminal dashboard
ark tui

# Launch the web dashboard (or desktop app)
ark web

# Search across all sessions and transcripts
ark search "authentication"
```

## Features

| Feature | Description | Docs |
|---------|-------------|------|
| **Sessions** | Full lifecycle management -- create, dispatch, stop, resume, fork, clone, export/import | [Guide](docs/guide.md#sessions) |
| **Multi-Agent Support** | Pluggable executor system -- Claude Code, Codex, Gemini CLI, Aider, or any CLI tool via `cli-agent` runtime | [CLAUDE.md](CLAUDE.md#executor-system) |
| **Flows & Agents** | YAML-defined multi-stage workflows with specialized AI agents and verification gates | [Guide](docs/guide.md#flows--agents) |
| **TUI Dashboard** | 7-tab terminal UI with keyboard-driven navigation, search, status filters | [TUI Reference](docs/tui-reference.md) |
| **Web Dashboard** | Browser-based session management with SSE live updates, token auth, read-only mode | [Guide](docs/guide.md#web-dashboard) |
| **Desktop App** | Electron wrapper around the web dashboard -- native menus, system tray, local-first | -- |
| **Compute Providers** | Local (tmux), Docker, DevContainer, Firecracker, and EC2 with full lifecycle management | [Guide](docs/guide.md#compute) |
| **Git Worktrees** | Automatic branch isolation per session, diff preview, merge + auto-PR in one command | [Guide](docs/guide.md#git-worktrees) |
| **Skills & Recipes** | Reusable prompt fragments and session templates with three-tier resolution (project, global, builtin) | [Guide](docs/guide.md#skills--recipes) |
| **Cost Tracking** | Automatic token usage collection, per-model pricing, budget limits | [Guide](docs/guide.md#cost-tracking) |
| **Search** | Full-text search across sessions, events, messages, and transcripts (FTS5) | [Guide](docs/guide.md#search) |
| **MCP Socket Pooling** | 85-90% memory reduction by sharing MCP server processes across agents | [Guide](docs/guide.md#mcp-socket-pooling) |
| **ACP Server** | Headless JSON-RPC protocol for programmatic access (stdin/stdout) | [CLI Reference](docs/cli-reference.md#ark-acp) |
| **Messaging Bridges** | Telegram, Slack, Discord notifications and remote control | [Guide](docs/guide.md#messaging-bridges) |
| **Conductor** | Orchestration server with hook-based status detection and learning system | [Guide](docs/guide.md#conductor) |
| **Profiles** | Isolated session namespaces for multiple projects/accounts | [Guide](docs/guide.md#profiles) |
| **Schedules** | Cron-based recurring sessions | [CLI Reference](docs/cli-reference.md#ark-schedule) |
| **Doctor & Init** | Environment verification and project scaffolding | [CLI Reference](docs/cli-reference.md#ark-doctor) |

## Architecture

```
packages/
  cli/        Commander.js CLI entry point (ark command)
  core/       Sessions, store (SQLite), flows, agents, channels, conductor,
              search (FTS5), costs, profiles, themes, web server, bridge
  compute/    Providers: local (tmux/worktree/docker/devcontainer/firecracker),
              remote EC2 (worktree/docker/devcontainer/firecracker)
  arkd/       Universal agent daemon -- HTTP server on every compute target
  tui/        React + Ink terminal dashboard (7 tabs)
  web/        Vite-based web dashboard (SSE live updates)
  desktop/    Electron shell wrapping the web dashboard
  server/     JSON-RPC handlers (delegate to services via AppContext)
  protocol/   ArkClient (typed JSON-RPC client)
  types/      Domain interfaces (Session, Compute, Event, Message, etc.)
  e2e/        End-to-end tests (Playwright for web + desktop)

agents/       Agent YAML definitions (planner, implementer, reviewer, documenter,
              worker, codex-worker, gemini-worker, aider-worker, generic-cli)
flows/        Flow YAML definitions (default, quick, bare, parallel, fan-out, pr-review)
skills/       Builtin skill definitions
recipes/      Recipe templates (quick-fix, feature-build, code-review, fix-bug, new-feature)
docs/         User documentation
```

## Documentation

- **[User Guide](docs/guide.md)** -- comprehensive feature walkthrough
- **[CLI Reference](docs/cli-reference.md)** -- every command, option, and example
- **[TUI Reference](docs/tui-reference.md)** -- all keyboard shortcuts by tab
- **[Configuration](docs/configuration.md)** -- config files, hotkeys, themes, budgets
- **[CLAUDE.md](CLAUDE.md)** -- developer documentation (architecture, testing, gotchas)

## Development

```bash
make dev              # TypeScript watch mode
make test             # Run all tests sequentially (never parallel -- ports collide)
make test-file F=path # Run a single test file
make tui              # Launch TUI from source
make web              # Launch web dashboard
make desktop          # Launch Electron desktop app
make desktop-build    # Package Electron app for distribution
make lint             # Lint
make clean            # Remove build artifacts
make uninstall        # Remove ark symlink
```

Tests use `bun:test`. Always run via `make test` -- never call `bun test` directly (tests must run sequentially to avoid port collisions).

## Data

| Path | Purpose |
|------|---------|
| `~/.ark/ark.db` | SQLite database (WAL mode) |
| `~/.ark/config.yaml` | User configuration |
| `~/.ark/tracks/` | Launcher scripts per session |
| `~/.ark/worktrees/` | Git worktrees for isolated sessions |
| `~/.ark/skills/` | Global skill definitions |
| `~/.ark/recipes/` | Global recipe definitions |
| `~/.ark/profiles.json` | Profile definitions |
| `~/.ark/bridge.json` | Messaging bridge config (Telegram/Slack/Discord) |

## License

MIT
