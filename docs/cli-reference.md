# Ark CLI Reference

> Auto-generated from the Commander.js tree. Run `make docs-cli` to regenerate.

> Version: 0.21.10

## Usage

```
ark [options] <command>
```

## Global Options

| Flag | Description |
|------|-------------|
| `-p, --profile <name>` | Use a specific profile |
| `--server <url>` | Connect to a remote Ark control plane (e.g. https://ark.company.com) |
| `--token <key>` | API key for authentication with the remote server |

## Commands

| Command | Description |
|---------|-------------|
| [`ark session`](#ark-session) | Manage SDLC flow sessions |
| [`ark compute`](#ark-compute) | Manage compute resources |
| [`ark agent`](#ark-agent) | Manage agent definitions |
| [`ark flow`](#ark-flow) | Manage flows |
| [`ark skill`](#ark-skill) | Manage skills |
| [`ark recipe`](#ark-recipe) | Manage recipes |
| [`ark schedule`](#ark-schedule) | Manage scheduled recurring sessions |
| [`ark trigger`](#ark-trigger) | Manage trigger configurations (webhook / schedule / poll) |
| [`ark worktree`](#ark-worktree) | Git worktree operations |
| [`ark search`](#ark-search) | Search across sessions, events, messages, and transcripts |
| [`ark index`](#ark-index) | Build or rebuild the transcript search index |
| [`ark search-all`](#ark-search-all) | Search across all Claude conversations |
| [`ark memory`](#ark-memory) | Manage cross-session memory (backed by knowledge graph) |
| [`ark profile`](#ark-profile) | Manage profiles |
| [`ark conductor`](#ark-conductor) | Conductor operations |
| [`ark router`](#ark-router) | LLM routing proxy |
| [`ark runtime`](#ark-runtime) | Manage runtime definitions |
| [`ark auth`](#ark-auth) | Manage authentication and API keys |
| [`ark tenant`](#ark-tenant) | Manage tenant settings |
| [`ark team`](#ark-team) | Manage teams + memberships |
| [`ark user`](#ark-user) | Manage user identities |
| [`ark knowledge`](#ark-knowledge) | Knowledge graph - search, index, remember, export |
| [`ark code-intel`](#ark-code-intel) | Unified code-intelligence store (search, index, repos, runs) |
| [`ark workspace`](#ark-workspace) | Manage workspaces (tenant -> workspace -> repo) |
| [`ark eval`](#ark-eval) | Agent performance evaluation |
| [`ark dashboard`](#ark-dashboard) | Show fleet status, costs, and recent activity |
| [`ark costs`](#ark-costs) | Show cost summary across sessions |
| [`ark costs-sync`](#ark-costs-sync) | Backfill cost data from transcripts (on the daemon host) |
| [`ark costs-export`](#ark-costs-export) | Export cost data |
| [`ark server`](#ark-server) | JSON-RPC server |
| [`ark exec`](#ark-exec) | Run a session non-interactively (for CI/CD) |
| [`ark try`](#ark-try) | Run a one-shot sandboxed session (auto-cleans up) |
| [`ark daemon`](#ark-daemon) | Manage the arkd agent daemon |
| [`ark pr`](#ark-pr) | Manage PR-bound sessions |
| [`ark watch`](#ark-watch) | Watch GitHub issues with a label and auto-create sessions |
| [`ark claude`](#ark-claude) | Interact with Claude Code sessions |
| [`ark doctor`](#ark-doctor) | Check system prerequisites |
| [`ark arkd`](#ark-arkd) | Start the arkd agent daemon |
| [`ark channel`](#ark-channel) | Run the MCP channel server (used by remote agents) |
| [`ark run-agent-sdk`](#ark-run-agent-sdk) | Run the agent-sdk launch script (internal -- used by agent-sdk executor) |
| [`ark config`](#ark-config) | Open Ark config in your editor |
| [`ark web`](#ark-web) | Start web dashboard |
| [`ark openapi`](#ark-openapi) | Generate OpenAPI spec |
| [`ark mcp-proxy`](#ark-mcp-proxy) | Bridge stdin/stdout to a pooled MCP socket (internal) |
| [`ark acp`](#ark-acp) | Start headless ACP server on stdin/stdout (JSON-RPC) |
| [`ark repo-map`](#ark-repo-map) | Generate repository structure map |
| [`ark init`](#ark-init) | Initialize Ark for this repository |
| [`ark db`](#ark-db) | Schema migrations + status |
| [`ark secrets`](#ark-secrets) | Manage tenant-scoped secrets (env vars for sessions) |
| [`ark cluster`](#ark-cluster) | List Kubernetes clusters visible to this tenant |

## `ark session`

Manage SDLC flow sessions

**Synopsis:** `ark session`

### `ark session start`

Start a new session

**Synopsis:** `ark session start [options] [ticket]`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `ticket` | no | External ticket reference (Jira key, GitHub issue, etc.) |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-r, --repo <path>` |  | Repository path or name |
| `--remote-repo <url>` |  | Git URL to clone on compute target (no local repo needed) |
| `-b, --branch <name>` |  | Deterministic branch name for the worktree (default: derived from --ticket/--summary or auto) |
| `-s, --summary <text>` |  | Task summary |
| `-p, --flow <name-or-path>` | `"default"` | Flow name OR a path to an inline flow YAML. Paths ending in .yaml/.yml are read + parsed and forwarded as an inline flow definition; bare names hit the FlowStore. |
| `-c, --compute <name>` |  | Compute name |
| `-g, --group <name>` |  | Group name |
| `-a, --attach` |  | Attach to the session's tmux pane after starting |
| `--claude-session <id>` |  | Create from an existing Claude Code session (use 'ark claude list' to find IDs) |
| `--recipe <name>` |  | Create session from a recipe template |
| `--max-budget <usd>` |  | Cumulative cost cap for this session in USD. Halts for_each if exceeded. |
| `--with-mcp <name>` | `[]` | Mount an additional MCP server into the session (repeatable). Resolves against shipped mcp-configs/<name>.json or an inline path. |
| `--file <role=path>` | `{}` | Attach a named file input (repeatable). Path is resolved absolute and exposed to agents + flows as {inputs.files.<role>}. |
| `--param <k=value>` | `{}` | Add a named input (repeatable). Exposed as {inputs.<k>}. Value is parsed as JSON when possible (arrays, objects, numbers, booleans, null) and falls back to a string otherwise. Use for any flow-declared input -- scalars, lists, nested objects. |

### `ark session spawn`

Spawn a child session for parallel work

**Synopsis:** `ark session spawn [options] <parent-id> <task>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `parent-id` | yes |  |
| `task` | yes |  |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-a, --agent <agent>` |  | Agent override |
| `-m, --model <model>` |  | Model override (e.g., haiku, sonnet, opus) |

### `ark session spawn-subagent`

Spawn a subagent with optional model/agent override

**Synopsis:** `ark session spawn-subagent [options] <parent-id> <task>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `parent-id` | yes |  |
| `task` | yes |  |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-m, --model <model>` |  | Model override (e.g., haiku, sonnet, opus) |
| `-a, --agent <agent>` |  | Agent override |
| `-g, --group <name>` |  | Group name |

### `ark session list`

List all sessions

**Synopsis:** `ark session list [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-s, --status <status>` |  | Filter by status |
| `-r, --repo <repo>` |  | Filter by repo |
| `-g, --group <group>` |  | Filter by group |
| `--archived` |  | Include archived sessions |

### `ark session show`

Show session details

**Synopsis:** `ark session show <id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes | Session ID |

### `ark session attach`

Attach to a running agent session

**Synopsis:** `ark session attach [options] <id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes |  |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--print-only` |  | Print the attach command instead of running it |

### `ark session output`

Show live output from a running session

**Synopsis:** `ark session output [options] <id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes |  |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-n, --lines <n>` | `"30"` | Number of lines |

### `ark session events`

Show event history

**Synopsis:** `ark session events [options] <id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes |  |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--iteration <n>` |  | Filter to events for a specific for_each iteration (by index) |
| `--summary` |  | Print one summary line per completed for_each iteration instead of individual events |

### `ark session stop`

Stop a session

**Synopsis:** `ark session stop <id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes |  |

### `ark session resume`

Resume a stopped/paused session (restores snapshot when available)

**Synopsis:** `ark session resume [options] <id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes |  |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--snapshot-id <id>` |  | Restore from a specific snapshot id (defaults to the session's latest) |

### `ark session advance`

Advance to the next flow stage

**Synopsis:** `ark session advance [options] <id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes |  |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-f, --force` |  | Force past gate |

### `ark session approve`

Approve a review gate and advance to the next stage

**Synopsis:** `ark session approve <id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes |  |

### `ark session reject`

Reject a review gate and dispatch a rework cycle with the given reason

**Synopsis:** `ark session reject [options] <id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes |  |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-r, --reason <text>` |  | Why the change needs rework (shown to the agent) *(required)* |

### `ark session complete`

Mark current stage done and advance

**Synopsis:** `ark session complete [options] <id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes |  |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--force` |  | Skip verification checks |

### `ark session pause`

Pause a session (persists a snapshot when the compute supports it)

**Synopsis:** `ark session pause [options] <id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes |  |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-r, --reason <text>` |  |  |

### `ark session interrupt`

Interrupt a running agent (Ctrl+C) without killing the session

**Synopsis:** `ark session interrupt <id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes | Session ID |

### `ark session archive`

Archive a session for later reference

**Synopsis:** `ark session archive <id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes | Session ID |

### `ark session restore`

Restore an archived session

**Synopsis:** `ark session restore <id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes | Session ID |

### `ark session send`

Send a message to a running Claude session

**Synopsis:** `ark session send <id> <message>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes |  |
| `message` | yes |  |

### `ark session undelete`

Restore a recently deleted session (within 90s)

**Synopsis:** `ark session undelete <id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes |  |

### `ark session todo`

Manage session verification todos

**Synopsis:** `ark session todo <action> <session-id> [text]`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `action` | yes | add|list|done|delete |
| `session-id` | yes | Session ID |
| `text` | no | Todo content (for add) or todo ID (for done/delete) |

### `ark session verify`

Run verification scripts for a session

**Synopsis:** `ark session verify <id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes | Session ID |

### `ark session handoff`

Hand off to a different agent

**Synopsis:** `ark session handoff [options] <id> <agent>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes |  |
| `agent` | yes |  |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-i, --instructions <text>` |  |  |

### `ark session join`

Join all forked children

**Synopsis:** `ark session join [options] <parent-id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `parent-id` | yes |  |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-f, --force` |  |  |

### `ark session delete`

Delete sessions

**Synopsis:** `ark session delete <ids...>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `ids...` | yes |  |

### `ark session group`

Assign a session to a group

**Synopsis:** `ark session group <id> <group>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes |  |
| `group` | yes |  |

### `ark session fork`

Fork a session (branches the conversation)

**Synopsis:** `ark session fork [options] <id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes |  |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-t, --task <text>` |  | Task description for forked session |
| `-g, --group <name>` |  | Group for forked session |

### `ark session clone`

Alias for fork (branches the conversation)

**Synopsis:** `ark session clone [options] <id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes |  |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-t, --task <text>` |  | Task description for forked session |
| `-g, --group <name>` |  | Group for forked session |

### `ark session export`

Export session to file

**Synopsis:** `ark session export <id> [file]`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes |  |
| `file` | no |  |

### `ark session import`

Import session from file

**Synopsis:** `ark session import <file>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `file` | yes |  |

## `ark compute`

Manage compute resources

**Synopsis:** `ark compute`

### `ark compute create`

Create a new compute resource (concrete target or reusable template)

**Synopsis:** `ark compute create [options] <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Compute name |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--compute <kind>` |  | Compute kind (local, firecracker, ec2, k8s, k8s-kata) |
| `--runtime <kind>` |  | Runtime kind (direct, docker, compose, devcontainer, firecracker-in-container) |
| `--provider <type>` |  | [deprecated] Provider type (local, docker, ec2, k8s, k8s-kata). Use --compute + --runtime. |
| `--template` |  | Create a reusable template (blueprint) instead of a concrete compute target |
| `--no-prompt` |  | Skip interactive prompts (fail if required fields are missing) |
| `--image <image>` |  | Docker image (default: ubuntu:22.04) |
| `--devcontainer` |  | Use devcontainer.json from project |
| `--volume <mount>` | `[]` | Extra volume mount (repeatable) |
| `--size <size>` | `"m"` | Instance size: xs (2vCPU/8GB), s (4/16), m (8/32), l (16/64), xl (32/128), xxl (48/192), xxxl (64/256) |
| `--arch <arch>` | `"x64"` | Architecture: x64, arm |
| `--region <region>` | `"us-east-1"` | Region |
| `--profile <profile>` |  | AWS profile |
| `--subnet-id <id>` |  | Subnet ID |
| `--tag <key=value>` | `[]` | Tag (repeatable) |
| `--context <name>` |  | Kubeconfig context (cluster) -- required |
| `--namespace <ns>` |  | K8s namespace -- required |
| `--kubeconfig <path>` |  | Path to kubeconfig (default: in-cluster or ~/.kube/config) |
| `--service-account <sa>` |  | Pod service account name (for IRSA, etc.) |
| `--runtime-class <class>` |  | K8s runtime class (e.g. kata-fc for Firecracker) |
| `--cpu <amt>` |  | CPU request/limit (e.g. 2 or 500m) |
| `--memory <amt>` |  | Memory request/limit (e.g. 4Gi) |
| `--from-template <name>` |  | Use a compute template as defaults |

### `ark compute provision`

Provision a compute resource (create infrastructure)

**Synopsis:** `ark compute provision <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Compute name |

### `ark compute start`

Start a compute resource

**Synopsis:** `ark compute start <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Compute name |

### `ark compute stop`

Stop a compute resource

**Synopsis:** `ark compute stop <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Compute name |

### `ark compute destroy`

Destroy a compute resource (removes infrastructure and DB record)

**Synopsis:** `ark compute destroy <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Compute name |

### `ark compute update`

Update compute configuration

**Synopsis:** `ark compute update [options] <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Compute name |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--size <size>` |  | Instance size |
| `--arch <arch>` |  | Architecture: x64, arm |
| `--region <region>` |  | AWS region |
| `--profile <profile>` |  | AWS profile |
| `--subnet-id <id>` |  | Subnet ID |
| `--ingress <cidrs>` |  | SSH ingress CIDRs (comma-separated, or 'open' for 0.0.0.0/0) |
| `--idle-minutes <min>` |  | Idle shutdown timeout in minutes |
| `--set <key=value>` | `[]` | Set arbitrary config key |

### `ark compute list`

List compute targets and templates

**Synopsis:** `ark compute list [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--templates-only` |  | Only list templates (reusable config blueprints) |
| `--concrete-only` |  | Only list concrete compute targets |

### `ark compute status`

Show compute details

**Synopsis:** `ark compute status <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Compute name |

### `ark compute sync`

Sync environment to/from compute

**Synopsis:** `ark compute sync [options] <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Compute name |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--direction <dir>` | `"push"` | Sync direction (push|pull) |

### `ark compute metrics`

Show compute metrics

**Synopsis:** `ark compute metrics <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Compute name |

### `ark compute default`

Set default compute

**Synopsis:** `ark compute default <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Compute name |

### `ark compute ssh`

SSH into a compute

**Synopsis:** `ark compute ssh <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Compute name |

### `ark compute pool`

Manage compute pools

**Synopsis:** `ark compute pool`

#### `ark compute pool create`

Create a compute pool

**Synopsis:** `ark compute pool create [options] <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Pool name |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--provider <type>` | `"ec2"` | Provider type (ec2, docker, k8s) |
| `--min <n>` | `"0"` | Minimum warm instances |
| `--max <n>` | `"10"` | Maximum instances |
| `--size <size>` | `"m"` | Instance size (provider-specific) |
| `--region <region>` |  | Region (provider-specific) |
| `--image <image>` |  | Container image (provider-specific) |

#### `ark compute pool list`

List compute pools

**Synopsis:** `ark compute pool list`

#### `ark compute pool delete`

Delete a compute pool

**Synopsis:** `ark compute pool delete <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Pool name |

### `ark compute template`

Manage compute templates

**Synopsis:** `ark compute template`

#### `ark compute template list`

List compute templates

**Synopsis:** `ark compute template list`

#### `ark compute template show`

Show a compute template

**Synopsis:** `ark compute template show <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Template name |

#### `ark compute template create`

Create a compute template (convenience alias for 'compute create --template')

**Synopsis:** `ark compute template create [options] <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Template name |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--provider <type>` | `"ec2"` | Provider type |
| `--description <desc>` |  | Description |
| `--size <size>` |  | Instance size (ec2) |
| `--arch <arch>` |  | Architecture (ec2) |
| `--region <region>` |  | Region (ec2) |
| `--profile <profile>` |  | AWS profile (ec2) |
| `--image <image>` |  | Docker image (docker) |
| `--namespace <ns>` |  | K8s namespace (k8s) |

#### `ark compute template delete`

Delete a compute template

**Synopsis:** `ark compute template delete <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Template name |

## `ark agent`

Manage agent definitions

**Synopsis:** `ark agent`

### `ark agent list`

List agents

**Synopsis:** `ark agent list [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--project <dir>` |  | Project root |

### `ark agent show`

Show agent details

**Synopsis:** `ark agent show <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes |  |

### `ark agent create`

Create a new agent

**Synopsis:** `ark agent create [options] <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes |  |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--global` |  | Save at global scope instead of project scope |
| `--from <file>` |  | Seed YAML from a file instead of scaffolding fresh |
| `--no-editor` |  | Skip the $EDITOR step (use the scaffold / --from content as-is) |

### `ark agent edit`

Edit an agent definition

**Synopsis:** `ark agent edit [options] <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes |  |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--global` |  | Write back at global scope (default follows the existing agent's scope) |

### `ark agent delete`

Delete a custom agent

**Synopsis:** `ark agent delete [options] <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes |  |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-y, --yes` |  | Skip confirmation |

### `ark agent copy`

Copy an agent for customization

**Synopsis:** `ark agent copy [options] <name> [new-name]`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes |  |
| `new-name` | no |  |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--global` |  | Save at global scope instead of project scope |

## `ark flow`

Manage flows

**Synopsis:** `ark flow`

### `ark flow list`

List flows

**Synopsis:** `ark flow list`

### `ark flow show`

Show flow

**Synopsis:** `ark flow show <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes |  |

### `ark flow create`

Create a flow from a YAML file

**Synopsis:** `ark flow create [options] <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Flow name |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--from <file>` |  | YAML file containing the stages array |
| `--description <text>` |  | Flow description |
| `--scope <scope>` | `"global"` | global or project |

### `ark flow delete`

Delete a flow (global or project only -- builtins are protected)

**Synopsis:** `ark flow delete [options] <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Flow name |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--scope <scope>` | `"global"` | global or project |

## `ark skill`

Manage skills

**Synopsis:** `ark skill`

### `ark skill list`

List available skills

**Synopsis:** `ark skill list`

### `ark skill show`

Show skill details

**Synopsis:** `ark skill show <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Skill name |

### `ark skill create`

Create a new skill

**Synopsis:** `ark skill create [options] [name]`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | no | Skill name (required unless --from) |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--from <file>` |  | Create from YAML file |
| `-d, --description <desc>` |  | Skill description |
| `-p, --prompt <prompt>` |  | Skill prompt |
| `-s, --scope <scope>` | `"global"` | Scope: global or project |
| `--tags <tags>` |  | Comma-separated tags |

### `ark skill delete`

Delete a skill (global or project only)

**Synopsis:** `ark skill delete [options] <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Skill name |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-s, --scope <scope>` | `"global"` | Scope: global or project |

## `ark recipe`

Manage recipes

**Synopsis:** `ark recipe`

### `ark recipe list`

List available recipes

**Synopsis:** `ark recipe list`

### `ark recipe show`

Show recipe details

**Synopsis:** `ark recipe show <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Recipe name |

### `ark recipe create`

Create a new recipe

**Synopsis:** `ark recipe create [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--from <file>` |  | Create from YAML file |
| `--from-session <id>` |  | Create from existing session |
| `-n, --name <name>` |  | Recipe name (required with --from-session) |
| `-s, --scope <scope>` | `"global"` | Scope: global or project |

### `ark recipe delete`

Delete a recipe (global or project only)

**Synopsis:** `ark recipe delete [options] <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Recipe name |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-s, --scope <scope>` | `"global"` | Scope: global or project |

## `ark schedule`

Manage scheduled recurring sessions

**Synopsis:** `ark schedule`

### `ark schedule add`

Create a recurring scheduled session

**Synopsis:** `ark schedule add [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--cron <expression>` |  | Cron expression (e.g., "0 2 * * *") *(required)* |
| `-f, --flow <name>` | `"bare"` | Flow name |
| `-r, --repo <path>` |  | Repository path |
| `-s, --summary <text>` |  | Session summary |
| `-c, --compute <name>` |  | Compute name |
| `-g, --group <name>` |  | Group name |

### `ark schedule list`

List all schedules

**Synopsis:** `ark schedule list`

### `ark schedule delete`

Delete a schedule

**Synopsis:** `ark schedule delete <id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes | Schedule ID |

### `ark schedule enable`

Enable a schedule

**Synopsis:** `ark schedule enable <id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes | Schedule ID |

### `ark schedule disable`

Disable a schedule

**Synopsis:** `ark schedule disable <id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes | Schedule ID |

## `ark trigger`

Manage trigger configurations (webhook / schedule / poll)

**Synopsis:** `ark trigger`

### `ark trigger list`

List configured triggers

**Synopsis:** `ark trigger list [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--tenant <name>` |  | Tenant scope (default: 'default') |

### `ark trigger get`

Show a trigger config

**Synopsis:** `ark trigger get [options] <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Trigger name |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--tenant <name>` |  | Tenant scope |

### `ark trigger enable`

Enable a trigger (in-memory; edit the YAML to persist)

**Synopsis:** `ark trigger enable [options] <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Trigger name |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--tenant <name>` |  | Tenant scope |

### `ark trigger disable`

Disable a trigger (in-memory; restart resets)

**Synopsis:** `ark trigger disable [options] <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Trigger name |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--tenant <name>` |  | Tenant scope |

### `ark trigger reload`

Re-read trigger YAML files from disk

**Synopsis:** `ark trigger reload`

### `ark trigger sources`

List registered source connectors and their status

**Synopsis:** `ark trigger sources`

### `ark trigger test`

Replay a sample payload against a trigger (dry-run by default)

**Synopsis:** `ark trigger test [options] <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Trigger name |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--payload <file>` |  | JSON file with the synthetic payload *(required)* |
| `--tenant <name>` |  | Tenant scope |
| `--fire` |  | Actually invoke the flow (default: dry-run) |

## `ark worktree`

Git worktree operations

**Synopsis:** `ark worktree`

### `ark worktree diff`

Preview changes in a session worktree

**Synopsis:** `ark worktree diff [options] <session-id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `session-id` | yes | Session ID |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--base <branch>` | `"main"` | Base branch to compare against |

### `ark worktree finish`

Merge worktree branch, remove worktree, delete session

**Synopsis:** `ark worktree finish [options] <session-id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `session-id` | yes |  |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--into <branch>` | `"main"` | Target branch to merge into |
| `--no-merge` |  | Skip merge, just remove worktree and delete session |
| `--keep-branch` |  | Don't delete the branch after merge |

### `ark worktree pr`

Create a GitHub PR from a session worktree

**Synopsis:** `ark worktree pr [options] <session-id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `session-id` | yes | Session ID |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--title <title>` |  | PR title |
| `--base <branch>` | `"main"` | Base branch |
| `--draft` |  | Create as draft PR |

### `ark worktree list`

List sessions with active worktrees

**Synopsis:** `ark worktree list`

### `ark worktree cleanup`

Find and remove orphaned worktrees

**Synopsis:** `ark worktree cleanup [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--dry-run` |  | Only show what would be removed |

## `ark search`

Search across sessions, events, messages, and transcripts

**Synopsis:** `ark search [options] <query>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `query` | yes | Search text (case-insensitive) |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-l, --limit <n>` | `"20"` | Max results |
| `-t, --transcripts` |  | Also search Claude transcripts (slower) |
| `--index` |  | Rebuild transcript search index before searching |
| `--hybrid` |  | Use hybrid search (memory + knowledge + transcripts with LLM re-ranking) |

## `ark index`

Build or rebuild the transcript search index

**Synopsis:** `ark index`

## `ark search-all`

Search across all Claude conversations

**Synopsis:** `ark search-all [options] <query>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `query` | yes |  |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-n, --limit <n>` | `"20"` | Max results |
| `--days <n>` | `"90"` | Recent days to search |

## `ark memory`

Manage cross-session memory (backed by knowledge graph)

**Synopsis:** `ark memory`

### `ark memory list`

List stored memories

**Synopsis:** `ark memory list [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-s, --scope <scope>` |  | Filter by scope |

### `ark memory recall`

Recall memories relevant to a query

**Synopsis:** `ark memory recall [options] <query>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `query` | yes | Search query |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-s, --scope <scope>` |  | Filter by scope |
| `-n, --limit <n>` | `"10"` | Max results |

### `ark memory forget`

Forget a specific memory

**Synopsis:** `ark memory forget <id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes | Memory ID |

### `ark memory add`

Store a new memory

**Synopsis:** `ark memory add [options] <content>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `content` | yes | Memory content |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-t, --tags <tags>` |  | Comma-separated tags |
| `-s, --scope <scope>` |  | Scope (default: global) |
| `-i, --importance <n>` |  | Importance 0-1 (default: 0.5) |

### `ark memory clear`

Clear all memories in a scope

**Synopsis:** `ark memory clear [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-s, --scope <scope>` |  | Scope to clear (omit for ALL) |
| `--force` |  | Skip confirmation |

## `ark profile`

Manage profiles

**Synopsis:** `ark profile`

### `ark profile list`

List profiles

**Synopsis:** `ark profile list`

### `ark profile create`

Create a profile

**Synopsis:** `ark profile create <name> [description]`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes |  |
| `description` | no |  |

### `ark profile delete`

Delete a profile

**Synopsis:** `ark profile delete <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes |  |

## `ark conductor`

Conductor operations

**Synopsis:** `ark conductor`

### `ark conductor status`

Show whether a conductor is running on the daemon

**Synopsis:** `ark conductor status`

### `ark conductor learnings`

Show conductor learnings

**Synopsis:** `ark conductor learnings`

### `ark conductor learn`

Record a conductor learning

**Synopsis:** `ark conductor learn <title> [description]`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `title` | yes |  |
| `description` | no |  |

### `ark conductor bridge`

Start the messaging bridge (Slack/email) on the daemon

**Synopsis:** `ark conductor bridge`

### `ark conductor notify`

Send a test notification via bridge

**Synopsis:** `ark conductor notify <message>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `message` | yes |  |

## `ark router`

LLM routing proxy

**Synopsis:** `ark router`

### `ark router start`

Start the LLM router server

**Synopsis:** `ark router start [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-p, --port <port>` | `"8430"` | Listen port |
| `--policy <policy>` | `"balanced"` | Routing policy: quality, balanced, cost |
| `--config <path>` |  | Path to router config YAML |
| `--tensorzero` |  | Enable TensorZero gateway (starts Docker container) |
| `--tensorzero-url <url>` |  | TensorZero URL (skip auto-start, use existing) |
| `--tensorzero-port <port>` | `"3000"` | TensorZero gateway port |

### `ark router status`

Show router status and stats

**Synopsis:** `ark router status [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--url <url>` | `"http://localhost:8430"` | Router URL |
| `--tensorzero-url <url>` | `"http://localhost:3000"` | TensorZero URL |

### `ark router costs`

Show routing cost breakdown

**Synopsis:** `ark router costs [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--url <url>` | `"http://localhost:8430"` | Router URL |
| `--group-by <field>` | `"model"` | Group by: model, provider, session |

## `ark runtime`

Manage runtime definitions

**Synopsis:** `ark runtime`

### `ark runtime list`

List available runtimes

**Synopsis:** `ark runtime list`

### `ark runtime show`

Show runtime details

**Synopsis:** `ark runtime show <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes |  |

## `ark auth`

Manage authentication and API keys

**Synopsis:** `ark auth`

### `ark auth setup`

Set up Claude authentication (local or remote)

**Synopsis:** `ark auth setup [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--host <name>` |  | Run setup-token on a specific remote compute |

### `ark auth create-key`

Create a new API key

**Synopsis:** `ark auth create-key [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--name <name>` | `"default"` | Human-readable label for the key |
| `--role <role>` | `"member"` | Role: admin, member, or viewer |
| `--tenant <tenantId>` | `"default"` | Tenant ID |
| `--expires <date>` |  | Expiration date (ISO 8601) |

### `ark auth list-keys`

List API keys

**Synopsis:** `ark auth list-keys [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--tenant <tenantId>` | `"default"` | Tenant ID |

### `ark auth revoke-key`

Revoke an API key

**Synopsis:** `ark auth revoke-key [options] <id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes | API key ID (e.g. ak-abcd1234) |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--tenant <tenantId>` |  | Scope to this tenant (safer in multi-tenant setups) |

### `ark auth rotate-key`

Rotate an API key (revoke old, create new with same metadata)

**Synopsis:** `ark auth rotate-key [options] <id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes | API key ID to rotate |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--tenant <tenantId>` |  | Scope to this tenant (safer in multi-tenant setups) |

## `ark tenant`

Manage tenant settings

**Synopsis:** `ark tenant`

### `ark tenant policy`

Manage tenant compute policies

**Synopsis:** `ark tenant policy`

#### `ark tenant policy set`

Set compute policy for a tenant

**Synopsis:** `ark tenant policy set [options] <tenant-id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `tenant-id` | yes | Tenant ID |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--providers <list>` |  | Comma-separated allowed providers (e.g. k8s,ec2) |
| `--default-provider <provider>` | `"k8s"` | Default provider |
| `--max-sessions <n>` | `"10"` | Maximum concurrent sessions |
| `--max-cost <usd>` |  | Maximum daily cost in USD |

#### `ark tenant policy get`

Get compute policy for a tenant

**Synopsis:** `ark tenant policy get <tenant-id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `tenant-id` | yes | Tenant ID |

#### `ark tenant policy list`

List all tenant compute policies

**Synopsis:** `ark tenant policy list`

#### `ark tenant policy delete`

Delete compute policy for a tenant

**Synopsis:** `ark tenant policy delete <tenant-id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `tenant-id` | yes | Tenant ID |

### `ark tenant list`

List all tenants

**Synopsis:** `ark tenant list [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--json` |  | Output raw JSON |

### `ark tenant create`

Create a new tenant

**Synopsis:** `ark tenant create [options] <slug>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `slug` | yes | Kebab-case slug (unique) |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--name <name>` |  | Human-readable name (defaults to slug) |
| `--json` |  | Output raw JSON |

### `ark tenant update`

Update a tenant's slug / name / status

**Synopsis:** `ark tenant update [options] <id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes | Tenant id or slug |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--slug <slug>` |  | New slug |
| `--name <name>` |  | New name |
| `--status <status>` |  | active | suspended | archived |

### `ark tenant delete`

Delete a tenant (cascades teams + memberships, leaves sessions/computes behind)

**Synopsis:** `ark tenant delete <id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes | Tenant id or slug |

### `ark tenant suspend`

Set tenant status to 'suspended'

**Synopsis:** `ark tenant suspend <id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes | Tenant id or slug |

### `ark tenant resume`

Set tenant status to 'active'

**Synopsis:** `ark tenant resume <id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes | Tenant id or slug |

### `ark tenant auth`

Manage per-tenant Claude credential bindings

**Synopsis:** `ark tenant auth`

#### `ark tenant auth set`

Bind a tenant to a Claude credential (api-key secret OR subscription-blob).

**Synopsis:** `ark tenant auth set [options] <tenant-id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `tenant-id` | yes | Tenant ID (or slug) |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--api-key <name>` |  | Bind to a string secret storing ANTHROPIC_API_KEY |
| `--subscription-blob <name>` |  | Bind to a blob secret (the ~/.claude directory) |

#### `ark tenant auth show`

Show the current Claude credential binding for a tenant.

**Synopsis:** `ark tenant auth show <tenant-id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `tenant-id` | yes | Tenant ID (or slug) |

#### `ark tenant auth clear`

Remove the Claude credential binding for a tenant.

**Synopsis:** `ark tenant auth clear <tenant-id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `tenant-id` | yes | Tenant ID (or slug) |

### `ark tenant config`

Manage per-tenant configuration blobs

**Synopsis:** `ark tenant config`

#### `ark tenant config set-compute`

Write the compute-config YAML blob for a tenant (cluster overrides)

**Synopsis:** `ark tenant config set-compute [options] <tenantId>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `tenantId` | yes | Tenant ID |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-f, --file <path>` |  | Path to YAML file with cluster overrides |

#### `ark tenant config get-compute`

Fetch the compute-config YAML blob for a tenant

**Synopsis:** `ark tenant config get-compute <tenantId>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `tenantId` | yes | Tenant ID |

#### `ark tenant config clear-compute`

Clear the compute-config YAML blob for a tenant

**Synopsis:** `ark tenant config clear-compute <tenantId>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `tenantId` | yes | Tenant ID |

## `ark team`

Manage teams + memberships

**Synopsis:** `ark team`

### `ark team list`

List teams in a tenant

**Synopsis:** `ark team list [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--tenant <id>` |  | Tenant id or slug *(required)* |
| `--json` |  | Output raw JSON |

### `ark team create`

Create a team inside a tenant

**Synopsis:** `ark team create [options] <slug>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `slug` | yes | Kebab-case slug (unique within tenant) |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--tenant <id>` |  | Tenant id or slug *(required)* |
| `--name <name>` |  | Human-readable name (defaults to slug) |
| `--description <text>` |  | Description |
| `--json` |  | Output raw JSON |

### `ark team update`

Update a team's slug / name / description

**Synopsis:** `ark team update [options] <id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes | Team id |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--slug <slug>` |  | New slug |
| `--name <name>` |  | New name |
| `--description <text>` |  | New description |

### `ark team delete`

Delete a team (cascades memberships)

**Synopsis:** `ark team delete <id>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `id` | yes | Team id |

### `ark team members`

Manage team memberships

**Synopsis:** `ark team members`

#### `ark team members list`

List members of a team

**Synopsis:** `ark team members list [options] <team>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `team` | yes | Team id |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--json` |  | Output raw JSON |

#### `ark team members add`

Add a user to a team (creates the user if email is new)

**Synopsis:** `ark team members add [options] <team> <userEmail>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `team` | yes | Team id |
| `userEmail` | yes | User email |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--role <role>` | `"member"` | owner | admin | member | viewer |

#### `ark team members remove`

Remove a user from a team

**Synopsis:** `ark team members remove <team> <userEmail>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `team` | yes | Team id |
| `userEmail` | yes | User email |

#### `ark team members set-role`

Change a member's role

**Synopsis:** `ark team members set-role <team> <userEmail> <role>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `team` | yes | Team id |
| `userEmail` | yes | User email |
| `role` | yes | owner | admin | member | viewer |

## `ark user`

Manage user identities

**Synopsis:** `ark user`

### `ark user list`

List users

**Synopsis:** `ark user list [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--json` |  | Output raw JSON |

### `ark user get`

Show a user by id or email

**Synopsis:** `ark user get [options] <idOrEmail>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `idOrEmail` | yes | User id or email |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--json` |  | Output raw JSON |

### `ark user create`

Create a user

**Synopsis:** `ark user create [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--email <email>` |  | User email (unique) *(required)* |
| `--name <name>` |  | Display name |
| `--json` |  | Output raw JSON |

### `ark user delete`

Delete a user (cascades memberships)

**Synopsis:** `ark user delete <idOrEmail>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `idOrEmail` | yes | User id or email |

## `ark knowledge`

Knowledge graph - search, index, remember, export

**Synopsis:** `ark knowledge`

### `ark knowledge search`

Search across all knowledge (files, memories, sessions, learnings)

**Synopsis:** `ark knowledge search [options] <query>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `query` | yes | Search query |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-t, --types <types>` |  | Comma-separated node types to filter (file,symbol,session,memory,learning,skill) |
| `-n, --limit <n>` | `"20"` | Max results |

### `ark knowledge index`

Index/re-index codebase into the knowledge graph (runs on daemon)

**Synopsis:** `ark knowledge index [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-r, --repo <path>` |  | Repository path (default: cwd) |
| `--incremental` |  | Only re-index changed files |

### `ark knowledge stats`

Show node/edge counts by type

**Synopsis:** `ark knowledge stats`

### `ark knowledge remember`

Store a new memory in the knowledge graph

**Synopsis:** `ark knowledge remember [options] <content>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `content` | yes | Memory content |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-t, --tags <tags>` |  | Comma-separated tags |
| `-i, --importance <n>` |  | Importance 0-1 (default: 0.5) |

### `ark knowledge recall`

Search memories and learnings

**Synopsis:** `ark knowledge recall [options] <query>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `query` | yes | Search query |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-n, --limit <n>` | `"10"` | Max results |

### `ark knowledge export`

Export knowledge as markdown files (daemon-side filesystem)

**Synopsis:** `ark knowledge export [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-d, --dir <path>` | `"./knowledge-export"` | Output directory |
| `-t, --types <types>` |  | Comma-separated types to export (default: memory,learning) |

### `ark knowledge import`

Import knowledge from markdown files (daemon-side filesystem)

**Synopsis:** `ark knowledge import [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-d, --dir <path>` | `"./knowledge-export"` | Input directory |

### `ark knowledge ingest`

Ingest a directory into the knowledge graph (indexes files and symbols)

**Synopsis:** `ark knowledge ingest [options] <path>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `path` | yes | Directory to ingest |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--incremental` |  | Only re-index changed files |

### `ark knowledge codebase`

codebase-memory-mcp (vendored code intelligence engine)

**Synopsis:** `ark knowledge codebase`

#### `ark knowledge codebase status`

Show codebase-memory-mcp installation status and version

**Synopsis:** `ark knowledge codebase status`

#### `ark knowledge codebase tools`

List the 14 MCP tools exposed by codebase-memory-mcp

**Synopsis:** `ark knowledge codebase tools`

#### `ark knowledge codebase reindex`

Run `index_repository` against a path via the caller's vendored binary

**Synopsis:** `ark knowledge codebase reindex [path]`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `path` | no | Repository path (default: cwd) |

## `ark code-intel`

Unified code-intelligence store (search, index, repos, runs)

**Synopsis:** `ark code-intel`

### `ark code-intel db`

Schema migrations + status

**Synopsis:** `ark code-intel db`

#### `ark code-intel db migrate`

Apply any pending code-intel migrations

**Synopsis:** `ark code-intel db migrate [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--to <version>` |  | Target version (default: latest) |

#### `ark code-intel db status`

Print current schema version + pending migrations

**Synopsis:** `ark code-intel db status`

#### `ark code-intel db reset`

Drop every code-intel table (DEV ONLY).

**Synopsis:** `ark code-intel db reset [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--yes` |  | Confirm destructive operation |

### `ark code-intel repo`

Manage indexed repositories

**Synopsis:** `ark code-intel repo`

#### `ark code-intel repo add`

Register a repo for indexing

**Synopsis:** `ark code-intel repo add [options] <url-or-path>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `url-or-path` | yes | Repo URL or local path |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--tenant <slug>` |  | Tenant slug (default: caller's tenant) |
| `--name <name>` |  | Display name (default: derived) |
| `--default-branch <branch>` | `"main"` | Default branch |

#### `ark code-intel repo list`

List repos for a tenant

**Synopsis:** `ark code-intel repo list [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--tenant <slug>` |  | Tenant slug (default: caller's tenant) |

### `ark code-intel reindex`

Run extractors against a repo

**Synopsis:** `ark code-intel reindex [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--tenant <slug>` |  | Tenant slug (default: caller's tenant) |
| `--repo <id-or-name>` |  | Repo id or name (default: only one if unambiguous) |
| `--extractors <names>` |  | Comma-separated extractor names (default: all) |

### `ark code-intel search`

FTS over chunks (file content + symbols)

**Synopsis:** `ark code-intel search [options] <query>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `query` | yes | Search query |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--tenant <slug>` |  | Tenant slug (default: caller's tenant) |
| `-n, --limit <n>` | `"20"` | Max results |

### `ark code-intel get-context`

Assemble a context snapshot for a file or symbol

**Synopsis:** `ark code-intel get-context [options] <subject>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `subject` | yes | File path, file id, or symbol name |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--tenant <slug>` |  | Tenant slug (default: caller's tenant) |
| `--repo <id-or-name>` |  | Repo id or name (helps path lookup) |

### `ark code-intel doctor`

Report VendorResolver + binary health (caller-local)

**Synopsis:** `ark code-intel doctor`

### `ark code-intel health`

High-level store + deployment health

**Synopsis:** `ark code-intel health`

## `ark workspace`

Manage workspaces (tenant -> workspace -> repo)

**Synopsis:** `ark workspace`

### `ark workspace create`

Create a new workspace

**Synopsis:** `ark workspace create [options] <slug>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `slug` | yes | Workspace slug (unique per tenant) |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--tenant <slug>` |  | Tenant slug (default: caller's tenant) |
| `--name <name>` |  | Display name (default: derived from slug) |
| `--description <text>` |  | Free-form description |

### `ark workspace list`

List workspaces for a tenant

**Synopsis:** `ark workspace list [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--tenant <slug>` |  | Tenant slug (default: caller's tenant) |
| `--format <fmt>` | `"text"` | Output format: yaml | text |

### `ark workspace show`

Show a workspace + attached repos

**Synopsis:** `ark workspace show [options] <slug>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `slug` | yes | Workspace slug |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--tenant <slug>` |  | Tenant slug (default: caller's tenant) |
| `--format <fmt>` | `"text"` | Output format: yaml | text |

### `ark workspace use`

Set the active workspace (persisted to the caller's ~/.ark/config.yaml)

**Synopsis:** `ark workspace use [options] <slug>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `slug` | yes | Workspace slug |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--tenant <slug>` |  | Tenant slug (default: caller's tenant) |

### `ark workspace add-repo`

Attach a repo to a workspace (creates the repo if it's a new path/URL)

**Synopsis:** `ark workspace add-repo [options] <workspace-slug> <repo-path-or-url>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `workspace-slug` | yes | Workspace slug |
| `repo-path-or-url` | yes | Repo path, URL, or existing repo id / name |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--tenant <slug>` |  | Tenant slug (default: caller's tenant) |

### `ark workspace remove-repo`

Detach a repo from a workspace (repo itself is not deleted)

**Synopsis:** `ark workspace remove-repo [options] <workspace-slug> <repo>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `workspace-slug` | yes | Workspace slug |
| `repo` | yes | Repo id, name, or URL |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--tenant <slug>` |  | Tenant slug (default: caller's tenant) |

## `ark eval`

Agent performance evaluation

**Synopsis:** `ark eval`

### `ark eval stats`

Show agent performance stats

**Synopsis:** `ark eval stats [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-a, --agent <role>` |  | Agent role to filter by |

### `ark eval drift`

Check for performance drift

**Synopsis:** `ark eval drift [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-a, --agent <role>` |  | Agent role to check |
| `-d, --days <n>` | `"7"` | Recent window in days |

### `ark eval list`

List recent eval results

**Synopsis:** `ark eval list [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-a, --agent <role>` |  | Agent role to filter by |
| `-n, --limit <n>` | `"20"` | Max results |

## `ark dashboard`

Show fleet status, costs, and recent activity

**Synopsis:** `ark dashboard [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--json` |  | Output as JSON |

## `ark costs`

Show cost summary across sessions

**Synopsis:** `ark costs [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-n, --limit <n>` | `"20"` | Number of rows to show |
| `--by <dimension>` |  | Group by: model, provider, runtime, agent, session, tenant, user |
| `--trend` |  | Show daily cost trend |
| `--days <n>` |  | Days for trend (default 30) |
| `--since <date>` |  | Start date (ISO format) |
| `--until <date>` |  | End date (ISO format) |
| `--tenant <id>` |  | Filter by tenant |

## `ark costs-sync`

Backfill cost data from transcripts (on the daemon host)

**Synopsis:** `ark costs-sync`

## `ark costs-export`

Export cost data

**Synopsis:** `ark costs-export [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--format <format>` | `"json"` | csv or json |
| `-o, --output <file>` |  | Output file |

## `ark server`

JSON-RPC server

**Synopsis:** `ark server`

### `ark server daemon`

Manage the Ark server daemon

**Synopsis:** `ark server daemon`

#### `ark server daemon start`

Start the Ark server daemon (AppContext + conductor + arkd + WebSocket)

**Synopsis:** `ark server daemon start [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-p, --port <port>` | `"19400"` | WebSocket server port |
| `-d, --detach` |  | Run in background (detached mode) |

#### `ark server daemon stop`

Stop the server daemon

**Synopsis:** `ark server daemon stop`

#### `ark server daemon status`

Check server daemon status

**Synopsis:** `ark server daemon status`

### `ark server start`

Start the Ark server

**Synopsis:** `ark server start [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--stdio` |  | Use stdio transport (JSONL) |
| `--ws` |  | Use WebSocket transport |
| `--hosted` |  | Start as hosted multi-tenant control plane |
| `-p, --port <port>` | `"19400"` | WebSocket port |

## `ark exec`

Run a session non-interactively (for CI/CD)

**Synopsis:** `ark exec [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-r, --repo <path>` |  | Repository path |
| `-s, --summary <text>` |  | Task summary |
| `-t, --ticket <key>` |  | Ticket reference |
| `-f, --flow <name>` | `"bare"` | Flow name |
| `-c, --compute <name>` |  | Compute target |
| `-g, --group <name>` |  | Group name |
| `-a, --autonomy <level>` |  | Autonomy: full/execute/edit/read-only |
| `-o, --output <format>` | `"text"` | Output: text/json |
| `-w, --workspace <slug>` |  | Workspace slug for multi-repo dispatch (Wave 2b-1: LOCAL compute only). Combine with --repo to set a primary. |
| `-i, --input <pair>` | `[]` | Session input file as role=path (repeatable). Accessible to flows/agents as {inputs.files.<role>}. |
| `-p, --param <pair>` | `[]` | Session input param as key=value (repeatable). Accessible as {inputs.params.<key>}. |
| `--timeout <seconds>` | `"0"` | Timeout in seconds (0=unlimited) |

## `ark try`

Run a one-shot sandboxed session (auto-cleans up)

**Synopsis:** `ark try [options] <task>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `task` | yes |  |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--image <image>` | `"ubuntu:22.04"` | Docker image |

## `ark daemon`

Manage the arkd agent daemon

**Synopsis:** `ark daemon`

### `ark daemon start`

Start the arkd agent daemon

**Synopsis:** `ark daemon start [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-p, --port <port>` | `"19300"` | Port |
| `--hostname <host>` | `"0.0.0.0"` | Bind address |
| `--conductor-url <url>` |  | Conductor URL for channel relay |
| `--workspace-root <path>` |  | Confine /file/* and /exec to this directory (recommended in hosted / multi-tenant deployments) |
| `-d, --detach` |  | Run in background (detached mode) |

### `ark daemon stop`

Stop a running daemon

**Synopsis:** `ark daemon stop [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-p, --port <port>` |  | Port of daemon to stop (uses PID file by default) |

### `ark daemon status`

Check daemon status

**Synopsis:** `ark daemon status [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-p, --port <port>` | `"19300"` | Port to check |

## `ark pr`

Manage PR-bound sessions

**Synopsis:** `ark pr`

### `ark pr list`

List sessions bound to PRs

**Synopsis:** `ark pr list`

### `ark pr status`

Show session bound to a PR URL

**Synopsis:** `ark pr status <pr-url>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `pr-url` | yes | GitHub PR URL |

## `ark watch`

Watch GitHub issues with a label and auto-create sessions

**Synopsis:** `ark watch [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-l, --label <label>` | `"ark"` | GitHub label to watch |
| `-d, --dispatch` |  | Auto-dispatch created sessions |
| `-i, --interval <ms>` | `"60000"` | Poll interval in ms |

## `ark claude`

Interact with Claude Code sessions

**Synopsis:** `ark claude`

### `ark claude list`

List Claude Code sessions found on disk

**Synopsis:** `ark claude list [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-p, --project <filter>` |  | Filter by project path |
| `-l, --limit <n>` | `"20"` | Max results |

## `ark doctor`

Check system prerequisites

**Synopsis:** `ark doctor`

## `ark arkd`

Start the arkd agent daemon

**Synopsis:** `ark arkd [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-p, --port <port>` | `"19300"` | Port |
| `--hostname <host>` | `"0.0.0.0"` | Bind address (default: 0.0.0.0) |
| `--conductor-url <url>` |  | Conductor URL for channel relay |

## `ark channel`

Run the MCP channel server (used by remote agents)

**Synopsis:** `ark channel`

## `ark run-agent-sdk`

Run the agent-sdk launch script (internal -- used by agent-sdk executor)

**Synopsis:** `ark run-agent-sdk`

## `ark config`

Open Ark config in your editor

**Synopsis:** `ark config [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--path` |  | Just print the config path |

## `ark web`

Start web dashboard

**Synopsis:** `ark web [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--port <port>` | `"8420"` | Listen port |
| `--read-only` |  | Read-only mode |
| `--token <token>` |  | Bearer token for auth |
| `--api-only` |  | API only, skip static file serving (for dev with Vite) |
| `--with-daemon` |  | Also start conductor + arkd in-process (for desktop app / standalone use) |

## `ark openapi`

Generate OpenAPI spec

**Synopsis:** `ark openapi`

## `ark mcp-proxy`

Bridge stdin/stdout to a pooled MCP socket (internal)

**Synopsis:** `ark mcp-proxy <socket-path>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `socket-path` | yes |  |

## `ark acp`

Start headless ACP server on stdin/stdout (JSON-RPC)

**Synopsis:** `ark acp`

## `ark repo-map`

Generate repository structure map

**Synopsis:** `ark repo-map [options] [dir]`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `dir` | no | Directory to scan |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--max-files <n>` | `"500"` | Max files to include |
| `--max-depth <n>` | `"10"` | Max directory depth |
| `--json` |  | Output as JSON instead of text |

## `ark init`

Initialize Ark for this repository

**Synopsis:** `ark init`

## `ark db`

Schema migrations + status

**Synopsis:** `ark db`

### `ark db migrate`

Apply any pending Ark migrations

**Synopsis:** `ark db migrate [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--to <version>` |  | Target version (default: latest) |

### `ark db status`

Print current schema version + pending migrations

**Synopsis:** `ark db status`

### `ark db down`

Roll back to a target version (Phase 1: not implemented)

**Synopsis:** `ark db down [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--to <version>` |  | Target version *(required)* |

## `ark secrets`

Manage tenant-scoped secrets (env vars for sessions)

**Synopsis:** `ark secrets`

### `ark secrets list`

List secret names (values are never returned)

**Synopsis:** `ark secrets list`

### `ark secrets set`

Create or replace a secret. Reads value from stdin if piped, otherwise prompts.

**Synopsis:** `ark secrets set [options] <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Secret name (ASCII [A-Z0-9_]+) |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-d, --description <text>` |  | Human-readable description |

### `ark secrets delete`

Delete a secret.

**Synopsis:** `ark secrets delete [options] <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Secret name |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-y, --yes` |  | Skip the confirm prompt |

### `ark secrets blob`

Manage multi-file secret blobs (directory-shaped secrets)

**Synopsis:** `ark secrets blob`

#### `ark secrets blob list`

List blob names (contents are never returned)

**Synopsis:** `ark secrets blob list`

#### `ark secrets blob upload`

Upload a directory as a named blob. Reads every file in <dir> (non-recursive).

**Synopsis:** `ark secrets blob upload <name> <dir>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Blob name (lowercase kebab-case, <=63 chars) |
| `dir` | yes | Directory to upload |

#### `ark secrets blob download`

Download a blob into a directory. Creates the directory if missing.

**Synopsis:** `ark secrets blob download <name> <dir>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Blob name |
| `dir` | yes | Target directory |

#### `ark secrets blob delete`

Delete a blob.

**Synopsis:** `ark secrets blob delete [options] <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Blob name |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `-y, --yes` |  | Skip the confirm prompt |

### `ark secrets get`

Print a secret value to stdout. Refuses TTY stdout without --print.

**Synopsis:** `ark secrets get [options] <name>`

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | yes | Secret name |

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--print` |  | Allow printing to a TTY (default: refuse to prevent shoulder surfing) |

## `ark cluster`

List Kubernetes clusters visible to this tenant

**Synopsis:** `ark cluster`

### `ark cluster list`

List effective clusters (system + tenant overrides)

**Synopsis:** `ark cluster list [options]`

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--json` |  | Output raw JSON |

