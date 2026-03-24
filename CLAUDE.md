# Ark

Autonomous agent ecosystem. Orchestrates Claude agents through multi-stage SDLC flows with local, Docker, and EC2 compute.

## Commands

```bash
make install          # bun install + symlink ark to /usr/local/bin
make test             # bun test (NOT vitest — tests use bun:test)
make dev              # tsc --watch
make tui              # ark tui
./ark <command>       # run CLI directly via bun
ark search <query>    # search sessions, events, messages (--transcripts for JSONL, --index to rebuild FTS5)
ark index             # rebuild transcript FTS5 search index
ark claude list       # list Claude Code sessions on disk (--project to filter)
```

## Project Structure

```
packages/
  cli/       → Commander.js CLI entry (ark command)
  core/      → Sessions, store (SQLite), flows, agents, channels, conductor, search (FTS5), claude-sessions, app context, config
  compute/   → Providers: local, docker, ec2
  tui/       → React + Ink terminal dashboard
agents/      → Agent YAML definitions (planner, implementer, reviewer, documenter, worker)
flows/       → Flow YAML definitions (default, quick, bare, parallel)
recipes/     → Flow recipe templates
```

No workspaces config — packages are coordinated manually via relative imports.

**Core modules** (in dependency order):
`context.ts` → `store.ts` → `claude.ts` / `flow.ts` / `agent.ts` / `tmux.ts` / `exec.ts` → `session.ts` → `conductor.ts` → `search.ts` / `claude-sessions.ts` / `hooks.ts` / `app.ts` / `config.ts`

**Key entry point:** `session.ts` — all session lifecycle (startSession, dispatch, advance, stop, resume, complete, fork). This is the main orchestration API. `index.ts` re-exports everything.

## Key Gotchas

**FTS5 table needs manual creation on existing DBs.** The `transcript_index` FTS5 virtual table is in `initSchema()` but `CREATE VIRTUAL TABLE IF NOT EXISTS` only runs when the DB is first created. If you add new tables, existing `~/.ark/ark.db` files won't get them — run the SQL manually or delete the DB.

**ARK_DIR is static at module load.** `store.ts` sets `ARK_DIR = process.env.ARK_TEST_DIR ?? ~/.ark` once at import time. `createTestContext()` + `setContext()` isolates the DB but NOT filesystem paths like `join(ARK_DIR, "agents")`. For tests writing files to ARK_DIR, clean up in `beforeEach`.

**Bun-only.** Uses `bun:sqlite`, `Bun.serve()`, `Bun.sleep()`, Bun FFI. Will not run under Node.

**Tmux required.** Sessions launch agents in tmux sessions (`ark-s-<id>`). No fallback if tmux is missing.

**ES module imports need `.js` extensions.** All relative imports must use `.js` even in TypeScript files:
```ts
import { foo } from "./bar.js";  // correct
import { foo } from "./bar";     // breaks at runtime
```

**`strict: false` in tsconfig.** Implicit `any` is allowed; no strict null checks.

**Store field mapping.** The SQLite columns differ from TypeScript field names:
| TS field | SQLite column |
|----------|---------------|
| `ticket` | `jira_key` |
| `summary` | `jira_summary` |
| `flow` | `pipeline` |

If you add a Session field, update the `fieldMap` in `packages/core/store.ts` → `updateSession()`.

**Conductor port 19100 is hardcoded** in conductor.ts, channel.ts, and tests. Channel ports are derived deterministically: `19200 + (parseInt(sessionId.replace("s-",""), 16) % 1000)`.

**No ESLint config file.** The `lint` script exists but no `.eslintrc` or `eslint.config.*` — runs with ESLint defaults.

**`package.json` test script is wrong.** It says `"test": "vitest run"` but the project uses `bun:test`. Always run tests with `bun test` or `make test`, never `npm test`.

## Testing

Tests use `bun:test`, not vitest. Run with `bun test` or `make test`.

**E2E tests need `dist/` built.** CLI E2E tests (`e2e-cli.test.ts`) and TUI real tests (`e2e-tui-real.test.ts`) import from `dist/` — run `make dev` or `tsc` first. Unit tests run from source.

**Pre-existing flaky tests.** `session-stop-resume.test.ts:182` ("resume returns ok: false for completed session") and `useStore.test.tsx` ("refresh() picks up new data immediately") are known flakes. Don't chase them.

```bash
bun test                        # all tests
bun test packages/core          # core only
bun test --watch                # watch mode
```

**Test isolation pattern** — every test must manually create and clean up context:
```ts
import { createTestContext, setContext } from "../context.js";

let ctx: TestContext;
beforeEach(() => { ctx = createTestContext(); setContext(ctx); });
afterEach(() => { ctx.cleanup(); });
```

Forgetting `setContext()` pollutes global state. Forgetting `cleanup()` leaks temp dirs under `/tmp/ark-test-*`.

Test conductor ports use offsets (19199, 19200, 19300) to avoid collisions.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ARK_CONDUCTOR_PORT` | `19100` | Conductor HTTP server port |
| `ARK_CONDUCTOR_URL` | `http://localhost:19100` | Conductor URL for channels |
| `ARK_CHANNEL_PORT` | auto-assigned | Per-session MCP channel port |
| `ARK_SESSION_ID` | — | Set in channel context |
| `ARK_STAGE` | — | Current flow stage in channel |
| `ARK_TEST_DIR` | — | Temp dir for test isolation |

## Data Locations

| Path | Purpose |
|------|---------|
| `~/.ark/ark.db` | SQLite database (WAL mode, 10s busy timeout) |
| `~/.ark/tracks/<sessionId>/` | Launcher scripts, channel configs |
| `~/.ark/worktrees/<sessionId>/` | Git worktrees for isolated sessions |
| `~/.claude/projects/` | Claude Code session transcripts (JSONL) — read by search and import |
| `.claude/settings.local.json` | Per-session hook config (written at dispatch, cleaned on stop) |

## Adding an Agent

Create `agents/<name>.yaml`:
```yaml
name: my-agent
description: What it does
model: opus        # opus | sonnet | haiku
max_turns: 200
system_prompt: |
  Working on {repo}. Task: {summary}. Ticket: {ticket}.
tools: [Bash, Read, Write, Edit, Glob, Grep, WebSearch]
permission_mode: bypassPermissions
env:
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80"  # optional — env vars exported before claude launch
```

Template variables: `{ticket}`, `{summary}`, `{workdir}`, `{repo}`, `{branch}` — substituted at dispatch.

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
```

## TUI Keyboard Shortcuts

**Sessions tab (1):**
| Key | Action | Key | Action |
|-----|--------|-----|--------|
| `j/k` | Navigate sessions | `n` | New session |
| `Enter` | Dispatch/restart | `s` | Stop session |
| `a` | Attach to tmux | `t` | Talk (send message) |
| `x` | Delete session | `d` | Mark done (press twice) |
| `c` | Clone session | `m` | Move to group |
| `i` | Inbox/threads | `g` | Group manager |
| `Tab` | Focus detail pane | `e` | Expand events |

**History tab (5):** `Enter`:import `/:index` `r`:refresh `s`:search

**Compute tab (6):** `Enter`:provision `s`:start/stop `c`:clean `n`:new `x`:delete

**Global:** `1-6`:switch tabs `Tab`:toggle pane `e`:events `q`:quit

## TUI Design System

**Status bar = single source of truth for shortcuts.** Hints update based on active tab + pane + overlay. No shortcut text inside panels, overlays, or forms.

**Spinners:**
- Status bar: icon only (no label) — signals "system is busy"
- Panel: detailed progress text ("Indexing... 50 files") — shows what's happening

**Overlay hints:** When a form/overlay is active, status bar shows form controls (`Enter:confirm Esc:cancel`) instead of tab hints. Overlay state flows up via `onOverlayChange` callbacks from tabs to App.tsx to StatusBar.

## App Boot System

`app.ts` provides `AppContext` — initializes conductor, metrics polling, and config. CLI creates it with `skipConductor: true` (only TUI runs the conductor). `config.ts` loads `~/.ark/config.yaml` for user preferences.

```ts
const app = new AppContext(loadConfig());
await app.boot();   // starts conductor + metrics
await app.shutdown(); // cleanup on exit
```

## TUI Async Rules (CRITICAL)

**Every I/O operation in the TUI MUST be non-blocking.** No exceptions.

The TUI uses `useAsync` hook which provides `asyncState.run(label, fn)` — it queues work, shows a spinner with the label, and keeps the UI responsive.

```ts
// useInput handlers: ALWAYS wrap I/O in asyncState.run()
asyncState.run("Label...", async () => { await core.doThing(); status.show("Done"); refresh(); });

// Render bodies: ALWAYS use useMemo or useEffect for I/O
const data = useMemo(() => core.loadData(id), [id]);
```

**Rules:**
- `useInput` handlers: wrap ALL `core.*` calls in `asyncState.run(label, fn)`
- Render bodies: wrap ALL `core.*` calls in `useMemo` or `useEffect`
- Never use `execFileSync` in handlers — use async variants (`sessionExistsAsync`, `capturePaneAsync`)
- After mutations inside `asyncState.run()`, call `refresh()` to update the TUI
- Use `status.show(msg)` for user feedback inside async operations
- Long operations (file scanning, indexing): use `async` fn with periodic `await new Promise(r => setTimeout(r, 0))` to yield to the event loop

**Existing async infrastructure:**
- `useAsync` hook: `packages/tui/hooks/useAsync.ts` — queued action runner with spinner
- `useSessionActions`: `packages/tui/hooks/useSessionActions.ts` — all session mutations (dispatch, stop, restart, delete, clone, complete)
- `useComputeActions`: `packages/tui/hooks/useComputeActions.ts` — all compute mutations (provision, stop, start, delete, clean)
- `useStatusMessage`: `packages/tui/hooks/useStatusMessage.ts` — temporary status messages with auto-clear

## Hook-Based Agent Status

Ark uses Claude Code hooks for agent status detection. At dispatch time, `claude.writeHooksConfig()` writes `.claude/settings.local.json` to the session working directory with HTTP hooks that POST status events to the conductor.

**Hooks are ONLY for status detection** (busy/idle/error/done). They are NOT part of the channel/conductor communication system. Channels handle agent↔human messaging via MCP.

Key files: `claude.ts` (writeHooksConfig, removeHooksConfig), `conductor.ts` (/hooks/status endpoint), `session.ts` (wiring).

## Code Style

- TypeScript with `strict: false`
- ES modules (`"type": "module"`) — always use `.js` import extensions
- React + Ink for TUI components
- YAML for agent/flow definitions
- SQLite for persistence (no ORM)

## Architecture Boundaries

- **`context.ts`** — Dependency injection for DB paths. `createTestContext()` for test isolation. Everything reads paths from here.
- **`store.ts`** — Pure data CRUD. No imports from claude.ts or session.ts (avoids circular deps). If you need cleanup logic that touches both store and claude, put it in session.ts.
- **`claude.ts`** — ALL Claude Code knowledge (model mapping, args, hooks config, launcher, trust, transcript parsing). Session.ts and agent.ts call into it, never the reverse.
- **`session.ts`** — Orchestration. All session lifecycle mutations. Calls into store, claude, tmux, flow, agent. The "controller" layer.
- **`conductor.ts`** — HTTP server. Channel reports (agent↔human MCP messaging) + hook status (agent status detection). These are SEPARATE concerns — hooks never trigger `session.advance()`.
- **`search.ts`** — Search + FTS5 indexing. `indexTranscripts()` is async (yields every 5 files). `searchTranscripts()` uses FTS5 when index exists, falls back to file scanning.
- **`claude-sessions.ts`** — Read-only discovery of Claude Code sessions from `~/.claude/projects/`. No writes.
- **`hooks.ts`** — Internal event bus (pub/sub). NOT Claude Code hooks — those are in claude.ts.
- **`app.ts`** — Boot/shutdown lifecycle. Owns conductor and metrics polling. CLI skips conductor; TUI runs it.
