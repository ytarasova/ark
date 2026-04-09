# Ark Agents Reference

Complete reference for all builtin agent definitions. Agents are YAML files that define how Ark launches and configures AI coding agents. See the [User Guide](guide.md#agent-definitions) for an overview.

## Three-Tier Resolution

Agents resolve in priority order:

1. **Project**: `.ark/agents/<name>.yaml` in the repo
2. **Global**: `~/.ark/agents/<name>.yaml`
3. **Builtin**: `agents/<name>.yaml` shipped with Ark

Higher-priority agents shadow lower ones. Use `ark agent copy` to customize a builtin.

---

## Claude Code Agents

These agents use the default `claude-code` executor, which launches Claude Code in tmux with hooks and an MCP channel for status reporting.

### implementer

The primary coding agent. Reads the codebase, implements features or fixes, writes tests, and creates commits.

| Field | Value |
|-------|-------|
| Model | `opus` |
| Max turns | 200 |
| Tools | Bash, Read, Write, Edit, Glob, Grep, WebSearch |
| Memories | code-style, architecture, testing-patterns |
| Context | CLAUDE.md, PLAN.md |

**System prompt summary**: Follows PLAN.md if it exists, otherwise analyzes the ticket independently. Creates atomic commits and ensures tests pass. Asks (via AskUserQuestion) when encountering ambiguity.

**Used by flows**: default, quick, parallel, fan-out, dag-parallel, pr-review

### planner

Creates implementation plans. Reads the codebase, designs the approach, and writes a PLAN.md.

| Field | Value |
|-------|-------|
| Model | `sonnet` |
| Max turns | 50 |
| Tools | Bash, Read, Write, Edit, Glob, Grep, WebSearch |
| Memories | code-style, architecture |
| Context | CLAUDE.md |

**System prompt summary**: Identifies files to change, designs the implementation approach, writes PLAN.md with summary, files to modify, step-by-step plan, testing strategy, and risk assessment. Commits PLAN.md to the branch.

**Used by flows**: default, parallel, fan-out, dag-parallel, pr-review

### reviewer

Reviews code changes for quality, correctness, security, and standards compliance.

| Field | Value |
|-------|-------|
| Model | `sonnet` |
| Max turns | 50 |
| Tools | Bash, Read, Glob, Grep |
| Memories | code-style, review-checklist |
| Context | CLAUDE.md |

**System prompt summary**: Runs `git diff main...HEAD` and the test suite. Checks correctness, test coverage, code quality, security (OWASP top 10), performance, and documentation. Reports blocking issues or confirms approval.

**Used by flows**: default, parallel, fan-out, dag-parallel

### documenter

Updates documentation based on code changes.

| Field | Value |
|-------|-------|
| Model | `sonnet` |
| Max turns | 30 |
| Tools | Bash, Read, Write, Edit, Glob, Grep |
| Memories | doc-style |
| Context | CLAUDE.md |

**System prompt summary**: Reviews the diff and updates affected docs (README, API docs, architecture docs, inline comments). Only updates docs genuinely affected by changes. Does not create new doc files unless a wholly new feature needs one.

**Used by flows**: default (optional final stage)

### worker

General-purpose agent with no predefined system prompt. A blank slate for custom tasks.

| Field | Value |
|-------|-------|
| Model | `opus` |
| Max turns | 200 |
| Tools | Bash, Read, Write, Edit, Glob, Grep, WebSearch |
| Memories | none |
| Context | none |

**System prompt summary**: Empty. The task prompt from the flow stage or user provides all context.

**Used by flows**: bare, pr-review

---

## CLI Agents

These agents use the `cli-agent` executor, which launches third-party CLI tools in tmux with the same worktree isolation and session tracking as Claude Code agents.

### codex-worker

Runs OpenAI Codex CLI in full-auto mode.

| Field | Value |
|-------|-------|
| Runtime | `cli-agent` |
| Command | `codex --approval-mode full-auto` |
| Task delivery | `arg` (task appended as CLI argument) |
| Model | `o4-mini` |
| Max turns | 200 |

**Prerequisite**: `codex` CLI must be installed and authenticated.

### gemini-worker

Runs Google Gemini CLI.

| Field | Value |
|-------|-------|
| Runtime | `cli-agent` |
| Command | `gemini` |
| Task delivery | `stdin` (task piped via stdin) |
| Model | `gemini` |
| Max turns | 200 |

**Prerequisite**: `gemini` CLI must be installed and authenticated.

### aider-worker

Runs Aider AI pair programming tool.

| Field | Value |
|-------|-------|
| Runtime | `cli-agent` |
| Command | `aider --yes-always --no-git` |
| Task delivery | `arg` (task appended as CLI argument) |
| Model | `aider` |
| Max turns | 200 |

**Prerequisite**: `aider` must be installed (`pip install aider-chat`).

### generic-cli

Template for wrapping any CLI tool as an Ark agent. Copy and customize for your tool.

| Field | Value |
|-------|-------|
| Runtime | `cli-agent` |
| Command | `echo "Override this command..."` |
| Task delivery | `stdin` |
| Model | `custom` |
| Max turns | 200 |

**Usage**: Copy this agent and replace the `command` field:

```bash
ark agent copy generic-cli my-tool
# Edit to set your tool's command, task_delivery mode, etc.
```

---

## Agent YAML Fields

Full field reference for agent definition files.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Agent identifier (matches filename without extension) |
| `description` | string | yes | Short description shown in `ark agent list` |
| `model` | string | yes | Model alias: `opus`, `sonnet`, `haiku`, or tool-specific (e.g., `o4-mini`) |
| `max_turns` | number | yes | Maximum conversation turns before the agent stops |
| `system_prompt` | string | yes | System prompt text. Supports template variables (see below) |
| `tools` | string[] | yes | Claude tools the agent can use |
| `permission_mode` | string | yes | Claude permission mode (e.g., `bypassPermissions`) |
| `mcp_servers` | string[] | no | MCP server names to attach |
| `skills` | string[] | no | Skill names injected into the system prompt at dispatch |
| `memories` | string[] | no | Memory categories recalled at dispatch |
| `context` | string[] | no | Files included as context at dispatch |
| `env` | object | no | Environment variables exported before agent launch |
| `runtime` | string | no | Executor: `claude-code` (default), `cli-agent`, or `subprocess` |
| `command` | string[] | no | Command for `cli-agent` and `subprocess` runtimes |
| `task_delivery` | string | no | How task is sent to CLI agents: `stdin`, `file`, or `arg` (default) |

### Template Variables

These variables are substituted in `system_prompt` at dispatch time:

| Variable | Value |
|----------|-------|
| `{ticket}` | Session ticket reference (e.g., PROJ-123) |
| `{summary}` | Session task summary |
| `{workdir}` | Working directory path |
| `{repo}` | Repository name |
| `{branch}` | Git branch name |

---

## Managing Agents

```bash
ark agent list                         # List all agents (scope, name, model, tools)
ark agent show implementer             # Show full agent definition
ark agent create my-agent              # Create new agent (opens in $EDITOR)
ark agent create my-agent --global     # Create in ~/.ark/agents/
ark agent edit my-agent                # Edit existing agent
ark agent copy implementer fast-impl   # Copy agent for customization
ark agent copy implementer --global    # Copy to global scope
ark agent delete my-agent              # Delete custom agent (cannot delete builtins)
```

In the TUI, press `2` to switch to the Agents tab. Use `n` to create, `e` to edit, `c` to copy, `x` to delete.
