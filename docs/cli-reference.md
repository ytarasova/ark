# Ark CLI Reference

Complete reference for all `ark` commands. Run `ark --help` or `ark <command> --help` for built-in help.

## Global Options

```
ark [options] <command>
  -p, --profile <name>    Use a specific profile
  -V, --version           Show version
  -h, --help              Show help
```

---

## ark session

Manage SDLC flow sessions.

### ark session start

Create a new session.

```
ark session start [ticket] [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `-r, --repo <path>` | Repository path or name | -- |
| `-s, --summary <text>` | Task summary | -- |
| `-p, --flow <name>` | Flow name | `default` |
| `-c, --compute <name>` | Compute name | -- |
| `-g, --group <name>` | Group name | -- |
| `-d, --dispatch` | Auto-dispatch the first stage agent | -- |
| `-a, --attach` | Dispatch and attach to the session | -- |
| `--claude-session <id>` | Create from an existing Claude Code session | -- |
| `--recipe <name>` | Create session from a recipe template | -- |

Examples:

```bash
ark session start --repo . --summary "Add user auth" --dispatch
ark session start PROJ-123 --repo ./my-app --summary "Fix login bug" --flow quick
ark session start --recipe quick-fix --repo . --dispatch --attach
ark session start --claude-session abc12345 --flow bare
ark session start --repo . --summary "Task" --group backend
```

### ark session list

List all sessions.

```
ark session list [options]
```

| Option | Description |
|--------|-------------|
| `-s, --status <status>` | Filter by status (running/stopped/completed/failed/waiting/ready) |
| `-r, --repo <repo>` | Filter by repo |
| `-g, --group <group>` | Filter by group |

```bash
ark session list
ark session list --status running
ark session list --group backend
```

### ark session show

Show session details.

```
ark session show <id>
```

```bash
ark session show s-a1b2c3
```

### ark session dispatch

Dispatch the agent for the current stage.

```
ark session dispatch <id>
```

```bash
ark session dispatch s-a1b2c3
```

### ark session stop

Stop a running session.

```
ark session stop <id>
```

```bash
ark session stop s-a1b2c3
```

### ark session resume

Resume a stopped or paused session.

```
ark session resume <id>
```

```bash
ark session resume s-a1b2c3
```

### ark session advance

Advance to the next flow stage.

```
ark session advance <id> [options]
```

| Option | Description |
|--------|-------------|
| `-f, --force` | Force past gate |

```bash
ark session advance s-a1b2c3
ark session advance s-a1b2c3 --force
```

### ark session complete

Mark the current stage as done and advance.

```
ark session complete <id>
```

```bash
ark session complete s-a1b2c3
```

### ark session pause

Pause a session with an optional reason.

```
ark session pause <id> [options]
```

| Option | Description |
|--------|-------------|
| `-r, --reason <text>` | Reason for pausing |

```bash
ark session pause s-a1b2c3 --reason "Waiting for API keys"
```

### ark session attach

Attach to a running agent session (opens tmux).

```
ark session attach <id>
```

If the session is not running, it will be dispatched first.

```bash
ark session attach s-a1b2c3
```

### ark session output

Show live output from a running session.

```
ark session output <id> [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `-n, --lines <n>` | Number of lines | `30` |

```bash
ark session output s-a1b2c3
ark session output s-a1b2c3 -n 100
```

### ark session send

Send a message to a running Claude session.

```
ark session send <id> <message>
```

```bash
ark session send s-a1b2c3 "Focus on the API layer first"
```

### ark session fork

Fork a session (branches the conversation).

```
ark session fork <id> [options]
```

| Option | Description |
|--------|-------------|
| `-t, --task <text>` | Task description for forked session |
| `-g, --group <name>` | Group for forked session |
| `-d, --dispatch` | Auto-dispatch the forked session |

```bash
ark session fork s-a1b2c3 --task "Try approach B" --dispatch
```

### ark session clone

Alias for `fork`.

```
ark session clone <id> [options]
```

Same options as `fork`.

### ark session handoff

Hand off to a different agent mid-session.

```
ark session handoff <id> <agent> [options]
```

| Option | Description |
|--------|-------------|
| `-i, --instructions <text>` | Handoff instructions for the new agent |

```bash
ark session handoff s-a1b2c3 reviewer --instructions "Focus on security"
```

### ark session spawn

Spawn a child session for parallel work (parent waits for children).

```
ark session spawn <parent-id> <task>
```

```bash
ark session spawn s-parent "Implement feature A"
ark session spawn s-parent "Implement feature B"
```

### ark session join

Join all forked children back to the parent.

```
ark session join <parent-id> [options]
```

| Option | Description |
|--------|-------------|
| `-f, --force` | Force join even if children are not complete |

```bash
ark session join s-parent
ark session join s-parent --force
```

### ark session events

Show event history for a session.

```
ark session events <id>
```

```bash
ark session events s-a1b2c3
```

### ark session delete

Delete one or more sessions (soft delete with 90s undo window).

```
ark session delete <ids...>
```

```bash
ark session delete s-a1b2c3
ark session delete s-aaa s-bbb s-ccc    # Delete multiple
```

### ark session undelete

Restore a recently deleted session (within 90 seconds).

```
ark session undelete <id>
```

```bash
ark session undelete s-a1b2c3
```

### ark session group

Assign a session to a group.

```
ark session group <id> <group>
```

```bash
ark session group s-a1b2c3 backend
```

### ark session export

Export a session to a JSON file.

```
ark session export <id> [file]
```

Default output file: `session-<id>.json`

```bash
ark session export s-a1b2c3
ark session export s-a1b2c3 backup.json
```

### ark session import

Import a session from a JSON file.

```
ark session import <file>
```

```bash
ark session import session-s-a1b2c3.json
```

---

## ark worktree

Git worktree operations.

### ark worktree list

List sessions with active worktrees.

```
ark worktree list
```

### ark worktree finish

Merge worktree branch, remove worktree, and delete session.

```
ark worktree finish <session-id> [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--into <branch>` | Target branch to merge into | `main` |
| `--no-merge` | Skip merge, just remove worktree and delete session | -- |
| `--keep-branch` | Do not delete the branch after merge | -- |

```bash
ark worktree finish s-a1b2c3
ark worktree finish s-a1b2c3 --into develop
ark worktree finish s-a1b2c3 --no-merge
ark worktree finish s-a1b2c3 --keep-branch
```

---

## ark costs

Show cost summary across sessions.

```
ark costs [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `-n, --limit <n>` | Number of sessions to show | `20` |

```bash
ark costs
ark costs --limit 50
```

---

## ark try

Run a one-shot sandboxed session that auto-cleans up when done.

```
ark try <task> [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--image <image>` | Docker image | `ubuntu:22.04` |

```bash
ark try "Run the test suite and fix any failures"
ark try "Refactor the auth module" --image node:20
```

---

## ark exec

Run a session non-interactively (for CI/CD pipelines).

```
ark exec [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `-r, --repo <path>` | Repository path | `.` |
| `-s, --summary <text>` | Task summary | -- |
| `-t, --ticket <key>` | Ticket reference | -- |
| `-f, --flow <name>` | Flow name | `bare` |
| `-c, --compute <name>` | Compute target | -- |
| `-g, --group <name>` | Group name | -- |
| `-a, --autonomy <level>` | Autonomy: full/execute/edit/read-only | -- |
| `-o, --output <format>` | Output: text/json | `text` |
| `--timeout <seconds>` | Timeout in seconds (0 = unlimited) | `0` |

```bash
ark exec --summary "Run linter" --flow bare
ark exec --summary "Fix tests" --timeout 300 --output json
```

---

## ark config

Open Ark configuration in your editor.

```
ark config [options]
```

| Option | Description |
|--------|-------------|
| `--path` | Print the config file path instead of opening editor |

```bash
ark config                    # Opens ~/.ark/config.yaml in $EDITOR
ark config --path             # Prints: /Users/you/.ark/config.yaml
```

---

## ark web

Start the web dashboard.

```
ark web [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--port <port>` | Listen port | `8420` |
| `--read-only` | Read-only mode (no mutations) | -- |
| `--token <token>` | Bearer token for authentication | -- |

```bash
ark web
ark web --port 9000
ark web --read-only
ark web --token my-secret-token
```

---

## ark profile

Manage profiles (isolated session namespaces).

### ark profile list

List all profiles.

```
ark profile list
```

### ark profile create

Create a new profile.

```
ark profile create <name> [description]
```

```bash
ark profile create work "Work projects"
ark profile create personal
```

### ark profile delete

Delete a profile.

```
ark profile delete <name>
```

```bash
ark profile delete old-profile
```

---

## ark search

Search across sessions, events, messages, and transcripts.

```
ark search <query> [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `-l, --limit <n>` | Max results | `20` |
| `-t, --transcripts` | Also search Claude transcripts (slower) | -- |
| `--index` | Rebuild transcript search index before searching | -- |
| `--hybrid` | Use hybrid search (memory + knowledge + transcripts with LLM re-ranking) | -- |

```bash
ark search "authentication"
ark search "auth" --transcripts
ark search "auth" --index --transcripts
ark search "auth" --limit 50
ark search "auth" --hybrid
```

---

## ark search-all

Search across all Claude Code conversations on disk (not just Ark sessions).

```
ark search-all <query> [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `-n, --limit <n>` | Max results | `20` |
| `--days <n>` | Recent days to search | `90` |

```bash
ark search-all "database migration"
ark search-all "error" --days 30
ark search-all "refactor" --limit 50
```

---

## ark index

Build or rebuild the transcript full-text search (FTS5) index.

```
ark index
```

```bash
ark index
```

---

## ark agent

Manage agent definitions.

### ark agent list

List all available agents.

```
ark agent list [options]
```

| Option | Description |
|--------|-------------|
| `--project <dir>` | Project root directory |

Output columns: scope (P=project, G=global, B=builtin), name, model, tool count, MCP count, skill count, memory count, description.

```bash
ark agent list
```

### ark agent show

Show agent details.

```
ark agent show <name>
```

```bash
ark agent show implementer
```

### ark agent create

Create a new agent definition (opens in editor).

```
ark agent create <name> [options]
```

| Option | Description |
|--------|-------------|
| `--global` | Save to `~/.ark/agents/` instead of project |

```bash
ark agent create my-agent
ark agent create shared-agent --global
```

### ark agent edit

Edit an agent definition in your editor.

```
ark agent edit <name>
```

If the agent is builtin, you will be prompted to copy it to project or global scope first.

```bash
ark agent edit my-agent
```

### ark agent copy

Copy an agent for customization.

```
ark agent copy <name> [new-name] [options]
```

| Option | Description |
|--------|-------------|
| `--global` | Save to `~/.ark/agents/` instead of project |

```bash
ark agent copy implementer fast-impl
ark agent copy implementer --global
```

### ark agent delete

Delete a custom agent (cannot delete builtins).

```
ark agent delete <name>
```

```bash
ark agent delete my-agent
```

---

## ark flow

Manage flow definitions.

### ark flow list

List all available flows.

```
ark flow list
```

### ark flow show

Show flow definition with stages.

```
ark flow show <name>
```

```bash
ark flow show default
ark flow show quick
```

---

## ark skill

Manage skill definitions.

### ark skill list

List available skills.

```
ark skill list
```

### ark skill show

Show skill details and prompt content.

```
ark skill show <name>
```

```bash
ark skill show code-review
```

### ark skill create

Create a new skill, either inline or from a YAML file.

```
ark skill create [name] [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--from <file>` | Create from YAML file (name taken from YAML) | -- |
| `-p, --prompt <prompt>` | Skill prompt (required unless --from) | -- |
| `-d, --description <desc>` | Skill description | -- |
| `-s, --scope <scope>` | Scope: global or project | `global` |
| `--tags <tags>` | Comma-separated tags | -- |

```bash
ark skill create my-skill -p "Review for security issues" -d "Security review" --tags security,review
ark skill create --from skill.yaml
ark skill create my-skill -p "Prompt text" --scope project
```

### ark skill delete

Delete a skill. Cannot delete builtin skills.

```
ark skill delete <name> [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `-s, --scope <scope>` | Scope: global or project | `global` |

```bash
ark skill delete my-skill
ark skill delete my-skill --scope project
```

---

## ark recipe

Manage recipe templates.

### ark recipe list

List available recipes.

```
ark recipe list
```

### ark recipe show

Show recipe details, including variables.

```
ark recipe show <name>
```

```bash
ark recipe show quick-fix
```

### ark recipe create

Create a new recipe from a YAML file or from an existing session.

```
ark recipe create [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--from <file>` | Create from YAML file | -- |
| `--from-session <id>` | Create from existing session | -- |
| `-n, --name <name>` | Recipe name (required with --from-session) | -- |
| `-s, --scope <scope>` | Scope: global or project | `global` |

Must specify either `--from` or `--from-session`.

```bash
ark recipe create --from recipe.yaml
ark recipe create --from-session s-a1b2c3 --name my-recipe
ark recipe create --from recipe.yaml --scope project
```

### ark recipe delete

Delete a recipe. Cannot delete builtin recipes.

```
ark recipe delete <name> [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `-s, --scope <scope>` | Scope: global or project | `global` |

```bash
ark recipe delete my-recipe
ark recipe delete my-recipe --scope project
```

---

## ark compute

Manage compute resources.

### ark compute create

Create a new compute resource.

```
ark compute create <name> [options]
```

**General options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--provider <type>` | Provider type: docker, ec2 | `local` |

**EC2 options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--size <size>` | Instance size: xs/s/m/l/xl/xxl/xxxl | `m` |
| `--arch <arch>` | Architecture: x64, arm | `x64` |
| `--region <region>` | AWS region | `us-east-1` |
| `--profile <profile>` | AWS profile | -- |
| `--subnet-id <id>` | Subnet ID | -- |
| `--tag <key=value>` | Tag (repeatable) | -- |

**Docker options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--image <image>` | Docker image | `ubuntu:22.04` |
| `--devcontainer` | Use devcontainer.json from project | -- |
| `--volume <mount>` | Extra volume mount (repeatable) | -- |

```bash
ark compute create my-ec2 --provider ec2 --size m --region us-east-1
ark compute create my-docker --provider docker --image node:20
ark compute create my-dev --provider docker --devcontainer
```

### ark compute list

List all compute resources.

```
ark compute list
```

### ark compute provision

Provision infrastructure for a compute resource.

```
ark compute provision <name>
```

```bash
ark compute provision my-ec2
```

### ark compute start

Start a stopped compute resource.

```
ark compute start <name>
```

### ark compute stop

Stop a running compute resource.

```
ark compute stop <name>
```

### ark compute destroy

Tear down infrastructure (but keep database record).

```
ark compute destroy <name>
```

### ark compute delete

Remove compute record from the database. Must be stopped/destroyed first.

```
ark compute delete <name>
```

### ark compute status

Show compute details and metrics.

```
ark compute status <name>
```

### ark compute metrics

Show detailed metrics (CPU, memory, disk, network, uptime).

```
ark compute metrics <name>
```

### ark compute ssh

SSH into a remote compute resource.

```
ark compute ssh <name>
```

### ark compute sync

Sync environment files to/from compute.

```
ark compute sync <name> [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--direction <dir>` | Sync direction: push/pull | `push` |

```bash
ark compute sync my-ec2
ark compute sync my-ec2 --direction pull
```

### ark compute update

Update compute configuration.

```
ark compute update <name> [options]
```

| Option | Description |
|--------|-------------|
| `--size <size>` | Instance size |
| `--arch <arch>` | Architecture |
| `--region <region>` | AWS region |
| `--profile <profile>` | AWS profile |
| `--subnet-id <id>` | Subnet ID |
| `--ingress <cidrs>` | SSH ingress CIDRs (comma-separated, or 'open') |
| `--idle-minutes <min>` | Idle shutdown timeout in minutes |
| `--set <key=value>` | Set arbitrary config key (repeatable) |

```bash
ark compute update my-ec2 --size l
ark compute update my-ec2 --ingress open
ark compute update my-ec2 --idle-minutes 30
```

### ark compute default

Set the default compute resource. Persists the choice to `~/.ark/.env` so it survives restarts.

```
ark compute default <name>
```

```bash
ark compute default my-ec2
```

---

## ark conductor

Conductor operations.

### ark conductor start

Start the conductor server.

```
ark conductor start [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `-p, --port <port>` | Port | `19100` |

### ark conductor learnings

Show conductor learnings and policies.

```
ark conductor learnings
```

### ark conductor learn

Record a conductor learning manually.

```
ark conductor learn <title> [description]
```

```bash
ark conductor learn "Always run tests before merge" "Catches regressions early"
```

### ark conductor bridge

Start the messaging bridge (Telegram/Slack/Discord).

```
ark conductor bridge
```

Requires `~/.ark/bridge.json` to be configured.

### ark conductor notify

Send a test notification via the messaging bridge.

```
ark conductor notify <message>
```

```bash
ark conductor notify "Deploy completed successfully"
```

---

## ark schedule

Manage scheduled recurring sessions.

### ark schedule add

Create a recurring scheduled session.

```
ark schedule add [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--cron <expression>` | Cron expression (required) | -- |
| `-f, --flow <name>` | Flow name | `bare` |
| `-r, --repo <path>` | Repository path | -- |
| `-s, --summary <text>` | Session summary | -- |
| `-c, --compute <name>` | Compute name | -- |
| `-g, --group <name>` | Group name | -- |

```bash
ark schedule add --cron "0 2 * * *" --summary "Nightly tests" --repo . --flow bare
ark schedule add --cron "0 9 * * 1" --summary "Weekly review" --repo .
```

### ark schedule list

List all schedules.

```
ark schedule list
```

### ark schedule enable

Enable a schedule.

```
ark schedule enable <id>
```

### ark schedule disable

Disable a schedule.

```
ark schedule disable <id>
```

### ark schedule delete

Delete a schedule.

```
ark schedule delete <id>
```

---

## ark tui

Launch the terminal UI dashboard.

```
ark tui
```

See [TUI Reference](tui-reference.md) for keyboard shortcuts.

---

## ark arkd

Start the ArkD universal agent daemon.

```
ark arkd [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `-p, --port <port>` | Port | `19300` |
| `--conductor-url <url>` | Conductor URL for channel relay | `http://localhost:19100` |

```bash
ark arkd
ark arkd --port 19400 --conductor-url http://localhost:19100
```

---

## ark auth

Set up Claude authentication.

```
ark auth [options]
```

| Option | Description |
|--------|-------------|
| `--host <name>` | Run setup-token on a specific remote compute instead of local |

```bash
ark auth                        # Local auth setup
ark auth --host my-ec2          # Remote auth setup
```

---

## ark claude

Interact with Claude Code sessions.

### ark claude list

List Claude Code sessions found on disk.

```
ark claude list [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `-p, --project <filter>` | Filter by project path | -- |
| `-l, --limit <n>` | Max results | `20` |

```bash
ark claude list
ark claude list --project /Users/me/my-project
```

---

## ark watch

Watch GitHub issues with a label and auto-create sessions.

```
ark watch [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `-l, --label <label>` | GitHub label to watch | `ark` |
| `-d, --dispatch` | Auto-dispatch created sessions | -- |
| `-i, --interval <ms>` | Poll interval in milliseconds | `60000` |

```bash
ark watch --label ark --dispatch
ark watch --label ark --dispatch --interval 30000
```

---

## ark pr

Manage PR-bound sessions.

### ark pr list

List sessions bound to PRs.

```
ark pr list
```

### ark pr status

Show session bound to a specific PR URL.

```
ark pr status <pr-url>
```

```bash
ark pr status https://github.com/org/repo/pull/123
```

---

## ark mcp-proxy

Internal command: bridge stdin/stdout to a pooled MCP socket.

```
ark mcp-proxy <socket-path>
```

This is used internally by the MCP socket pooling system. You do not need to call it directly.

---

## ark channel

Run the MCP channel server (used by remote agents). Internal command.

```
ark channel
```

---

## ark server

JSON-RPC protocol server.

### ark server start

Start the Ark protocol server.

```
ark server start [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--stdio` | Use stdio transport (JSONL) | -- |
| `--ws` | Use WebSocket transport | default |
| `-p, --port <port>` | WebSocket port | `19400` |

Examples:

```bash
ark server start                   # WebSocket on port 19400
ark server start --stdio           # JSONL over stdin/stdout
ark server start --port 9000       # Custom port
```

The TUI and CLI embed the server in-process. Start it explicitly only for external clients.

---

## ark memory

Cross-session persistent knowledge.

### ark memory list

List stored memories.

```
ark memory list [options]
```

| Option | Description |
|--------|-------------|
| `--scope <scope>` | Filter by scope (e.g., "global", "project/myapp") |

### ark memory recall

Search memories by query.

```
ark memory recall <query> [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--scope <scope>` | Limit to scope | all |
| `--limit <n>` | Max results | 10 |

### ark memory forget

Delete a memory entry.

```
ark memory forget <id>
```
