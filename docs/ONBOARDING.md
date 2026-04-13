# Ark -- Pilot Onboarding

Quick-start guide for early adopters. 1 page, no marketing.

## What Ark Does

Ark orchestrates AI coding agents (Claude Code, Codex, Gemini CLI, Goose) through multi-stage development flows. You give it a task, it drives an agent through plan -> implement -> verify -> review -> PR automatically.

## Install

```bash
# From source (requires Bun + tmux)
git clone https://github.com/ytarasova/ark.git
cd ark
make install
```

This symlinks `ark` to `/usr/local/bin`. Verify with `ark --help`.

## What Works Right Now

- **Local sessions with Claude Code** -- dispatch a task, agent works in an isolated git worktree, creates a PR
- **Autonomous SDLC flow** -- plan -> implement -> verify -> review -> PR -> merge (all auto-gated)
- **Quick flow** -- implement -> verify -> PR -> merge (skip planning/review)
- **TUI dashboard** -- real-time session monitoring, attach to agent tmux, event timeline
- **Web dashboard** -- `ark web` for a browser-based view (local mode)
- **Knowledge graph** -- auto-indexes your codebase at dispatch for agent context
- **Cost tracking** -- per-session token usage, works with subscription mode ($0 cost display)
- **Multiple runtimes** -- `claude` (API), `claude-max` (subscription), `codex`, `gemini`, `goose`

## Quick Start

```bash
# 1. Start the TUI (starts conductor + arkd automatically)
make tui

# 2. In another terminal, dispatch a session
ark session start --flow quick --repo /path/to/your/repo \
  --summary "Fix the login validation bug" --dispatch

# 3. Watch it work
ark session list                    # see status
ark session events <session-id>     # event timeline
tmux attach -t ark-s-<session-id>   # watch the agent live
```

Or use the TUI directly: press `n` to create a session, fill in repo + summary, press Enter to dispatch.

## Flows

| Flow | Stages | When to use |
|------|--------|-------------|
| `quick` | implement -> verify -> PR -> merge | Small fixes, known solutions |
| `autonomous-sdlc` | plan -> implement -> verify -> review -> PR -> merge | Larger features, needs planning |
| `bare` | single work stage | Manual control |

## What Doesn't Work Yet

- **Remote compute** -- EC2/Docker/K8s providers exist but aren't tested for pilot
- **Multi-repo sessions** -- one repo per session for now
- **Control plane / multi-tenant** -- local mode only
- **Pre-engineering flows** -- no ideate/PRD stage yet
- **Dev-environment provisioning** -- no per-session docker-compose isolation

## Repo Config

Drop a `.ark.yaml` in your repo root to customize:

```yaml
# Run these before any stage can complete
verify:
  - "npm test"
  - "npm run lint"

# Auto-create PRs when agent completes (default: true)
auto_pr: true

# Auto-rebase before PR creation (default: true)
auto_rebase: true
```

## Troubleshooting

**Session stuck at "ready":** Check conductor and arkd are running:
```bash
curl localhost:19100/health   # conductor
curl localhost:19300/health   # arkd
```
If either is down, restart the TUI.

**Agent exits without advancing:** Check `ark session events <id>` for errors. Common cause: agent didn't commit its changes (completion is rejected without new commits).

**Port conflicts:** Kill stale processes:
```bash
lsof -ti:19100 | xargs kill   # conductor
lsof -ti:19300 | xargs kill   # arkd
```

## Feedback

File issues at https://github.com/ytarasova/ark/issues or ping in the team Slack channel.
