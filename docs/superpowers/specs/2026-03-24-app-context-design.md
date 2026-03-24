# AppContext: Application Container & Lifecycle Management

**Date:** 2026-03-24
**Status:** Approved

## Problem

Ark's application state is scattered across module-level singletons, frozen constants, and implicit initialization. The database initializes silently on first query. The conductor starts in the TUI's main scope and swallows port conflicts. Environment variables are read in 6+ files with no centralization. There's no startup validation, no shutdown hooks, and no dependency ordering. The event bus exists but nobody subscribes to it. Tests fight with production state because isolation depends on env vars being set before module load.

## Solution

A unified `AppContext` class that owns all services, boots them in explicit order, and shuts them down on signal or request. Inspired by Spring's application context — but hand-rolled for 6 services, not a framework.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Container style | Class-based AppContext | Simple, discoverable, TypeScript autocomplete. 6 services don't need a DI framework. |
| Entry points | Unified — CLI and TUI share AppContext | CLI skips conductor/metrics via options. Avoids duplication. |
| TUI state | Keep polling, managed as a service | Fix lifecycle first. Plan for event-driven as follow-up. |
| Configuration | Plain typed object from env vars + defaults | YAGNI on hierarchical config. Plan for config file later. |
| Shutdown | Signal-based (SIGINT/SIGTERM) + explicit `shutdown()` | Automatic cleanup. Both paths use same ordered teardown. |
| Module access | Global singleton via `getApp()`/`setApp()` | Gradual migration — shims keep existing imports working. |

## Architecture

### Config (`packages/core/config.ts`)

```ts
interface ArkConfig {
  arkDir: string;          // ~/.ark or override
  dbPath: string;          // arkDir/ark.db
  tracksDir: string;       // arkDir/tracks
  worktreesDir: string;    // arkDir/worktrees
  logDir: string;          // arkDir/logs
  conductorPort: number;   // default 19100
  conductorUrl: string;    // http://localhost:{port}
  env: "production" | "test";
}

function loadConfig(overrides?: Partial<ArkConfig>): ArkConfig
```

Single source of truth. Built once at startup from env vars + defaults + overrides. Replaces all scattered `process.env` reads.

### AppContext (`packages/core/app.ts`)

```ts
type AppPhase = "created" | "booting" | "ready" | "shutting_down" | "stopped";

interface AppContextOptions {
  config?: Partial<ArkConfig>;
  conductor?: boolean;       // default false
  metricsPolling?: boolean;  // default false
}

class AppContext {
  readonly config: ArkConfig;
  readonly eventBus: EventBus;
  db: Database;
  conductor: StoppableServer | null;
  metricsPoller: StoppablePoller | null;
  phase: AppPhase;

  constructor(opts?: AppContextOptions);
  async boot(): Promise<void>;
  async shutdown(): Promise<void>;
  static forTest(overrides?: Partial<ArkConfig>): AppContext;
}

function getApp(): AppContext;   // throws if not booted
function setApp(app: AppContext): void;
```

**Constructor:** Zero side effects. Only stores config and options.

**Boot order:**
1. Ensure directories exist (`arkDir`, `tracksDir`, `worktreesDir`, `logDir`)
2. Open database + run schema migrations + seed local compute row
3. Create event bus
4. Start conductor (if opted in) — extracted from current `startConductor()`, metrics polling extracted into separate stoppable service
5. Start metrics poller (if opted in) — extracted from conductor.ts into its own interval with a stored handle
6. Register SIGINT/SIGTERM handlers (double-signal force-exits if shutdown is already in progress)
7. Set phase to `ready`, emit `app_ready`

**Shutdown order (reverse):**
1. Stop metrics poller (clear interval handle)
2. Stop conductor (`Bun.serve().stop()`)
3. Emit `app_shutdown`
4. Close database
5. Remove temp dir if `env === "test"`
6. Set phase to `stopped`

Shutdown is idempotent — safe to call multiple times. `boot()` throws if called when phase is not `created`.

### Entry Points

**CLI (`packages/cli/index.ts`):**
```ts
const app = new AppContext();
await app.boot();
setApp(app);
// ... run command via Commander (use parseAsync() for proper await) ...
await program.parseAsync();
await app.shutdown();
```

**TUI (`packages/tui/index.tsx`):**
```ts
const app = new AppContext({ conductor: true, metricsPolling: true });
await app.boot();
setApp(app);
render(<AppProvider app={app}><App /></AppProvider>);
// quit handler calls app.shutdown()
```

**Tests:**
```ts
let app: AppContext;
beforeEach(async () => { app = AppContext.forTest(); await app.boot(); });
afterEach(async () => { await app.shutdown(); });
```

### TUI Integration

AppContext passed via React context:

```tsx
const AppCtx = createContext<AppContext>(null!);
export const useAppContext = () => useContext(AppCtx);
```

Components access `app.config`, `app.db`, `app.eventBus` via the hook. The `useStore()` hook reads from `app.db` instead of importing `core.*` directly. Quit handler calls `app.shutdown().then(() => exit())`.

### Backward Compatibility (Migration Shims)

Existing code keeps working during migration. The current path functions and `getDb()` become thin delegates:

```ts
// store.ts shims — migration-safe, fall back to legacy context if AppContext not yet set
import { getApp } from "./app.js";
import { getContext } from "./context.js";

function appOrFallback(): { config: ArkConfig; db: Database } {
  try { return getApp(); } catch { return legacyFallback(); }
}

export function ARK_DIR(): string { return appOrFallback().config.arkDir; }
export function DB_PATH(): string { return appOrFallback().config.dbPath; }
export function TRACKS_DIR(): string { return appOrFallback().config.tracksDir; }
export function WORKTREES_DIR(): string { return appOrFallback().config.worktreesDir; }
export function getDb(): Database { return appOrFallback().db; }
```

The `appOrFallback()` pattern prevents breakage during migration — code that runs before `setApp()` still works via the legacy `getContext()` path, but logs a deprecation warning. Once all entry points boot via AppContext, the fallback is removed.

Modules migrate gradually from `import { TRACKS_DIR } from "./store.js"` to `import { getApp } from "./app.js"`. Shims are removed once all consumers are migrated.

### What Gets Deleted

After full migration:
- `context.ts` — replaced by `config.ts` + `app.ts`
- `createTestContext()` / `TestContext` / `setContext()` / `resetContext()`
- `_initialized` WeakSet in store.ts
- Scattered `process.env` reads for paths and ports
- Manual `ctx.cleanup()` in tests

**Out of scope:** `channel.ts` reads `ARK_SESSION_ID`, `ARK_CONDUCTOR_URL`, `ARK_CHANNEL_PORT` from env vars. These are set per-agent-subprocess (not per-app-instance) and belong outside AppContext. The channel runs as a standalone MCP server process.

## File Layout

**New files:**
```
packages/core/config.ts    # ArkConfig type + loadConfig()
packages/core/app.ts       # AppContext class + getApp()/setApp()
```

**Modified files:**

| File | Change |
|------|--------|
| `store.ts` | Path functions become shims. `initSchema()` called by AppContext.boot(). |
| `conductor.ts` | Returns stoppable handle. Receives config instead of reading env vars. Metrics polling extracted into separate service. `eventBus` accessed via `getApp().eventBus` instead of module-level import. |
| `session.ts` | Reads paths from `getApp().config`. |
| `agent.ts` | `USER_DIR()` reads from `getApp().config.arkDir`. |
| `flow.ts` | Same as agent.ts. |
| `claude.ts` | Reads `tracksDir` from `getApp().config`. |
| `tmux.ts` | Reads `tracksDir` from `getApp().config`. |
| `hooks.ts` | EventBus singleton replaced — AppContext owns instance. |
| `tui/index.tsx` | Boot becomes: AppContext → boot → setApp → render. |
| `cli/index.ts` | Same pattern without conductor/metrics. |
| `test-setup.ts` | Simplified — AppContext.forTest() handles isolation. |

## Future Work

- **Event-driven TUI:** Replace polling with eventBus subscriptions. Store mutations emit events, TUI re-renders on change.
- **Hierarchical config:** Support `~/.ark/config.yaml` and per-project `.ark.yaml`, env vars override file.
- **Registry-based container:** If services grow past ~10, add auto-dependency resolution via topological sort.
- **Provider DI:** Compute providers currently import from store.ts directly. Long-term, pass dependencies (DB, config) through function arguments instead of singleton imports.

## Testing Strategy

- Unit tests for `loadConfig()` — env var parsing, defaults, overrides.
- Unit tests for `AppContext` lifecycle — boot order, shutdown order, idempotent shutdown, phase transitions, double-boot guard.
- Boot failure tests — locked DB file, conductor port already in use. Verify partial boot cleans up (if step 4 fails, steps 1-3 are torn down).
- Integration test: `AppContext.forTest()` creates isolated DB, queries work, shutdown cleans up temp dir.
- E2e: TuiDriver uses `AppContext.forTest()` for in-process state + passes config to tmux subprocess.
- Migration: existing tests keep passing through shims during gradual migration.

**`forTest()` specifics:** Creates temp dir, sets `env: "test"`, disables conductor and metrics polling. `shutdown()` closes DB and removes temp dir.
