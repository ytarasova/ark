# Ark

Autonomous agent ecosystem. Orchestrates AI coding agents through DAG-based SDLC flows with 11 compute providers, knowledge graph, LLM router, and multi-tenant control plane. Supports Claude Code, Codex, Gemini CLI, and Goose runtimes. Bun + tmux only.

## Commands

```bash
make install          # bun install + symlink ark to /usr/local/bin
make test             # run all tests sequentially (NEVER parallel -- ports collide)
make test-file F=path # run a single test file
make lint             # ESLint (zero warnings allowed)
make format           # Prettier auto-fix
make dev              # hot-reload: API (:8420) + Vite HMR (:5173)
make dev-daemon       # hot-reload: server daemon (conductor + arkd + WS)
./ark <command>       # run CLI directly via bun
```

## Before Committing (CRITICAL)

**Every commit MUST pass formatting and linting. CI rejects otherwise.**

```bash
make format           # MUST run before every commit
make lint             # MUST pass (zero warnings)
make test             # run if you touched logic
```

## Project Structure

```
packages/
  cli/       -> Commander.js CLI entry
  core/      -> Sessions, stores, flows, agents, channels, conductor, search, app context
  compute/   -> 11 providers (local, docker, devcontainer, firecracker, ec2-*, e2b, k8s, k8s-kata)
  arkd/      -> Universal agent daemon (:19300) on every compute target
  router/    -> LLM Router (OpenAI-compatible proxy, 3 policies, circuit breakers)
  server/    -> JSON-RPC handlers (delegate to services via AppContext)
  protocol/  -> ArkClient (typed JSON-RPC client)
  web/       -> Vite web dashboard (SSE, Recharts)
  desktop/   -> Electron shell wrapping the web dashboard
  types/     -> Domain interfaces
agents/      -> Agent YAML definitions
runtimes/    -> Runtime definitions (claude, codex, gemini, goose)
flows/       -> Flow definitions (autonomous-sdlc, quick, fan-out, etc.)
skills/      -> Builtin skills
recipes/     -> Recipe templates
.infra/      -> Dockerfile, docker-compose, Helm chart
```

No workspaces -- packages coordinated via relative imports.

**Key entry points:**
- `AppContext` (`app.ts`) -- repos: `app.sessions`, `app.computes`; services: `app.sessionService`; stores: `app.flows`, `app.skills`, `app.agents`, `app.recipes`
- `SessionService` (`services/session.ts`) -- lifecycle facade, delegates to `session-orchestration.ts`
- `session-orchestration.ts` -- all orchestration. Every function takes `app: AppContext` as first arg

## Key Gotchas

**No migrations.** `repositories/schema.ts` is the authoritative schema. Column changes = `rm ~/.ark/ark.db` (recreates on boot).

**Bun-only.** Uses `bun:sqlite`, `Bun.serve()`, `Bun.sleep()`. Will not run under Node.

**Tmux required.** Sessions launch agents in tmux (`ark-s-<id>`). No fallback.

**ES module `.js` extensions required.** `import { foo } from "./bar.js"` -- omitting `.js` breaks at runtime.

**`strict: false` in tsconfig.** Implicit `any` allowed; no strict null checks.

**SQL columns match TS fields 1:1.** Add new Session fields to the whitelist in `repositories/session.ts`.

**Port map:** 19100 (conductor), 19300 (arkd), 19400 (server daemon WS), 8420 (web). Channel ports: `19200 + (parseInt(sessionId.replace("s-",""), 16) % 10000)`.

**Never use em dashes** (U+2014). Use hyphens (-) or double dashes (--) everywhere.

## Testing

Tests use `bun:test`. **Always use make targets** -- never call `bun test` directly.

**NEVER run tests in parallel.** Shared ports + globalThis state + SQLite = phantom failures.

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

## Code Style

- TypeScript, `strict: false`, ES modules with `.js` extensions
- Prettier: 120 char line width, double quotes, trailing commas
- ESLint: zero warnings allowed
- YAML for agent/flow/runtime/skill/recipe definitions
- SQLite local, PostgreSQL hosted (no ORM)
- Never use em dashes (U+2014)
