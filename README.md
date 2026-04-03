# Ark

Autonomous agent ecosystem. Ark orchestrates Claude AI agents through multi-stage software development workflows with local, Docker, and EC2 compute providers. Define a task, pick a flow, and Ark handles planning, implementation, review, and documentation through coordinated agent sessions -- from the CLI, terminal dashboard, or web UI.

## Prerequisites

- [Bun](https://bun.sh) (runtime)
- [tmux](https://github.com/tmux/tmux) (session management)
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) (agent backend)

## Installation

```bash
git clone https://github.com/your-org/ark.git
cd ark
make install    # bun install + symlink ark to /usr/local/bin
```

## Quick Start

```bash
# Create and dispatch a session in one command
ark session start --repo . --summary "Add user auth" --dispatch

# Or use a recipe template
ark session start --recipe quick-fix --repo . --dispatch

# Launch the terminal dashboard
ark tui

# Launch the web dashboard
ark web

# Search across all sessions and transcripts
ark search "authentication"
```

## Features

| Feature | Description | Docs |
|---------|-------------|------|
| **Sessions** | Full lifecycle management -- create, dispatch, stop, resume, fork, clone, export/import | [Guide](docs/guide.md#sessions) |
| **TUI Dashboard** | 7-tab terminal UI with keyboard-driven navigation, fuzzy search, status filters | [TUI Reference](docs/tui-reference.md) |
| **Web Dashboard** | Browser-based session management with SSE live updates, token auth, read-only mode | [Guide](docs/guide.md#web-dashboard) |
| **Cost Tracking** | Automatic token usage collection, per-model pricing, budget limits | [Guide](docs/guide.md#cost-tracking) |
| **Flows & Agents** | YAML-defined multi-stage workflows with specialized AI agents | [Guide](docs/guide.md#flows--agents) |
| **Skills & Recipes** | Reusable prompt fragments and session templates with three-tier resolution | [Guide](docs/guide.md#skills--recipes) |
| **Git Worktrees** | Automatic branch isolation per session, merge + cleanup in one command | [Guide](docs/guide.md#git-worktrees) |
| **Compute** | Local, Docker, and EC2 compute providers with full lifecycle management | [Guide](docs/guide.md#compute) |
| **Messaging Bridges** | Telegram, Slack, Discord notifications and remote control | [Guide](docs/guide.md#messaging-bridges) |
| **Profiles** | Isolated session namespaces for multiple projects/accounts | [Guide](docs/guide.md#profiles) |
| **MCP Socket Pooling** | 85-90% memory reduction by sharing MCP server processes | [Guide](docs/guide.md#mcp-socket-pooling) |
| **Conductor** | Orchestration server with learning system for recurring patterns | [Guide](docs/guide.md#conductor) |
| **Search** | Full-text search across sessions, events, messages, and transcripts (FTS5) | [Guide](docs/guide.md#search) |
| **Schedules** | Cron-based recurring sessions | [CLI Reference](docs/cli-reference.md#ark-schedule) |

## Architecture

```
packages/
  cli/       Commander.js CLI entry point (ark command)
  core/      Sessions, store (SQLite), flows, agents, channels, conductor,
             search (FTS5), costs, profiles, themes, web server, bridge
  compute/   Providers: local (tmux), Docker, EC2 (AWS SDK)
  arkd/      Universal agent daemon -- HTTP server on every compute target
  tui/       React + Ink terminal dashboard (7 tabs)

agents/      Agent YAML definitions (planner, implementer, reviewer, documenter, worker)
flows/       Flow YAML definitions (default, quick, bare, parallel, fan-out, pr-review)
skills/      Builtin skill definitions (code-review, test-writing)
recipes/     Recipe templates (quick-fix, feature-build, code-review, fix-bug, new-feature)
docs/        User documentation
```

## Documentation

- **[User Guide](docs/guide.md)** -- comprehensive feature walkthrough
- **[CLI Reference](docs/cli-reference.md)** -- every command, option, and example
- **[TUI Reference](docs/tui-reference.md)** -- all keyboard shortcuts by tab
- **[Configuration](docs/configuration.md)** -- config files, hotkeys, themes, budgets
- **[CLAUDE.md](CLAUDE.md)** -- developer documentation (architecture, testing, gotchas)

## Development

```bash
make dev         # TypeScript watch mode
make test        # Run tests (bun test)
make lint        # Lint
make clean       # Remove build artifacts
make uninstall   # Remove ark symlink
```

Tests use `bun:test`. Run with `bun test` or `make test`.

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
