# PLAN: Create CONTRIBUTING.md

## Summary

Create a root-level `CONTRIBUTING.md` file for the Ark repository. The repo currently has no contributor guide -- development information exists only in `docs/development.html` (the GitHub Pages site) and scattered across `CLAUDE.md` and `README.md`. A standard `CONTRIBUTING.md` at the repo root is what GitHub surfaces to new contributors and what developers look for first when wanting to submit changes.

## Files to modify/create

| # | File | Change |
|---|------|--------|
| 1 | `CONTRIBUTING.md` | **Create** -- full contributor guide covering dev setup, code style, testing, PR workflow, key gotchas |
| 2 | `README.md` | Add a "Contributing" link in the Documentation section (after line 132) pointing to `CONTRIBUTING.md` |

## Implementation steps

### Step 1: Create CONTRIBUTING.md at repo root

Create `CONTRIBUTING.md` with these sections, sourcing content from `CLAUDE.md`, `docs/development.html`, `Makefile`, and `README.md`:

#### Section: Getting Started
- Prerequisites: Bun (required, not Node), tmux, git, `gh` CLI (optional)
- Clone + `make install`
- Verify with `ark --version`

#### Section: Development Workflow
- `make dev` -- hot-reload (CLI watch + Vite dev server)
- `make dev-daemon` -- hot-reload server daemon
- `make dev-tui` / `make dev-web` -- individual component dev
- `make tui-standalone` -- TUI without daemon
- Running from source: `./ark <command>`

#### Section: Code Style
- TypeScript with `strict: false`
- ES modules -- **always use `.js` import extensions** (critical gotcha from `CLAUDE.md`)
- React + Ink for TUI, React + Vite + Tailwind for Web
- YAML for agent/flow/runtime/recipe definitions
- SQLite for local, PostgreSQL for hosted (IDatabase abstraction, no ORM)
- Never use em dashes (U+2014) -- use hyphens or double dashes
- No global state -- pass `app: AppContext` as first argument, never call `getApp()` from utility functions

#### Section: Testing
- Uses `bun:test` -- always run via `make test`, never `bun test` directly
- **Never run tests in parallel** -- port collisions on 19100, 19200, 19300
- `make test` -- all tests (sequential)
- `make test-file F=<path>` -- single file
- `make test-e2e` -- Playwright E2E (TUI + Web)
- Test isolation pattern: `AppContext.forTest()` with `beforeAll`/`afterAll`
- `waitFor()` utility for async state transitions
- E2E tests require `dist/` built first (`make dev` or `tsc`)

#### Section: Schema Changes
- No formal migration layer -- `schema.ts` is the source of truth
- Adding new tables/columns with DEFAULT: transparent (IF NOT EXISTS)
- Renaming/changing column type: `rm ~/.ark/ark.db` and restart

#### Section: Project Structure
- Brief pointer to `README.md` architecture section and `CLAUDE.md` for detailed module layers
- Key entry points: `AppContext` (app.ts), `SessionService` (services/session.ts), `session-orchestration.ts`

#### Section: Submitting Changes
- Fork the repo
- Create a feature branch
- Make changes, ensure `make test` passes
- `make lint` to check style
- Open a PR against `main`
- PR title: short, descriptive
- PR body: what changed and why, link to issue if applicable

#### Section: Self-Dogfooding
- Ark can dispatch agents against its own codebase
- `make self TASK="description"` -- full SDLC
- `make self-quick TASK="description"` -- quick single-agent fix

#### Section: Reporting Issues
- File at https://github.com/ytarasova/ark/issues
- Include: version (`ark --version`), OS, steps to reproduce, expected vs actual

### Step 2: Update README.md Documentation section

In the `## Documentation` section (around line 127-133), add a bullet:

```
- **[Contributing](CONTRIBUTING.md)** -- development setup, testing, and PR guidelines
```

Insert after the `**[CLAUDE.md](CLAUDE.md)**` line (line 132).

### Step 3: Verify

- Confirm `CONTRIBUTING.md` exists at repo root
- Confirm README.md links to it
- Read through both files to ensure consistency and no stale references

## Testing strategy

1. **File existence**: `test -f CONTRIBUTING.md` returns 0
2. **Content audit**: Grep for key terms that must appear: "bun:test", ".js extension", "make test", "AppContext.forTest", "strict: false", "em dash"
3. **README link check**: `grep -n "CONTRIBUTING.md" README.md` returns at least one match in the Documentation section
4. **No conflicts with existing docs**: Confirm the new file doesn't contradict `docs/development.html` or `CLAUDE.md` on any convention (import extensions, test commands, code style rules)
5. **GitHub rendering**: The file will be auto-surfaced by GitHub on the "Contributing" tab and in new-PR guidance -- verify markdown renders correctly with `cat CONTRIBUTING.md | head -5` showing a proper H1 header

## Risk assessment

- **Very low risk**: This is a new file creation with one minor edit to README.md. No code changes.
- **No breaking changes**: Documentation only.
- **Duplication concern**: Content overlaps with `docs/development.html` and `CLAUDE.md`. The CONTRIBUTING.md should be concise and cross-reference those files for deep dives rather than duplicating everything. `docs/development.html` covers the same ground in HTML for the docs site; CONTRIBUTING.md is the standard GitHub entry point in markdown.
- **Staleness risk**: As the project evolves, CONTRIBUTING.md will need updating alongside `CLAUDE.md` and `docs/development.html`. Keep it focused on essentials to reduce maintenance burden.

## Open questions

None -- the scope is clear: create a standard CONTRIBUTING.md with content already established in existing docs. No human decisions needed before implementation.
