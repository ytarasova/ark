# AppContext Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace scattered module-level singletons with a unified AppContext that manages configuration, database, conductor, and metrics lifecycle.

**Architecture:** A class-based `AppContext` owns all services and boots them in explicit order. CLI and TUI share it — TUI opts into conductor and metrics. Migration-safe shims keep existing code working during gradual adoption.

**Tech Stack:** Bun, TypeScript, bun:sqlite, React/Ink (TUI only)

**Spec:** `docs/superpowers/specs/2026-03-24-app-context-design.md`

---

### Task 1: Create `config.ts` — typed configuration

**Files:**
- Create: `packages/core/config.ts`
- Create: `packages/core/__tests__/config.test.ts`

- [ ] **Step 1: Write failing tests for loadConfig**

```ts
// packages/core/__tests__/config.test.ts
import { describe, it, expect, afterEach } from "bun:test";
import { loadConfig } from "../config.js";

describe("loadConfig", () => {
  const origEnv = { ...process.env };
  afterEach(() => {
    for (const key of ["ARK_TEST_DIR", "ARK_CONDUCTOR_PORT", "ARK_CONDUCTOR_URL", "NODE_ENV"]) {
      if (origEnv[key] !== undefined) process.env[key] = origEnv[key];
      else delete process.env[key];
    }
  });

  it("uses ~/.ark defaults when no env vars set", () => {
    delete process.env.ARK_TEST_DIR;
    delete process.env.ARK_CONDUCTOR_PORT;
    const cfg = loadConfig();
    expect(cfg.arkDir).toContain(".ark");
    expect(cfg.dbPath).toContain("ark.db");
    expect(cfg.conductorPort).toBe(19100);
    expect(cfg.env).toBe("production");
  });

  it("respects ARK_TEST_DIR", () => {
    process.env.ARK_TEST_DIR = "/tmp/ark-test-xyz";
    const cfg = loadConfig();
    expect(cfg.arkDir).toBe("/tmp/ark-test-xyz");
    expect(cfg.dbPath).toBe("/tmp/ark-test-xyz/ark.db");
    expect(cfg.tracksDir).toBe("/tmp/ark-test-xyz/tracks");
  });

  it("respects ARK_CONDUCTOR_PORT", () => {
    process.env.ARK_CONDUCTOR_PORT = "19555";
    const cfg = loadConfig();
    expect(cfg.conductorPort).toBe(19555);
    expect(cfg.conductorUrl).toContain("19555");
  });

  it("applies overrides over env vars", () => {
    process.env.ARK_TEST_DIR = "/tmp/should-be-overridden";
    const cfg = loadConfig({ arkDir: "/custom/path" });
    expect(cfg.arkDir).toBe("/custom/path");
  });

  it("sets env to test when NODE_ENV is test", () => {
    process.env.NODE_ENV = "test";
    const cfg = loadConfig();
    expect(cfg.env).toBe("test");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/__tests__/config.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement config.ts**

```ts
// packages/core/config.ts
import { join } from "path";
import { homedir } from "os";

export interface ArkConfig {
  arkDir: string;
  dbPath: string;
  tracksDir: string;
  worktreesDir: string;
  logDir: string;
  conductorPort: number;
  conductorUrl: string;
  env: "production" | "test";
}

export function loadConfig(overrides?: Partial<ArkConfig>): ArkConfig {
  const arkDir = overrides?.arkDir ?? process.env.ARK_TEST_DIR ?? join(homedir(), ".ark");
  const conductorPort = overrides?.conductorPort
    ?? parseInt(process.env.ARK_CONDUCTOR_PORT ?? "19100", 10);

  const base: ArkConfig = {
    arkDir,
    dbPath: join(arkDir, "ark.db"),
    tracksDir: join(arkDir, "tracks"),
    worktreesDir: join(arkDir, "worktrees"),
    logDir: join(arkDir, "logs"),
    conductorPort,
    conductorUrl: process.env.ARK_CONDUCTOR_URL ?? `http://localhost:${conductorPort}`,
    env: process.env.NODE_ENV === "test" ? "test" : "production",
  };

  // Apply remaining overrides (except arkDir which was already used above)
  if (overrides) {
    const { arkDir: _a, ...rest } = overrides;
    Object.assign(base, rest);
  }

  return base;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/__tests__/config.test.ts`
Expected: 5 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/config.ts packages/core/__tests__/config.test.ts
git commit -m "feat: add ArkConfig type and loadConfig()"
```

---

### Task 2: Create `app.ts` — AppContext class with boot/shutdown

**Files:**
- Create: `packages/core/app.ts`
- Create: `packages/core/__tests__/app.test.ts`

- [ ] **Step 1: Write failing tests for AppContext lifecycle**

```ts
// packages/core/__tests__/app.test.ts
import { describe, it, expect, afterEach } from "bun:test";
import { AppContext } from "../app.js";
import { existsSync } from "fs";

let app: AppContext | null = null;
afterEach(async () => {
  if (app) await app.shutdown();
  app = null;
});

describe("AppContext", () => {
  it("starts in created phase", () => {
    app = AppContext.forTest();
    expect(app.phase).toBe("created");
  });

  it("boots to ready phase", async () => {
    app = AppContext.forTest();
    await app.boot();
    expect(app.phase).toBe("ready");
  });

  it("creates directories on boot", async () => {
    app = AppContext.forTest();
    await app.boot();
    expect(existsSync(app.config.arkDir)).toBe(true);
    expect(existsSync(app.config.tracksDir)).toBe(true);
    expect(existsSync(app.config.worktreesDir)).toBe(true);
    expect(existsSync(app.config.logDir)).toBe(true);
  });

  it("initializes database with schema on boot", async () => {
    app = AppContext.forTest();
    await app.boot();
    const row = app.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'"
    ).get() as any;
    expect(row?.name).toBe("sessions");
  });

  it("seeds local compute row on boot", async () => {
    app = AppContext.forTest();
    await app.boot();
    const row = app.db.prepare("SELECT name FROM compute WHERE name='local'").get() as any;
    expect(row?.name).toBe("local");
  });

  it("shuts down to stopped phase", async () => {
    app = AppContext.forTest();
    await app.boot();
    await app.shutdown();
    expect(app.phase).toBe("stopped");
  });

  it("shutdown is idempotent", async () => {
    app = AppContext.forTest();
    await app.boot();
    await app.shutdown();
    await app.shutdown();
    expect(app.phase).toBe("stopped");
  });

  it("boot throws if called twice", async () => {
    app = AppContext.forTest();
    await app.boot();
    expect(app.boot()).rejects.toThrow();
  });

  it("forTest cleans up temp dir on shutdown", async () => {
    app = AppContext.forTest();
    await app.boot();
    const dir = app.config.arkDir;
    expect(existsSync(dir)).toBe(true);
    await app.shutdown();
    expect(existsSync(dir)).toBe(false);
  });

  it("creates event bus on boot", async () => {
    app = AppContext.forTest();
    await app.boot();
    expect(app.eventBus).toBeTruthy();
    expect(typeof app.eventBus.emit).toBe("function");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/__tests__/app.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement app.ts**

Create `packages/core/app.ts` with:
- `AppContext` class with `phase`, `config`, `db`, `eventBus`, `conductor`, `metricsPoller`
- `constructor(opts?)` — zero side effects, just stores config
- `boot()` — ensures dirs, opens DB, inits schema, seeds local compute, creates EventBus, optionally starts conductor and metrics poller, registers SIGINT/SIGTERM
- `shutdown()` — idempotent reverse teardown: stop poller, stop conductor, close DB, remove temp dir if test
- `static forTest(overrides?)` — creates temp dir, returns AppContext with test config
- `getApp()` / `setApp()` / `clearApp()` — global singleton accessors
- `initSchema(db)` — extracted from store.ts, creates all 5 tables
- `ensureLocalCompute(db)` — ensures local compute row exists
- `createMetricsPoller()` — extracted from conductor.ts, returns `{ stop() }` handle

Key implementation details:
- Signal handlers track themselves for cleanup in shutdown
- Double-signal (SIGINT twice) force-exits via `process.exit(1)`
- Conductor loaded via dynamic `import()` to avoid circular deps
- Metrics poller uses dynamic `import()` for store and compute

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/__tests__/app.test.ts`
Expected: 9 PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/app.ts packages/core/__tests__/app.test.ts
git commit -m "feat: add AppContext with boot/shutdown lifecycle"
```

---

### Task 3: Wire shims — store.ts delegates to AppContext

**Files:**
- Modify: `packages/core/store.ts` (lines 17-37 — imports and path functions; lines 91-106 — getDb)
- Modify: `packages/core/index.ts` (add app.ts/config.ts exports)

- [ ] **Step 1: Add appOrFallback helper and update path functions in store.ts**

Replace the path function block in `packages/core/store.ts` with an `appOrFallback()` helper that tries `getApp()` first and falls back to `getContext()` for legacy compatibility. Update `ARK_DIR()`, `DB_PATH()`, `TRACKS_DIR()`, `WORKTREES_DIR()` to use it.

- [ ] **Step 2: Update getDb shim in store.ts**

Update `getDb()` to return `app.db` when AppContext is active, falling back to the legacy `getDbFromContext()` + `_initialized` WeakSet path otherwise.

- [ ] **Step 3: Add exports to index.ts**

Add to `packages/core/index.ts`:
```ts
// App context
export { AppContext, getApp, setApp, clearApp } from "./app.js";
export { loadConfig, type ArkConfig } from "./config.js";
```

- [ ] **Step 4: Run existing tests to verify shims work**

Run: `bun test packages/core/__tests__/context.test.ts packages/core/__tests__/store-messages.test.ts packages/core/__tests__/store-groups.test.ts`
Expected: All PASS (legacy fallback)

- [ ] **Step 5: Run new AppContext tests**

Run: `bun test packages/core/__tests__/app.test.ts packages/core/__tests__/config.test.ts`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/store.ts packages/core/index.ts
git commit -m "feat: wire AppContext shims in store.ts and export from index.ts"
```

---

### Task 4: Wire CLI entry point

**Files:**
- Modify: `packages/cli/index.ts` (top: add boot; bottom: parseAsync + shutdown)

- [ ] **Step 1: Add AppContext boot after imports**

Add after the existing imports in `packages/cli/index.ts`:
```ts
import { AppContext, setApp } from "../core/app.js";
const app = new AppContext();
await app.boot();
setApp(app);
```

- [ ] **Step 2: Replace `program.parse()` with async parse + shutdown**

Replace the last line `program.parse(process.argv);` with:
```ts
await program.parseAsync(process.argv);
await app.shutdown();
```

- [ ] **Step 3: Verify CLI works**

Run: `./ark session list`
Expected: Works, no errors

- [ ] **Step 4: Commit**

```bash
git add packages/cli/index.ts
git commit -m "feat: boot AppContext in CLI entry point"
```

---

### Task 5: Wire TUI entry point

**Files:**
- Create: `packages/tui/context/AppProvider.tsx`
- Modify: `packages/tui/index.tsx`

- [ ] **Step 1: Create AppProvider React context**

Create `packages/tui/context/AppProvider.tsx` with:
- `AppCtx` React context holding `AppContext`
- `AppProvider` component wrapping children in `AppCtx.Provider`
- `useAppContext()` hook that reads from context

- [ ] **Step 2: Rewrite tui/index.tsx to use AppContext**

Replace the current boot sequence (manual log dir, manual conductor start) with:
1. Create `AppContext({ conductor: true, metricsPolling: true })`
2. `await app.boot()` + `setApp(app)`
3. Log dir comes from `app.config.logDir`
4. Remove manual `startConductor()` call (AppContext handles it)
5. Wrap `<App />` in `<AppProvider app={app}>`
6. Call `app.shutdown()` on exit and crash paths

- [ ] **Step 3: Verify TUI starts and quits**

Run: `./ark tui`, switch tabs, press `q`
Expected: Boots, renders, quits cleanly

- [ ] **Step 4: Run TUI e2e tests**

Run: `bun test packages/tui/__tests__/e2e-tui-real.test.ts`
Expected: 7 pass, 3 skip, 0 fail

- [ ] **Step 5: Commit**

```bash
git add packages/tui/index.tsx packages/tui/context/AppProvider.tsx
git commit -m "feat: boot AppContext in TUI entry point with AppProvider"
```

---

### Task 6: Extract metrics poller from conductor.ts

**Files:**
- Modify: `packages/core/conductor.ts` (remove setInterval block, lines 108-138)

- [ ] **Step 1: Remove metrics polling from conductor.ts**

Delete the `// Background metrics polling` section (the `setInterval` block at the end of `startConductor()`). The function should end with `return server;` after the log line.

The metrics poller now lives in `app.ts`'s `createMetricsPoller()`.

- [ ] **Step 2: Run conductor tests**

Run: `bun test packages/core/__tests__/conductor-e2e.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/core/conductor.ts
git commit -m "refactor: extract metrics polling from conductor into AppContext"
```

---

### Task 7: Update TuiDriver for AppContext-based isolation

**Files:**
- Modify: `packages/tui/__tests__/tui-driver.ts`

- [ ] **Step 1: Add AppContext to TuiDriver**

Update `packages/tui/__tests__/tui-driver.ts`:
- Import `AppContext`, `setApp`, `clearApp` from `../../core/app.js`
- Add `private _app: AppContext | null = null` field
- In `start()`: create `AppContext.forTest()`, boot it, `setApp()`, pass `_app.config.arkDir` as `ARK_TEST_DIR` and `_app.config.conductorPort` (random) as `ARK_CONDUCTOR_PORT` to the tmux command
- In `stop()`: after killing tmux and cleaning sessions, call `_app.shutdown()` and `clearApp()`
- In `createSession()`: sessions are created via the booted app's DB (already works through shims)

- [ ] **Step 2: Run e2e tests**

Run: `bun test packages/tui/__tests__/e2e-tui-real.test.ts`
Expected: 7 pass, 3 skip, 0 fail

- [ ] **Step 3: Commit**

```bash
git add packages/tui/__tests__/tui-driver.ts
git commit -m "refactor: TuiDriver uses AppContext.forTest() for isolation"
```

---

### Task 8: Update test-setup.ts and run full verification

**Files:**
- Modify: `packages/test-setup.ts`

- [ ] **Step 1: Add migration comment to test-setup.ts**

Update comment to document that `ARK_TEST_DIR` is for legacy paths only. Tests using `AppContext.forTest()` create their own temp dir.

- [ ] **Step 2: Run full core test suite**

Run: `bun test packages/core`
Expected: Same pass/fail as before (no regressions from pre-existing flaky dispatch tests)

- [ ] **Step 3: Run full TUI component tests**

Run: `bun test packages/tui/__tests__/components.test.tsx packages/tui/__tests__/useSessionActions.test.ts`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add packages/test-setup.ts
git commit -m "docs: annotate test-setup.ts for AppContext migration"
```

---

### Task 9: Final verification and push

- [ ] **Step 1: Run all tests**

Run: `bun test packages/core packages/tui/__tests__/e2e-tui-real.test.ts`
Expected: No new failures

- [ ] **Step 2: Verify CLI**

Run: `./ark session list`
Expected: Works

- [ ] **Step 3: Verify TUI**

Run: `./ark tui`, switch tabs, press `q`
Expected: Boots, renders, quits cleanly

- [ ] **Step 4: Push**

```bash
git push
```
