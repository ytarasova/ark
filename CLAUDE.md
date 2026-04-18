# Ark

Autonomous agent ecosystem. Orchestrates AI coding agents through DAG-based SDLC flows with 11 compute providers, knowledge graph, LLM router, and multi-tenant control plane. Supports Claude Code, Codex, Gemini CLI, and Goose runtimes. Bun + tmux only.

## Commands

```bash
make install          # bun install + symlink ark to /usr/local/bin
make test             # run all tests (sequential for now; see Testing section)
make test-file F=path # run a single test file
make lint             # ESLint (zero warnings allowed)
make format           # Prettier auto-fix
make dev              # hot-reload: API (:8420) + Vite HMR (:5173) + auto-starts daemon
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

**Port map:** 19100 (conductor), 19300 (arkd), 19400 (server daemon WS), 8420 (web). Channel ports: `config.channels.basePort + (hash(sessionId) % config.channels.range)` (default basePort 19200, range 10000; test profile randomizes basePort). Use `config.channels.*` -- don't hardcode.

**Never use em dashes** (U+2014). Use hyphens (-) or double dashes (--) everywhere.

## Testing

Tests use `bun:test`. **Always use make targets** -- never call `bun test` directly.

`make test` still runs sequentially today (`--concurrency 1`) because some legacy tests share module-level singletons (`_app` in `app.ts`, `_arkDir` / `_level` in `structured-log.ts`, the hooks event bus). Parallelisation is being unlocked incrementally: the Spring-style config work lets arkd and the config resolver tests run at `--concurrency 4` safely; other packages still need migration. Until then:

```bash
make test                                                  # sequential (default)
make test-file F=packages/core/__tests__/session.test.ts   # single file (sequential)
bun test packages/arkd --concurrency 4                     # arkd runs fine parallel
```

**Test isolation for new tests** -- use `AppContext.forTestAsync()`:

```ts
let app: AppContext;
beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});
afterAll(async () => {
  await app?.shutdown();
  clearApp();
});
```

`forTestAsync()` routes through the `test` config profile which allocates a fresh arkDir and four ephemeral ports (conductor/arkd/server/web) per call, so the same file can run in parallel workers without port collisions. The legacy synchronous `AppContext.forTest()` is kept for tests that haven't been migrated.

**Never hardcode a port** in a new test. Call `allocatePort()` from `packages/core/config/port-allocator.ts`, or get it via `app.config.ports.*` when you have an AppContext.

### Config surface

One authoritative `AppConfig` in `packages/core/config.ts` (Spring-Boot-style). Resolved from layers, highest precedence first:

1. Programmatic overrides (`loadAppConfig({ ports: { conductor: 12345 } })`).
2. CLI flags.
3. `ARK_*` env vars (typed coercion in `config/env-source.ts`).
4. `{arkDir}/config.yaml`, with optional `profiles.<name>:` overlay blocks.
5. Profile defaults (`config/profiles.ts`): `local` (default), `control-plane`, `test`.

Active profile = explicit arg > `ARK_PROFILE` env > heuristics (`NODE_ENV=test` -> test; postgres `DATABASE_URL` -> control-plane; else local).

Env-var -> Config field map:

| Env var                              | Config field                        | Default                       |
| ------------------------------------ | ----------------------------------- | ----------------------------- |
| `ARK_PROFILE`                        | `config.profile`                    | heuristic                     |
| `ARK_DIR` (or legacy `ARK_TEST_DIR`) | `config.dirs.ark`                   | `~/.ark`                      |
| `ARK_CONDUCTOR_PORT`                 | `config.ports.conductor`            | 19100                         |
| `ARK_ARKD_PORT`                      | `config.ports.arkd`                 | 19300                         |
| `ARK_SERVER_PORT`                    | `config.ports.server`               | 19400                         |
| `ARK_WEB_PORT`                       | `config.ports.web`                  | 8420                          |
| `ARK_CHANNEL_BASE_PORT`              | `config.channels.basePort`          | 19200                         |
| `ARK_CHANNEL_RANGE`                  | `config.channels.range`             | 10000                         |
| `ARK_LOG_LEVEL`                      | `config.observability.logLevel`     | info                          |
| `ARK_OTLP_ENDPOINT`                  | `config.observability.otlpEndpoint` | -                             |
| `ARK_AUTH_REQUIRE_TOKEN`             | `config.authSection.requireToken`   | false (true in control-plane) |
| `ARK_DEFAULT_TENANT`                 | `config.authSection.defaultTenant`  | null                          |
| `ARK_AUTO_REBASE`                    | `config.features.autoRebase`        | false                         |
| `ARK_CODEGRAPH`                      | `config.features.codegraph`         | false                         |
| `DATABASE_URL`                       | `config.database.url`               | undefined (SQLite)            |

YAML format (`~/.ark/config.yaml`):

```yaml
# top-level defaults apply to every profile
ports:
  conductor: 19100
  arkd: 19300
channels:
  basePort: 19200
  range: 10000
observability:
  logLevel: info

# profile overlays merge on top of the top level
profiles:
  control-plane:
    auth:
      requireToken: true
  test: {} # test profile uses dynamic allocation; overlay usually empty
```

New code should prefer nested accessors (`app.config.ports.conductor`). Legacy flat fields (`app.config.conductorPort`) are retained for back-compat and will eventually be removed.

## Code Style

- TypeScript, `strict: false`, ES modules with `.js` extensions
- Prettier: 120 char line width, double quotes, trailing commas
- ESLint: zero warnings allowed
- YAML for agent/flow/runtime/skill/recipe definitions
- SQLite local, PostgreSQL hosted (no ORM)
- Never use em dashes (U+2014)
