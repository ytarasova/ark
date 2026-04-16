# Ark

Autonomous agent ecosystem. Orchestrates AI coding agents through DAG-based SDLC flows with 11 compute providers, unified knowledge graph (ops-codegraph indexer), LLM router + optional TensorZero gateway, and multi-tenant control plane. Supports Claude Code, Codex, Gemini CLI, and Goose runtimes. Bun + tmux only -- no Python dependencies.

## Commands

```bash
make install          # bun install + symlink ark to /usr/local/bin
make test             # run all tests sequentially (NEVER parallel -- ports collide)
make test-file F=path # run a single test file
make lint             # ESLint (zero warnings allowed)
make format-check     # Prettier check (CI gate)
make format           # Prettier auto-fix
make dev              # hot-reload: API (:8420) + Vite HMR (:5173)
make dev-web          # same as dev (alias)
make dev-daemon       # hot-reload: server daemon (conductor + arkd + WS)
make claude-tfy       # Claude Code via TrueFoundry gateway
./ark <command>       # run CLI directly via bun
```

Key CLI commands: `ark session start|list|show|stop|events`, `ark search <query>`, `ark index`, `ark arkd`, `ark server daemon start|stop|status`, `ark skill|recipe|runtime|agent list|show`, `ark knowledge search|index|stats`.

## Dogfooding

```bash
ark server daemon start --detach   # prerequisite: conductor (:19100) + arkd (:19300)
ark session start --flow autonomous-sdlc --repo "$(pwd)" --summary "Task" --dispatch
ark session list && ark session show <id>
tmux attach -t ark-s-<id>
```

Stuck session? `curl localhost:19100/health` + `curl localhost:19300/health`. Kill stale: `lsof -ti:19100 | xargs kill`.

## Project Structure

```
packages/
  cli/       -> Commander.js CLI entry
  core/      -> Sessions, stores, flows, agents, channels, conductor, search, app context
    knowledge/     -> Knowledge graph (store, indexer via ops-codegraph, context builder, MCP tools)
    repositories/  -> SQL CRUD (Session, Compute, ComputeTemplate, Event, Message, Todo)
    services/      -> SessionService (lifecycle) + session-orchestration.ts (dispatch, advance, fork, fan-out)
    stores/        -> Resource stores (Flow, Skill, Agent, Recipe, Runtime) -- three-tier file resolution
    runtimes/      -> Transcript parsers per runtime (claude, codex, gemini)
    observability/ -> PricingRegistry, UsageRecorder (cost modes: api/subscription/free)
    router/        -> TensorZero lifecycle manager
  compute/   -> 11 providers: local, docker, devcontainer, firecracker, ec2, ec2-docker, ec2-devcontainer, ec2-firecracker, e2b, k8s, k8s-kata
  arkd/      -> Universal agent daemon (:19300) on every compute target
  router/    -> LLM Router -- OpenAI-compatible proxy, 3 routing policies, circuit breakers
  server/    -> JSON-RPC handlers (delegate to services via AppContext)
  protocol/  -> ArkClient (typed JSON-RPC client)
  web/       -> Vite web dashboard (SSE live updates, Recharts)
  desktop/   -> Electron shell wrapping the web dashboard
  types/     -> Domain interfaces (Session, Compute, Event, Message, Tenant, etc.)
agents/      -> 12 agent YAML definitions
runtimes/    -> 5 runtime definitions (claude, claude-max, codex, gemini, goose)
flows/       -> 13 flow definitions (autonomous-sdlc, quick, fan-out, pr-review, etc.)
skills/      -> 7 builtin skills
recipes/     -> 8 recipe templates
mcp-configs/ -> MCP config stubs
.infra/      -> Dockerfile, docker-compose, Helm chart
```

No workspaces -- packages coordinated via relative imports.

**Key entry points:**
- `AppContext` (`app.ts`) -- repos: `app.sessions`, `app.computes`; services: `app.sessionService`; stores: `app.flows`, `app.skills`, `app.agents`, `app.recipes`
- `SessionService` (`services/session.ts`) -- lifecycle facade. Delegates complex ops to `session-orchestration.ts`
- `session-orchestration.ts` -- all orchestration. Every function takes `app: AppContext` as first arg (no `getApp()`)

## Key Gotchas

**No migrations.** `repositories/schema.ts` is the authoritative schema. Changing column types = `rm ~/.ark/ark.db` (recreates on boot). New columns with `DEFAULT` are transparent (`IF NOT EXISTS`).

**Bun-only.** Uses `bun:sqlite`, `Bun.serve()`, `Bun.sleep()`, Bun FFI. Will not run under Node.

**Tmux required.** Sessions launch agents in tmux (`ark-s-<id>`). No fallback.

**ES module `.js` extensions required.** `import { foo } from "./bar.js"` -- omitting `.js` breaks at runtime.

**`strict: false` in tsconfig.** Implicit `any` allowed; no strict null checks.

**SQL columns match TS fields 1:1.** No mapping. Add new Session fields to the column whitelist in `repositories/session.ts`.

**Port map:** 19100 (conductor), 19300 (arkd), 19400 (server daemon WS). Channel ports: `19200 + (parseInt(sessionId.replace("s-",""), 16) % 10000)`. All hardcoded in conductor.ts, channel.ts, constants.ts.

**Never use em dashes** (U+2014). Use hyphens (-) or double dashes (--) everywhere.

## Testing

Tests use `bun:test`. **Always use make targets** -- never call `bun test` directly.

**NEVER run tests in parallel.** Tests share ports (19100, 19200, 19300), globalThis state, and SQLite databases. Parallel = phantom failures.

```bash
make test                                                  # all tests (sequential)
make test-file F=packages/core/__tests__/session.test.ts   # single file
```

**Test isolation** -- use `AppContext.forTest()`:
```ts
let app: AppContext;
beforeAll(async () => { app = AppContext.forTest(); await app.boot(); setApp(app); });
afterAll(async () => { await app?.shutdown(); clearApp(); });
```

Access repos: `app.sessions.create(...)`. Orchestration: `dispatch(app, sessionId)`.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ARK_CONDUCTOR_PORT` | `19100` | Conductor HTTP port |
| `ARK_ARKD_PORT` / `ARK_ARKD_URL` | `19300` / `http://localhost:19300` | ArkD daemon |
| `ARK_SERVER_PORT` / `ARK_SERVER_URL` | `19400` / `http://localhost:19400` | Server daemon WS |
| `ARK_SERVER` | - | Remote server URL (enables remote client mode) |
| `ARK_TOKEN` | - | API key for remote server auth |
| `DATABASE_URL` | - | PostgreSQL (hosted mode; defaults to SQLite) |
| `REDIS_URL` | - | Redis SSE bus (hosted mode; defaults to in-memory) |
| `ARK_TEST_DIR` | - | Temp dir for test isolation |

## Data Locations

| Path | Purpose |
|------|---------|
| `~/.ark/ark.db` | SQLite (WAL). All tenant-scoped tables + FTS5 transcript_index |
| `~/.ark/config.yaml` | User config (router, knowledge, tensorzero, compute_templates, budgets, auth) |
| `~/.ark/server.pid` | Server daemon PID |
| `~/.ark/tracks/<id>/` | Launcher scripts, channel configs |
| `~/.ark/worktrees/<id>/` | Git worktrees for isolated sessions |
| `~/.ark/{skills,recipes,flows,agents,runtimes}/` | User-tier resource definitions (global) |
| `.codegraph/graph.db` | Per-repo ops-codegraph index |
| `~/.claude/projects/` | Claude Code transcripts (JSONL) |
| `.claude/settings.local.json` | Per-session hook config (written at dispatch) |

## Agents, Runtimes, Flows, Skills, Recipes

All use **three-tier resolution**: builtin (`agents/`, `runtimes/`, etc.) > global (`~/.ark/<type>/`) > project (`.ark/<type>/`).

- **Agents** define WHAT (role, prompt, skills, tools). Template vars: `{ticket}`, `{summary}`, `{workdir}`, `{repo}`, `{branch}`.
- **Runtimes** define HOW (LLM backend, CLI command, billing mode). Types: `claude-code`, `cli-agent`, `subprocess`, `goose`.
- **Flows** define stages with agents, gates (`manual`/`auto`/`condition`), and `verify` scripts.
- **Skills** are reusable prompt fragments injected into agent system prompts at dispatch.
- **Recipes** are session templates with variables. CLI: `ark recipe list`.

Override runtime at dispatch: `ark session start --agent implementer --runtime codex --dispatch`.

## Executor System

Runtime `type` selects the executor: `claude-code` (default, tmux + hooks + MCP), `subprocess` (child process), `cli-agent` (tmux + worktree), `goose` (native with recipe dispatch + `--with-extension`). Interface: `launch`, `kill`, `status`, `send`, `capture` in `packages/core/executor.ts`. Plugin executors: `~/.ark/plugins/executors/*.js`.

When `router.enabled`, executors inject `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` so agent LLM calls flow through the router transparently.

## Hook-Based Agent Status

Claude Code hooks POST status (busy/idle/error/done) to conductor. Written by `claude.writeSettings()`. Hooks = status only; channels = messaging via MCP.

## Hosted Mode

Multi-tenant control plane via `ark server start --hosted`. PostgreSQL (`DATABASE_URL`), Redis SSE bus (`REDIS_URL`), tenant-scoped AppContext (`app.forTenant(id)`). Every table has `tenant_id`.

## LLM Router

`packages/router/` -- OpenAI-compatible proxy with 3 routing policies + circuit breakers. Optional TensorZero backend. Config: `~/.ark/config.yaml` under `tensorZero:`. Start: `ark router start`.

## Before Committing (CRITICAL)

**Every commit MUST pass formatting and linting. CI will reject otherwise.**

```bash
make format           # auto-fix Prettier (MUST run before every commit)
make lint             # ESLint zero-warning check (MUST pass)
make test             # run if you touched core logic
```

If you skip `make format`, CI fails with "Code style issues found." If you skip `make lint`, CI fails with lint warnings. No exceptions.

## Code Style

- TypeScript, `strict: false`, ES modules with `.js` extensions
- Prettier: 120 char line width, double quotes, trailing commas
- ESLint: zero warnings allowed
- YAML for agent/flow/runtime/skill/recipe definitions
- SQLite local, PostgreSQL hosted (IDatabase abstraction, no ORM)
- Never use em dashes (U+2014). Use hyphens (-) or double dashes (--)
