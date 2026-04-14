# Contributing to Ark

Thanks for your interest in contributing to Ark! This guide covers development setup, code style, testing, and how to submit changes.

For deeper architectural details, see [CLAUDE.md](CLAUDE.md). For the full user-facing documentation, see the [docs site](https://ytarasova.github.io/ark/).

## Prerequisites

- [Bun](https://bun.sh) -- runtime and package manager (required; Node.js will not work)
- `tmux` -- session multiplexer for running agents
- `git` -- for worktree-based session isolation
- `gh` (optional) -- GitHub CLI for auto-PR creation

> **Bun-only.** Ark uses `bun:sqlite`, `Bun.serve()`, `Bun.sleep()`, and Bun FFI. It will not run under Node.js.

## Getting Started

```bash
git clone https://github.com/ytarasova/ark.git
cd ark
make install   # bun install + symlink ark to /usr/local/bin
ark --version  # verify installation
```

## Development Workflow

```bash
make dev            # Hot-reload: API server (:8420) + Vite dev server (:5173)
make dev-daemon     # Hot-reload: server daemon (conductor :19100 + arkd :19300 + WS :19400)
make dev-tui        # Hot-reload: TUI connecting to dev daemon
make dev-web        # Hot-reload: API server + Vite frontend
make tui-standalone # TUI without daemon (embedded mode)
./ark <command>     # Run CLI directly from source
```

## Code Style

- TypeScript with `strict: false` (implicit `any` allowed, no strict null checks)
- ES modules (`"type": "module"`)
- React + Ink for TUI, React + Vite + Tailwind for Web
- YAML for agent/flow/runtime/recipe definitions
- SQLite for local, PostgreSQL for hosted mode (`IDatabase` abstraction, no ORM)
- Never use em dashes (U+2014) -- use hyphens (`-`) or double dashes (`--`) instead
- No global state -- pass `app: AppContext` as the first argument; never call `getApp()` from utility functions

### Import Extensions

All relative imports **must** use `.js` extensions, even in TypeScript files. This is required by Bun's ES module resolution.

```ts
// Correct
import { foo } from "./bar.js";

// Wrong -- breaks at runtime
import { foo } from "./bar";
```

## Testing

Tests use `bun:test`. **Always use make targets** -- never call `bun test` directly.

```bash
make test                                                  # All tests (sequential)
make test-file F=packages/core/__tests__/session.test.ts   # Single file
make test-e2e                                              # Playwright E2E (TUI + Web)
make test-watch                                            # Watch mode
```

> **Never run tests in parallel.** Tests share ports (19100, 19200, 19300), globalThis state, and SQLite databases. The Makefile enforces `--concurrency 1` to prevent port collisions and phantom failures.

### Test Isolation

Use `AppContext.forTest()` for isolated test contexts:

```ts
import { AppContext, setApp, clearApp } from "../app.js";

let app: AppContext;
beforeAll(async () => {
  app = AppContext.forTest();
  await app.boot();
  setApp(app);
});
afterAll(async () => {
  await app?.shutdown();
  clearApp();
});
```

`AppContext.forTest()` creates a temporary directory with an isolated database. The temp directory is cleaned up on shutdown.

### waitFor() Utility

Polls a condition until it returns true (or times out). Useful for testing async state transitions:

```ts
await waitFor(() => getSession(id).status === "running");
```

### E2E Tests

E2E tests require `dist/` to be built first:

```bash
make dev   # or just tsc
make test-e2e
```

TUI E2E tests use a browser harness (xterm.js + real pty + real tmux). Web E2E tests use Playwright.

## Schema Changes

There is no formal migration layer (pre-pilot, no production data worth preserving). The authoritative schema lives in `packages/core/repositories/schema.ts`.

- **Adding a new table or column with DEFAULT**: transparent -- tables use `IF NOT EXISTS`.
- **Renaming or changing a column type**: delete the database and restart: `rm ~/.ark/ark.db`

## Project Structure

See the [Architecture section in README.md](README.md#architecture) for the full layout. Key entry points:

| Entry Point | Purpose |
|-------------|---------|
| `AppContext` (`packages/core/app.ts`) | Wires repos, services, stores. Access via `app.sessions`, `app.flows`, etc. |
| `SessionService` (`packages/core/services/session.ts`) | Lifecycle facade: start, stop, resume, complete, pause, delete |
| `session-orchestration.ts` (`packages/core/services/session-orchestration.ts`) | All orchestration (dispatch, advance, fork, fan-out). Every function takes `app: AppContext` as first arg. |

## Submitting Changes

1. Fork the repository
2. Create a feature branch: `git checkout -b my-feature`
3. Make your changes
4. Run `make test` and ensure all tests pass
5. Run `make lint` to check style
6. Commit with a clear, descriptive message
7. Open a pull request against `main`
   - PR title: short and descriptive (under 70 characters)
   - PR body: explain what changed and why; link to an issue if applicable

## Self-Dogfooding

Ark can dispatch agents against its own codebase:

```bash
make self TASK="Describe the feature or fix"        # Full SDLC (plan, implement, review, PR)
make self-quick TASK="Quick task description"        # Single-agent quick fix
```

## Reporting Issues

File issues at [github.com/ytarasova/ark/issues](https://github.com/ytarasova/ark/issues). Please include:

- Ark version (`ark --version`)
- Operating system and architecture
- Steps to reproduce
- Expected vs actual behavior
