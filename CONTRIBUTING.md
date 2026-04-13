# Contributing to Ark

Thanks for taking the time to contribute. Ark is an orchestration layer for AI coding agents, and we welcome bug reports, feature proposals, docs improvements, and code changes.

This file is the quick-reference contributor guide. For deeper material see:

- [CLAUDE.md](CLAUDE.md) -- authoritative developer reference (architecture, boundaries, gotchas)
- [docs/guide.md](docs/guide.md) -- user guide and feature walkthrough
- [docs/development.html](docs/development.html) -- long-form development docs (module layers, testing patterns, schema, style)
- [docs/cli-reference.md](docs/cli-reference.md) -- every CLI command and option

## Prerequisites

- macOS (arm64 or x64) or Linux (arm64 or x64)
- [Bun](https://bun.sh) -- runtime and package manager. Node.js will not work. Ark uses `bun:sqlite`, `Bun.serve()`, `Bun.sleep()`, and Bun FFI.
- `tmux` -- sessions launch agents inside tmux (`ark-s-<id>`). There is no fallback.
- `git` -- required for worktree-based session isolation
- `gh` (optional) -- GitHub CLI, used by the auto-PR feature
- At least one CLI coding agent: [Claude Code](https://docs.anthropic.com/en/docs/claude-cli), [Codex](https://github.com/openai/codex), or [Gemini CLI](https://github.com/google-gemini/gemini-cli)

## Setup

```bash
git clone https://github.com/ytarasova/ark.git
cd ark
make install    # bun install + symlink ark into your PATH
ark doctor      # verify the environment
```

For day-to-day development:

```bash
make dev              # TypeScript watch
make tui              # run the TUI from source
make web              # run the web dashboard
make test             # run all tests sequentially
make lint             # ESLint + type checks
```

## Reporting Issues

Before opening a new issue, please search existing issues. When filing:

- **Bugs**: include Ark version (`ark --version`), OS, the exact command you ran, expected vs. actual behaviour, and any relevant logs or session IDs. If the bug involves an agent session, attach the output of `ark session events <id>` and `ark session show <id>`.
- **Features**: describe the use case first, then the proposed solution. Link to any related issues or prior discussion.

## Development Workflow

1. **Fork and branch.** Create a branch off `main` named `feature/<short-name>` or `bugfix/<short-name>`.
2. **Read before you edit.** Skim [CLAUDE.md](CLAUDE.md) for the relevant subsystem. Ark has strong architectural boundaries (repositories, stores, services, orchestration) and the file documents them.
3. **Implement.** Keep the change focused. Don't refactor unrelated code, don't add speculative abstractions, and don't introduce new dependencies without discussion.
4. **Test.** Add or update tests alongside the change. See [Testing](#testing) below.
5. **Lint and type-check.** `make lint` must pass.
6. **Commit.** See [Commit Messages](#commit-messages).
7. **Open a PR** against `main`. Describe the problem, the fix, and how you verified it. Link any related issues.

### Architectural Principles

A few rules that come up often in reviews:

- **Pass state as arguments.** Utility functions must not call `getApp()` or `ARK_DIR()`. Every orchestration function takes `app: AppContext` as its first argument.
- **Respect the layering.** Types -> database -> repositories/stores -> services/orchestration -> server -> CLI/TUI/Web. Don't reach across layers.
- **Use the `IDatabase` abstraction.** Local mode runs SQLite, hosted mode runs PostgreSQL. Don't import `bun:sqlite` outside `database-sqlite.ts`.
- **Tenant scoping.** Every new entity table needs a `tenant_id` column and queries must filter by it. Use `app.forTenant(tenantId)` in hosted-mode code paths.

## Code Style

- **TypeScript** with `strict: false`. Implicit `any` is allowed. No strict null checks. This is deliberate and not up for change right now.
- **ES modules.** `"type": "module"` in `package.json`. All relative imports must use `.js` extensions even in TypeScript files:

  ```ts
  import { foo } from "./bar.js";  // correct
  import { foo } from "./bar";     // breaks at runtime
  ```

- **Never use em dashes** (U+2014) in code, comments, strings, or documentation. Use hyphens (`-`) or double hyphens (`--`) instead. This is enforced across the repo for consistency with the CLI's plain-text output.
- **React + Ink** for the TUI, **React + Vite + Tailwind** for the web dashboard.
- **YAML** for agent, flow, runtime, skill, and recipe definitions.
- **No ORM.** Repositories use raw SQL with column whitelists to prevent injection.

## Testing

Ark uses `bun:test`. **Always run tests via the `make` targets**, never `bun test` directly.

```bash
make test                                                    # all tests (sequential)
make test-file F=packages/core/__tests__/session.test.ts     # single file
```

### Tests MUST run sequentially

Tests share ports (19100 conductor, 19200+ channels, 19300 arkd), `globalThis` state, and SQLite databases. Bun runs test files concurrently by default, which causes cross-test contamination: port collisions, leaked state, phantom failures. The Makefile enforces `--concurrency 1`. If you see tests that pass individually but fail in the full suite, it is almost always a parallelism bug, not a code bug.

### Test Isolation Pattern

Use `AppContext.forTest()` for isolated contexts. It creates a temp directory, boots an isolated database, and skips the conductor and signal handlers.

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

Access repositories directly (`app.sessions`, `app.events`, `app.computes`) and call orchestration functions with `app` as the first argument (`dispatch(app, sessionId)`).

### E2E tests need `dist/`

CLI and TUI E2E tests (`e2e-cli.test.ts`, `e2e-tui-real.test.ts`) import from `dist/`. Build first (`make dev` or `tsc`) before running them. Unit tests run from source.

## Commit Messages

Use short, imperative commit messages with a conventional prefix:

- `feat:` -- new user-facing functionality
- `fix:` -- bug fix
- `chore:` -- config, dependencies, CI, tooling, and other non-functional changes
- `test:` -- test-only changes
- `docs:` -- documentation-only changes
- `refactor:` -- code restructuring with no behaviour change

Examples:

```
feat: add session archive command
fix: isolate session config tests from env file leakage
docs: document verify field on flow stages
```

Keep the subject line under 72 characters and in the imperative mood. A short body is fine when the change needs context.

## Pull Request Checklist

Before asking for review, make sure:

- [ ] The branch is up to date with `main` (`git pull --rebase origin main`)
- [ ] `make lint` passes
- [ ] `make test` passes locally
- [ ] Tests cover the change (new feature -> new test, bug fix -> regression test)
- [ ] Docs and `CLAUDE.md` are updated if the change affects architecture, public APIs, CLI commands, or gotchas
- [ ] The PR description explains the problem, the fix, and how you verified it
- [ ] No secrets, API keys, or large generated artifacts are committed

## Project Structure

See [CLAUDE.md](CLAUDE.md) for the full map. At a glance:

```
packages/cli         Commander.js CLI entry (the ark command)
packages/core        Sessions, flows, agents, channels, conductor, search
packages/compute     11 compute providers
packages/arkd        Universal agent daemon
packages/router      LLM Router (OpenAI-compatible proxy)
packages/tui         React + Ink terminal dashboard
packages/web         Vite-based web dashboard
packages/desktop     Electron shell around the web dashboard
packages/server      JSON-RPC handlers
packages/protocol    Typed JSON-RPC client
packages/types       Domain interfaces
agents/              Agent definitions (YAML)
runtimes/            Runtime definitions (YAML)
flows/               Flow definitions (YAML)
skills/              Builtin skills (Markdown)
recipes/             Recipe templates (YAML)
```

## Code of Conduct

Be kind, be constructive, and assume good intent. Harassment, personal attacks, and disrespectful behaviour are not welcome in issues, PRs, or any other Ark forum.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE) that covers the project.
