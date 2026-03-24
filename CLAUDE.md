# Ark

Autonomous agent ecosystem. Orchestrates Claude agents through multi-stage SDLC flows with local, Docker, and EC2 compute.

## Commands

```bash
make install          # bun install + symlink ark to /usr/local/bin
make test             # bun test (NOT vitest — tests use bun:test)
make dev              # tsc --watch
make tui              # ark tui
./ark <command>       # run CLI directly via bun
```

## Project Structure

```
packages/
  cli/       → Commander.js CLI entry (ark command)
  core/      → Sessions, store (SQLite), flows, agents, channels, conductor
  compute/   → Providers: local, docker, ec2
  tui/       → React + Ink terminal dashboard
agents/      → Agent YAML definitions (planner, implementer, reviewer, documenter, worker)
flows/       → Flow YAML definitions (default, quick, bare, parallel)
recipes/     → Flow recipe templates
```

No workspaces config — packages are coordinated manually via relative imports.

## Key Gotchas

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

## Testing

Tests use `bun:test`, not vitest. Run with `bun test` or `make test`.

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

## Code Style

- TypeScript with `strict: false`
- ES modules (`"type": "module"`) — always use `.js` import extensions
- React + Ink for TUI components
- YAML for agent/flow definitions
- SQLite for persistence (no ORM)
