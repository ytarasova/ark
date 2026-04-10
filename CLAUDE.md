# Ark

Autonomous agent ecosystem. Orchestrates AI coding agents through DAG-based SDLC flows with 7 compute providers, unified knowledge graph, LLM router, and multi-tenant control plane.

## Commands

```bash
make install          # bun install + symlink ark to /usr/local/bin
make test             # run all tests sequentially (NEVER parallel -- ports collide)
make test-file F=path # run a single test file
make dev              # tsc --watch
make tui              # ark tui
make desktop          # launch Electron desktop app
make desktop-build    # package Electron app for distribution
./ark <command>       # run CLI directly via bun
ark skill list        # list available skills
ark recipe list       # list available recipes
ark session start --recipe quick-fix --repo . --dispatch  # start session from recipe
ark search <query>    # search sessions, events, messages (--transcripts for JSONL, --index to rebuild FTS5)
ark index             # rebuild transcript FTS5 search index
ark claude list       # list Claude Code sessions on disk (--project to filter)
ark arkd              # start the arkd daemon (--port 19300, --conductor-url http://localhost:19100)
```

## Project Structure

```
packages/
  cli/       → Commander.js CLI entry (ark command)
  core/      → Sessions, store, flows, agents, channels, conductor, search (FTS5), app context, config
    knowledge/     → Knowledge graph store, indexer, context builder, MCP tools, export/import
    repositories/  → SQL CRUD (SessionRepository, ComputeRepository, EventRepository, MessageRepository, TodoRepository)
    services/      → Business logic (SessionService, ComputeService, HistoryService) + orchestration
    stores/        → Resource stores (FlowStore, SkillStore, AgentStore, RecipeStore, RuntimeStore) -- file-backed, three-tier resolution
    auth.ts        → Multi-tenant auth middleware (API key-based)
    api-keys.ts    → API key manager (create, validate, revoke, rotate)
    tenant-policy.ts → Tenant compute policies (provider limits, cost caps)
    hosted.ts      → Hosted mode entry point (worker registry, scheduler, SSE bus)
    worker-registry.ts → Worker registration and health checking
    scheduler.ts   → Session scheduler with tenant policy enforcement
    sse-bus.ts     → In-memory SSE event bus
    sse-redis.ts   → Redis-backed SSE bus for multi-instance deployments
    database.ts    → IDatabase abstraction interface
    database-sqlite.ts → SQLite adapter (local mode, bun:sqlite)
    database-postgres.ts → PostgreSQL adapter (hosted mode)
  compute/   → 7 providers: local, docker, devcontainer, firecracker, ec2+arkd, e2b, k8s+kata
  arkd/      → Universal agent daemon - HTTP server on every compute target
  router/    → LLM Router -- OpenAI-compatible proxy with routing policies, circuit breakers
  server/    → JSON-RPC handlers (delegate to services + stores via AppContext)
  protocol/  → ArkClient (typed JSON-RPC client)
  tui/       → React + Ink terminal dashboard
  web/       → Vite-based web dashboard (SSE live updates, Dashboard page with Recharts)
  desktop/   → Electron shell wrapping the web dashboard
  types/     → Domain interfaces (Session, Compute, Event, Message, Tenant, etc.)
agents/      → 12 agent definitions (ticket-intake, spec-planner, plan-auditor, implementer,
               task-implementer, verifier, reviewer, documenter, closer, retro, planner, worker)
runtimes/    → 4 runtime definitions (claude, codex, gemini, aider)
flows/       → 9 flow definitions (default, quick, bare, parallel, fan-out, pr-review, dag-parallel, islc, islc-quick)
skills/      → 7 builtin skills (code-review, plan-audit, sanity-gate, security-scan, self-review, spec-extraction, test-writing)
recipes/     → 8 recipe templates (quick-fix, feature-build, code-review, fix-bug, new-feature, ideate, islc, islc-quick)
mcp-configs/ → MCP config stubs (Atlassian, GitHub, Linear, Figma)
.infra/      → Dockerfile, docker-compose, Helm chart
```

No workspaces config - packages are coordinated manually via relative imports.

**Core module layers** (from bottom to top):
```
packages/types/                         → Domain interfaces (Session, Compute, Event, Message, Tenant, etc.)
packages/core/
  database.ts / database-sqlite.ts / database-postgres.ts → IDatabase abstraction
  repositories/                         → SQL CRUD (SessionRepository, ComputeRepository, etc.)
  stores/                               → Resource stores (FlowStore, SkillStore, AgentStore, RecipeStore, RuntimeStore)
  knowledge/                            → Knowledge graph (store, indexer, context builder, MCP tools, export)
  services/session.ts                   → SessionService -- lifecycle facade, delegates complex ops to orchestration
  services/session-orchestration.ts     → All orchestration (dispatch, advance, fork, clone, spawn, fan-out, etc.)
  auth.ts + api-keys.ts                 → Multi-tenant auth middleware + API key manager
  tenant-policy.ts                      → Tenant compute policies
  hosted.ts                             → Hosted mode entry (worker registry, scheduler, Redis SSE)
  app.ts                                → AppContext wires repos + services + stores, boot/shutdown lifecycle
  conductor.ts                          → HTTP server (:19100), hook status, channel relay
packages/router/                        → LLM Router (OpenAI-compatible, 3 policies, circuit breakers)
packages/server/                        → JSON-RPC handlers (delegate to services + stores via AppContext)
packages/protocol/                      → ArkClient (typed JSON-RPC client)
```

**Key entry points:**
- `AppContext` (`app.ts`) -- access repos via `app.sessions`, `app.computes`; services via `app.sessionService`; stores via `app.flows`, `app.skills`, `app.agents`, `app.recipes`
- `SessionService` (`services/session.ts`) -- lifecycle facade: start, stop, resume, complete, pause, delete. Delegates complex ops (dispatch, advance, fork) to `session-orchestration.ts`
- `session-orchestration.ts` (`services/session-orchestration.ts`) -- all orchestration functions. Every function takes `app: AppContext` as first argument (no `getApp()` calls)

## Key Gotchas

**FTS5 table needs manual creation on existing DBs.** The `transcript_index` FTS5 virtual table is in `initSchema()` but `CREATE VIRTUAL TABLE IF NOT EXISTS` only runs when the DB is first created. If you add new tables, existing `~/.ark/ark.db` files won't get them - run the SQL manually or delete the DB.

**ARK_DIR resolved at call time.** `paths.ts` `ARK_DIR()` is a function that reads from AppContext config via `getApp()`. Use `AppContext.forTest()` for test isolation -- it creates a temp directory and sets up an isolated DB.

**Bun-only.** Uses `bun:sqlite`, `Bun.serve()`, `Bun.sleep()`, Bun FFI. Will not run under Node.

**Tmux required.** Sessions launch agents in tmux sessions (`ark-s-<id>`). No fallback if tmux is missing.

**ES module imports need `.js` extensions.** All relative imports must use `.js` even in TypeScript files:
```ts
import { foo } from "./bar.js";  // correct
import { foo } from "./bar";     // breaks at runtime
```

**`strict: false` in tsconfig.** Implicit `any` is allowed; no strict null checks.

**SQL columns match TS fields 1:1.** No field mapping needed. The columns are `ticket`, `summary`, `flow` (not the old jira_key/jira_summary/pipeline). Add new Session fields to the column whitelist in `repositories/session.ts`.

**Conductor port 19100 is hardcoded** in conductor.ts, channel.ts, and tests. Channel ports are derived deterministically: `19200 + (parseInt(sessionId.replace("s-",""), 16) % 10000)`.

**ArkD port 19300 is the default** for the universal agent daemon. Local providers use `http://localhost:19300`, remote providers use `http://<ip>:19300`. Channel relay goes through arkd - channel.ts reports to arkd, arkd forwards to conductor.

**No ESLint config file.** The `lint` script exists but no `.eslintrc` or `eslint.config.*` - runs with ESLint defaults.

**Bun-only testing.** Tests use `bun:test`. Always run via `make test` -- never call `bun test` directly.

## Testing

Tests use `bun:test`, not vitest. **Always use make targets** -- never call `bun test` directly (concurrency flags can be misinterpreted and tests MUST run sequentially).

**NEVER run tests in parallel.** Tests share ports (19100, 19200, 19300), globalThis state, and SQLite databases. Bun runs test files concurrently by default which causes cross-test contamination -- port collisions, leaked state, phantom failures.

```bash
make test                                                      # all tests (sequential, builds deps first)
make test-file F=packages/core/__tests__/session.test.ts       # single file
```

If you see tests that pass individually but fail in the full suite, it's a parallelism issue, not a code bug.

**E2E tests need `dist/` built.** CLI E2E tests (`e2e-cli.test.ts`) and TUI real tests (`e2e-tui-real.test.ts`) import from `dist/` - run `make dev` or `tsc` first. Unit tests run from source.

**Test isolation pattern** -- use `AppContext.forTest()` (preferred):
```ts
import { AppContext, setApp, clearApp } from "../app.js";

let app: AppContext;
beforeAll(async () => { app = AppContext.forTest(); await app.boot(); setApp(app); });
afterAll(async () => { await app?.shutdown(); clearApp(); });
```

Access repos directly: `app.sessions.create(...)`, `app.events.log(...)`.
Call orchestration functions with `app` as first argument: `dispatch(app, sessionId)`, `fanOut(app, parentId, opts)`.

**Legacy `withTestContext()` helper** is being phased out. New tests should use `AppContext.forTest()` as shown above.

**`waitFor()` polling utility** - async helper that polls a condition until it returns true (or times out). Useful for testing async state transitions:
```ts
await waitFor(() => getSession(id).status === "running");
```

Test conductor ports use offsets (19199, 19200, 19300) to avoid collisions.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ARK_CONDUCTOR_PORT` | `19100` | Conductor HTTP server port |
| `ARK_CONDUCTOR_URL` | `http://localhost:19100` | Conductor URL (fallback if arkd unavailable) |
| `ARK_ARKD_URL` | `http://localhost:19300` | ArkD URL - channel reports go here first |
| `ARK_ARKD_PORT` | `19300` | ArkD daemon port |
| `ARK_CHANNEL_PORT` | auto-assigned | Per-session MCP channel port |
| `ARK_SESSION_ID` | - | Set in channel context |
| `ARK_STAGE` | - | Current flow stage in channel |
| `ARK_SERVER` | - | Remote Ark server URL (enables remote client mode) |
| `ARK_TOKEN` | - | API key for remote server authentication |
| `DATABASE_URL` | - | PostgreSQL connection URL (hosted mode; defaults to SQLite) |
| `REDIS_URL` | - | Redis URL for SSE bus (hosted mode; defaults to in-memory) |
| `ARK_TEST_DIR` | - | Temp dir for test isolation |

## Data Locations

| Path | Purpose |
|------|---------|
| `~/.ark/ark.db` | SQLite database (WAL mode, 5s busy timeout) -- includes knowledge graph tables |
| `~/.ark/tracks/<sessionId>/` | Launcher scripts, channel configs |
| `~/.ark/worktrees/<sessionId>/` | Git worktrees for isolated sessions |
| `~/.ark/skills/` | Global skill definitions (user tier for SkillStore) |
| `~/.ark/recipes/` | Global recipe definitions (user tier for RecipeStore) |
| `~/.ark/flows/` | Global flow definitions (user tier for FlowStore) |
| `~/.ark/agents/` | Global agent definitions (user tier for AgentStore) |
| `~/.ark/runtimes/` | Global runtime definitions (user tier for RuntimeStore) |
| `~/.claude/projects/` | Claude Code session transcripts (JSONL) - read by search and import |
| `.claude/settings.local.json` | Per-session hook config (written at dispatch, cleaned on stop) |

**Note:** The old `~/.ark/memories.json` and `~/.ark/LEARNINGS.md` files are no longer used. Memory and learnings are now stored as nodes in the knowledge graph (in `ark.db`).

## Adding an Agent (Role)

Agents define WHAT an agent does (role, prompt, skills, tools). Runtimes define HOW it runs (LLM backend, CLI command).

Create `agents/<name>.yaml`:
```yaml
name: my-agent
description: What it does
runtime: claude     # references runtimes/claude.yaml -- can be overridden at dispatch with --runtime
model: opus        # opus | sonnet | haiku
max_turns: 200
system_prompt: |
  Working on {repo}. Task: {summary}. Ticket: {ticket}.
tools: [Bash, Read, Write, Edit, Glob, Grep, WebSearch]
permission_mode: bypassPermissions
env: {}
```

Template variables: `{ticket}`, `{summary}`, `{workdir}`, `{repo}`, `{branch}` - substituted at dispatch.

**Override runtime at dispatch:**
```bash
# Use default runtime (claude) for implementer role
ark session start --repo . --summary "Fix bug" --agent implementer --dispatch

# Override: run implementer role on codex runtime
ark session start --repo . --summary "Fix bug" --agent implementer --runtime codex --dispatch

# Override: run worker role on gemini runtime
ark session start --repo . --summary "Fix bug" --agent worker --runtime gemini --dispatch
```

## Runtimes

Runtimes define HOW an agent runs. Three-tier resolution: `runtimes/` (builtin) > `~/.ark/runtimes/` (global) > `.ark/runtimes/` (project).

**Built-in runtimes:** `claude` (Claude Code), `codex` (OpenAI Codex CLI), `gemini` (Google Gemini CLI), `aider` (Aider).

Create `runtimes/<name>.yaml`:
```yaml
name: my-runtime
description: "Custom LLM backend"
type: cli-agent     # claude-code | cli-agent | subprocess
command: ["my-tool", "--auto"]
task_delivery: arg  # stdin | file | arg
models:
  - id: default
    label: "Default Model"
default_model: default
```

CLI: `ark runtime list`, `ark runtime show <name>`.

At dispatch, runtime config (type, command, task_delivery, env) is merged with agent config. Agent-level values take precedence.

## Executor System

Agents dispatch through pluggable executors. The runtime's `type` field selects which executor launches the agent.

**Built-in executors:**
- `claude-code` (default) -- launches Claude Code in tmux with hooks + MCP channel
- `subprocess` -- spawns any command as a child process
- `cli-agent` -- runs any CLI tool (codex, gemini, aider, etc.) in tmux with worktree isolation

**Executor interface:** 5 methods -- `launch`, `kill`, `status`, `send`, `capture`. Defined in `packages/core/executor.ts`.

**Adding a subprocess agent:**
```yaml
name: my-linter
runtime: subprocess
command: ["node", "scripts/lint.js"]
env:
  TARGET: "{workdir}"
```

Executors are registered at boot in `app.ts`. The registry is in `packages/core/executor.ts`.

## Adding a Flow

Create `flows/definitions/<name>.yaml`:
```yaml
name: my-flow
stages:
  - name: plan
    agent: planner
    gate: manual    # manual | auto | condition
  - name: implement
    agent: implementer
    gate: auto
    verify:           # scripts that must pass before stage completion
      - "npm test"
      - "npm run lint"
```

The `verify` field defines scripts that are run before a stage can be completed. If any script fails, completion is blocked and the agent is steered to fix the issue. Verify scripts can also be set in repo config (`.ark.yaml`) as a default for all stages.

## Skills

Reusable prompt fragments for agents. Three-tier resolution (highest priority first):
- **project**: `.ark/skills/<name>.md` in the repo
- **global**: `~/.ark/skills/<name>.md`
- **builtin**: `skills/<name>.md` shipped with Ark

Attach to agents via the `skills` field in agent YAML. At dispatch, skill content is automatically injected into the agent's system prompt. CLI: `ark skill list`, `ark skill show <name>`.

## Recipes

Session templates with variables and repo field. Quick-launch sessions from presets. Three-tier resolution like skills: `.ark/recipes/` (project), `~/.ark/recipes/` (global), `recipes/` (builtin).

Built-in recipes: `quick-fix`, `feature-build`, `code-review`. Create from existing session with `sessionToRecipe`.

CLI: `ark recipe list`, `ark recipe show <name>`.

## Intelligence Features

- **Verification gates**: `verify` field on flow stages defines scripts (e.g. `npm test`) that must pass before an agent can complete. Todos (user-added checklist items) also block completion. Enforced automatically when agent reports completed. `--force` flag to override. CLI: `ark session verify <id>`, `ark session todo add <id> "text"`.
- **Auto-PR creation**: when an agent completes and the repo has a git remote, Ark auto-pushes the branch and creates a GitHub PR via `gh pr create`. Disable per-repo with `auto_pr: false` in `.ark.yaml`. Manual: `ark worktree pr <id>`.
- **Agent interrupt**: sends Ctrl+C to a running agent without killing the tmux session (`ark session interrupt <id>`, TUI: `I`). Agent pauses and can be re-engaged.
- **Diff preview**: view git diff stat before merging or creating a PR (`ark worktree diff <id>`, TUI: `W` overlay, Web: "Preview Changes" button). Tracks which files you've reviewed and flags modifications since last review.
- **Session archive/restore**: archive completed sessions for later reference without deleting them (`ark session archive <id>`, TUI: `Z`). Archived sessions are hidden from the default list but preserved indefinitely.
- **Fail-loopback**: retry failed stages with error context injected (max 3 retries). Configured via `on_failure: "retry(3)"` in flow stage YAML.
- **Sub-agent fan-out**: decompose tasks into N parallel child sessions. Parent waits for all children. Use `ark session fork` / `ark session join`.
- **Skill extraction**: analyze conversations for reusable procedures, save as skills.
- **Structured review output**: reviewer produces machine-parseable JSON with P0-P3 severity levels.
- **Guardrails**: pattern-based tool authorization rules that block dangerous commands (e.g. `rm -rf /`, `git push --force`) before execution. Evaluated at the tool-call level regardless of permission mode.

## Remote Sync

At dispatch to remote compute, Ark syncs `.claude/commands/`, `.claude/skills/`, and `CLAUDE.md` to the remote target.

## TUI Keyboard Shortcuts

**Sessions tab (1):**
| Key | Action | Key | Action |
|-----|--------|-----|--------|
| `j/k` | Navigate sessions | `n` | New session |
| `Enter` | Dispatch/restart | `s` | Stop session |
| `I` | Interrupt agent (Ctrl+C) | `t` | Talk (send message) |
| `a` | Attach to tmux | `V` | Run verification |
| `x` | Delete session | `d` | Mark done (press twice) |
| `W` | Worktree finish (Merge/PR) | `Z` | Archive/restore |
| `c` | Clone session | `m` | Move to group |
| `i` | Inbox/threads | `g` | Group manager |
| `Tab` | Focus detail pane | `e` | Expand events |

**Tools tab (7):** `Enter`:view/use `x`:delete (6 categories: MCP Servers, Commands, Claude Skills, Ark Skills, Recipes, Context)

**History tab (5):** `Enter`:import `r`:refresh+reindex `s`:search

**Compute tab (4):** `Enter`:provision `s`:start/stop `c`:clean `n`:new `x`:delete

**Global:** `1-9`:switch tabs `Tab`:toggle pane `e`:events `q`:quit

## TUI Design System

**Status bar = single source of truth for shortcuts.** Hints update based on active tab + pane + overlay. No shortcut text inside panels, overlays, or forms.

**Spinners:**
- Status bar: icon only (no label) - signals "system is busy"
- Panel: detailed progress text ("Indexing... 50 files") - shows what's happening

**Overlay hints:** When a form/overlay is active, status bar shows form controls (`Enter:confirm Esc:cancel`) instead of tab hints. Overlay state flows up via `onOverlayChange` callbacks from tabs to App.tsx to StatusBar.

**Focus system:** The TUI uses `useFocus` context (`packages/tui/hooks/useFocus.ts`) for keyboard input ownership. When a form/overlay opens, it pushes onto the focus stack and takes ownership of all input (including Tab). App-level shortcuts only fire when no child component owns focus.

**SessionsTab sub-components:** SessionsTab was split into focused sub-components: `SessionDetail`, `MoveToGroup`, `GroupManager`, `TalkToSession`, `CloneSession`. Each manages its own overlay lifecycle and reports focus state upward.

**Helper modules:**
- `helpers/statusBarHints.tsx` - centralized status bar hint generation per tab/pane/overlay state
- `helpers/sessionFormatting.ts` - shared session display formatting (status colors, labels, summaries)

## App Boot System

`app.ts` provides `AppContext` -- initializes repositories, services, resource stores, conductor, metrics polling, and config. CLI creates it with `skipConductor: true` (only TUI runs the conductor). `config.ts` loads `~/.ark/config.yaml` for user preferences.

```ts
const app = new AppContext(loadConfig());
await app.boot();   // starts conductor + metrics
await app.shutdown(); // cleanup on exit
```

## TUI Async Rules (CRITICAL)

**Every I/O operation in the TUI MUST be non-blocking.** No exceptions.

The TUI uses `useAsync` hook which provides `asyncState.run(label, fn)` - it queues work, shows a spinner with the label, and keeps the UI responsive.

```ts
// useInput handlers: ALWAYS wrap I/O in asyncState.run()
asyncState.run("Label...", async () => { await core.doThing(); status.show("Done"); refresh(); });

// Render bodies: ALWAYS use useMemo or useEffect for I/O
const data = useMemo(() => core.loadData(id), [id]);
```

**Rules:**
- `useInput` handlers: wrap ALL `core.*` calls in `asyncState.run(label, fn)`
- Render bodies: wrap ALL `core.*` calls in `useMemo` or `useEffect`
- Never use `execFileSync` in handlers - use async variants (`sessionExistsAsync`, `capturePaneAsync`)
- After mutations inside `asyncState.run()`, call `refresh()` to update the TUI
- Use `status.show(msg)` for user feedback inside async operations
- Long operations (file scanning, indexing): use `async` fn with periodic `await new Promise(r => setTimeout(r, 0))` to yield to the event loop

**Existing async infrastructure:**
- `useAsync` hook: `packages/tui/hooks/useAsync.ts` - queued action runner with spinner
- `useSessionActions`: `packages/tui/hooks/useSessionActions.ts` - all session mutations (dispatch, stop, restart, delete, clone, complete)
- `useComputeActions`: `packages/tui/hooks/useComputeActions.ts` - all compute mutations (provision, stop, start, delete, clean)
- `useStatusMessage`: `packages/tui/hooks/useStatusMessage.ts` - temporary status messages with auto-clear

## Hook-Based Agent Status

Ark uses Claude Code hooks for agent status detection. At dispatch time, `claude.writeHooksConfig()` writes `.claude/settings.local.json` to the session working directory with HTTP hooks that POST status events to the conductor.

**Hooks are ONLY for status detection** (busy/idle/error/done). They are NOT part of the channel/conductor communication system. Channels handle agent↔human messaging via MCP.

Key files: `claude.ts` (writeHooksConfig, removeHooksConfig), `conductor.ts` (/hooks/status endpoint), `session-orchestration.ts` (applyHookStatus wiring).

## Code Style

- TypeScript with `strict: false`
- ES modules (`"type": "module"`) - always use `.js` import extensions
- React + Ink for TUI components
- YAML for agent/flow definitions
- SQLite for local persistence, PostgreSQL for hosted mode (IDatabase abstraction, no ORM)
- **Never use em dashes** (U+2014). Use hyphens (-) or dashes (--) instead. This applies to code, comments, strings, and documentation.

## Architecture Boundaries

- **`packages/types/`** - All domain interfaces (`Session`, `Compute`, `Event`, `Message`, `TenantContext`, etc.). Single source of truth. No logic, no dependencies. Imported by every other package.
- **`repositories/`** - SQL CRUD behind typed classes. Column whitelists prevent injection. `SessionRepository`, `ComputeRepository`, `EventRepository`, `MessageRepository`, `TodoRepository`. Access via `app.sessions`, `app.computes`, `app.todos`, etc.
- **`stores/`** - File-backed resource stores with three-tier resolution (builtin > global/user > project). `FlowStore`, `SkillStore`, `AgentStore`, `RecipeStore`, `RuntimeStore`. Access via `app.flows`, `app.skills`, `app.agents`, `app.recipes`, `app.runtimes`. Each store has `list()`, `get()`, `save()`, `delete()` methods.
- **`knowledge/`** - Knowledge graph. `KnowledgeStore` (nodes + edges in SQLite), `indexer.ts` (codebase indexing), `context.ts` (context builder for agent prompts), `mcp.ts` (MCP tool handler), `export.ts` (markdown export/import). Access via `app.knowledge`.
- **`database.ts` / `database-sqlite.ts` / `database-postgres.ts`** - `IDatabase` abstraction. SQLite for local, PostgreSQL for hosted. All repositories and stores use `IDatabase`, not raw bun:sqlite.
- **`auth.ts` + `api-keys.ts`** - Multi-tenant auth middleware. API key validation, tenant context extraction, role-based access control (admin/member/viewer).
- **`tenant-policy.ts`** - Tenant compute policies (allowed providers, max sessions, cost caps). `TenantPolicyManager` uses `IDatabase`.
- **`hosted.ts`** - Hosted mode entry point. Boots AppContext with worker registry, session scheduler, tenant policies, optional Redis SSE bus, optional LLM router.
- **`packages/router/`** - LLM Router. OpenAI-compatible `/v1/chat/completions` proxy. 3 routing policies (quality/balanced/cost), circuit breakers, request classification, cost tracking. Separate from the server `Router` class (which is the JSON-RPC method dispatcher).
- **`services/session.ts`** - `SessionService` facade. Owns simple lifecycle (start, stop, resume, complete, pause, delete). Delegates complex ops to `session-orchestration.ts` via dynamic import.
- **`services/session-orchestration.ts`** - All orchestration: dispatch, advance, fork, clone, spawn, fan-out, handoff, worktree ops, hook status, report handling. Every exported function takes `app: AppContext` as its first argument -- no `getApp()` calls.
- **`provider-registry.ts`** - Provider resolver plumbing between `app.ts` and `session-orchestration.ts`. Breaks what was a circular import.
- **`packages/server/validate.ts`** - `extract<T>()` validates RPC params at the boundary. All handlers use it.
- **`constants.ts`** - Shared URL/port defaults (`DEFAULT_CONDUCTOR_URL`, `DEFAULT_ARKD_URL`, `DOCKER_CONDUCTOR_URL`, `DEFAULT_ROUTER_URL`). All providers and executors use these.
- **`claude.ts`** - ALL Claude Code knowledge (model mapping, args, hooks config, launcher, trust, transcript parsing).
- **`conductor.ts`** - HTTP server (:19100). Channel reports + hook status. Receives `app: AppContext` via `startConductor(app, port)` -- no `getApp()` calls. Delegates to `session-orchestration.ts` for applyHookStatus/applyReport.
- **`arkd/`** - Stateless HTTP daemon (:19300) on every compute target. Agent lifecycle, file ops, metrics, channel relay.
- **`search.ts`** - Search + FTS5. Uses FTS5 when index exists, falls back to file scanning only when FTS table is absent.
- **`app.ts`** - Boot/shutdown. Creates repos, services, stores, providers, knowledge store. CLI skips conductor; TUI runs it. Supports Awilix DI container via `container.ts`.
- **`packages/tui/hooks/useFocus.ts`** - Focus stack for TUI keyboard input ownership.

## Knowledge Graph

The knowledge graph (`packages/core/knowledge/`) provides a unified view of codebase structure, session history, memories, and learnings.

**Components:**
- **KnowledgeStore** (`store.ts`) - Node/edge storage in SQLite. Nodes have type (file, symbol, session, memory, learning, skill, recipe, agent), label, content, and metadata. Edges have relationship types (depends_on, imports, modified_by, etc.).
- **Indexer** (`indexer.ts`) - Indexes a codebase into the knowledge graph (files, symbols, dependencies).
- **Context Builder** (`context.ts`) - Builds relevant knowledge context for agent prompts at dispatch time.
- **MCP Tools** (`mcp.ts`) - MCP tool handler for agent queries against the knowledge graph.
- **Export/Import** (`export.ts`) - Markdown export/import for portability.

**CLI:** `ark knowledge search`, `ark knowledge index`, `ark knowledge stats`, `ark knowledge remember`, `ark knowledge recall`, `ark knowledge export`, `ark knowledge import`, `ark knowledge ingest`.

**Prerequisite:** The indexer uses Axon (if available) for symbol extraction. Without Axon, file-level indexing still works.

## Control Plane (Hosted Mode)

`hosted.ts` starts Ark as a multi-tenant control plane:

- **Worker Registry** (`worker-registry.ts`) - Workers register via HTTP, health-checked every 60s, stale workers pruned after 90s.
- **Session Scheduler** (`scheduler.ts`) - Assigns sessions to available workers, respects tenant policies.
- **Tenant Policies** (`tenant-policy.ts`) - Per-tenant: allowed providers, default provider, max concurrent sessions, daily cost cap, compute pools.
- **SSE Bus** - In-memory (`sse-bus.ts`) or Redis-backed (`sse-redis.ts`) for multi-instance deployments.
- **IDatabase** - `database-postgres.ts` for hosted mode (connection string via `DATABASE_URL`).

Start hosted mode: `ark server start --hosted`.

## Remote Client Mode

CLI, TUI, and Web can connect to a remote Ark server instead of running locally:

```bash
ark --server https://ark.company.com --token ark_default_xxx session list
ark tui --server https://ark.company.com --token ark_default_xxx
```

Set via `ARK_SERVER` and `ARK_TOKEN` env vars. When remote mode is active, the CLI creates a WebSocket `ArkClient` to the remote server instead of booting a local AppContext.

## LLM Router

The LLM Router (`packages/router/`) is an OpenAI-compatible proxy that routes requests across multiple LLM providers.

- **3 Routing Policies:** `quality` (prefer best model), `balanced` (optimize cost/quality), `cost` (minimize cost)
- **Circuit Breakers:** Per-provider failure tracking with automatic fallback
- **Request Classification:** Classifies prompt complexity to select appropriate model tier
- **Cost Tracking:** Per-request cost accumulation with model/provider breakdown

Start: `ark router start [--port 8430] [--policy balanced]`
Status: `ark router status`
Costs: `ark router costs`
