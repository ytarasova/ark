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

## SDLC Pipeline Agents

These agents are specialized for the Intent-to-Software Lifecycle (ISLC) pipeline. They run Jira-integrated workflows with structured artifacts at each stage.

### ticket-intake

Fetches a Jira ticket, validates it against an 11-field sanity gate, and extracts a 27-section specification for downstream stages.

| Field | Value |
|-------|-------|
| Model | `sonnet` |
| Max turns | 50 |
| Tools | Bash, Read, Write, Edit, Glob, Grep |
| Skills | sanity-gate, spec-extraction |
| Context | CLAUDE.md |

**System prompt summary**: Fetches the Jira ticket, runs the sanity gate (PASS/FAIL/WARN per field), extracts the 27-section spec to `.workflow/<ticket>/spec.md`, and persists state. Reports error if any sanity gate field fails.

**Used by flows**: islc, islc-quick

### spec-planner

Decomposes a specification into ordered, independently-executable subtasks and creates Jira sub-tasks.

| Field | Value |
|-------|-------|
| Model | `opus` |
| Max turns | 100 |
| Tools | Bash, Read, Write, Edit, Glob, Grep, WebSearch |
| MCP servers | atlassian |
| Memories | code-style, architecture |
| Context | CLAUDE.md |

**System prompt summary**: Reads the specification, breaks work into subtasks (max 4h each), creates Jira sub-tasks, writes an execution plan with dependency graph to `.workflow/<ticket>/plan.md`.

**Used by flows**: islc

### plan-auditor

Cross-checks the execution plan against the specification to verify every requirement is covered.

| Field | Value |
|-------|-------|
| Model | `sonnet` |
| Max turns | 50 |
| Tools | Bash, Read, Write, Edit, Glob, Grep |
| Skills | plan-audit |
| Context | CLAUDE.md |

**System prompt summary**: Extracts atomic requirements from the spec, maps them to subtasks, identifies coverage gaps. Produces AUDIT: PASS or AUDIT: FAIL with a coverage matrix in `.workflow/<ticket>/audit-report.md`.

**Used by flows**: islc (optional stage)

### task-implementer

Implements a single subtask from the ISLC execution plan. Runs as one of N parallel fan-out children.

| Field | Value |
|-------|-------|
| Model | `opus` |
| Max turns | 200 |
| Tools | Bash, Read, Write, Edit, Glob, Grep, WebSearch |
| Memories | code-style, architecture, testing-patterns |
| Context | CLAUDE.md, PLAN.md |

**System prompt summary**: Loads the plan and spec, transitions its Jira sub-task to "In Progress", implements the code changes with tests, creates atomic commits, then transitions the sub-task to "Done".

**Used by flows**: islc, islc-quick (fan-out execute stage)

### verifier

Runs multi-layered verification: tests, security scanning, code quality, AC validation, and optional design/UAT review.

| Field | Value |
|-------|-------|
| Model | `sonnet` |
| Max turns | 100 |
| Tools | Bash, Read, Write, Edit, Glob, Grep |
| Skills | security-scan, self-review |
| Memories | code-style, testing-patterns |
| Context | CLAUDE.md |

**System prompt summary**: Runs the full test suite, performs security scanning, checks code quality, validates acceptance criteria, and optionally compares against Figma designs. Writes `.workflow/<ticket>/verify-report.md` with verdict: PASS, FAIL, or PASS WITH WARNINGS.

**Used by flows**: islc, autonomous-sdlc

### closer

Finalizes the ISLC workflow by creating a PR, transitioning the Jira ticket, and publishing a Confluence implementation page.

| Field | Value |
|-------|-------|
| Model | `sonnet` |
| Max turns | 50 |
| Tools | Bash, Read, Write, Edit, Glob, Grep |
| MCP servers | atlassian |
| Context | CLAUDE.md |

**System prompt summary**: Runs a self-review checklist, pushes the branch, creates a structured PR via `gh pr create`, transitions the Jira ticket to "In Review", and publishes a 10-section Confluence implementation page.

**Used by flows**: islc, islc-quick, conditional

### retro

Automated retrospective agent that analyzes the completed ISLC workflow run and produces an actionable report.

| Field | Value |
|-------|-------|
| Model | `sonnet` |
| Max turns | 50 |
| Tools | Bash, Read, Write, Edit, Glob, Grep |
| MCP servers | atlassian |
| Context | CLAUDE.md |

**System prompt summary**: Reconstructs the workflow timeline, assesses spec/plan/execution quality (EXCELLENT/GOOD/NEEDS IMPROVEMENT), generates 3-7 improvement recommendations, and writes `.workflow/<ticket>/retro-report.md`. Optionally appends to the Confluence page.

**Used by flows**: islc (optional stage)

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
| Model | `gpt-5-codex` |
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

## Runtime Overrides

Agents declare a default runtime in their YAML (via the `runtime` field), but you can override it at dispatch time with the `--runtime` flag:

```bash
# Run implementer on its default runtime (claude)
ark session start --repo . --summary "Fix bug" --agent implementer --dispatch

# Override: run implementer on codex
ark session start --repo . --summary "Fix bug" --agent implementer --runtime codex --dispatch

# Override: run implementer on gemini
ark session start --repo . --summary "Fix bug" --agent implementer --runtime gemini --dispatch

# Override: run worker on goose
ark session start --repo . --summary "Fix bug" --agent worker --runtime goose --dispatch
```

Built-in runtimes: `claude`, `claude-max`, `codex`, `gemini`, `goose`. At dispatch, runtime config (type, command, task_delivery, env) is merged with agent config. Agent-level values take precedence.

## Runtime Billing Modes and Cost Tracking

Each runtime declares a `billing` section that controls how its usage is recorded in the `usage_records` table:

| Mode | `cost_usd` | Tokens recorded | Typical use |
|------|------------|-----------------|-------------|
| `api` | Per-token from PricingRegistry (300+ models, LiteLLM JSON) | Yes | `claude`, `codex`, `gemini` billed per request |
| `subscription` | `0` (fixed monthly) | Yes (for rate-limit tracking) | `claude-max` ($200/mo Max plan) |
| `free` | `0` | Yes | Local or zero-cost runtimes |

Regardless of cost mode, transcript-based token counts are always captured via the polymorphic `TranscriptParserRegistry` (Claude, Codex, Gemini parsers). The `cost_mode` column on each `usage_records` row records which mode was active, so dashboards can separate real API spend from subscription seats without losing usage volume.

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
