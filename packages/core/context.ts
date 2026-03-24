/**
 * Dependency injection for store paths and database.
 *
 * Production code uses the default context (~/.ark).
 * Tests call createTestContext() to get an isolated context with
 * a temp directory, then setContext() to activate it.
 *
 * Usage in tests:
 *   const ctx = createTestContext();
 *   beforeEach(() => setContext(ctx));
 *   afterAll(() => ctx.cleanup());
 */

import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { homedir } from "os";

export interface StoreContext {
  arkDir: string;
  dbPath: string;
  tracksDir: string;
  worktreesDir: string;
  db: Database | null;
}

// ── Default context ──────────────────────────────────────────────────────────

/** Resolve the base directory. Re-reads ARK_TEST_DIR each time so the env var
 *  can be set after module load (e.g., by test-setup.ts preload). */
function resolveBase(): string {
  return process.env.ARK_TEST_DIR ?? join(homedir(), ".ark");
}

function makeDefaultCtx(): StoreContext {
  const base = resolveBase();
  return {
    arkDir: base,
    dbPath: join(base, "ark.db"),
    tracksDir: join(base, "tracks"),
    worktreesDir: join(base, "worktrees"),
    db: null,
  };
}

let _current: StoreContext | null = null;

/** Get the active store context. Lazy-initializes from ARK_TEST_DIR / ~/.ark. */
export function getContext(): StoreContext {
  if (!_current) _current = makeDefaultCtx();
  return _current;
}

/** Set the active store context (for tests or multi-tenant). */
export function setContext(ctx: StoreContext): void {
  _current = ctx;
}

/** Reset to the default context (re-reads ARK_TEST_DIR). */
export function resetContext(): void {
  _current = null;
}

// ── Database access ──────────────────────────────────────────────────────────

function ensureDirs(ctx: StoreContext): void {
  for (const dir of [ctx.arkDir, ctx.tracksDir, ctx.worktreesDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

/** Get (or create) the database for the current context. */
export function getDb(): Database {
  const ctx = getContext();
  if (ctx.db) return ctx.db;
  ensureDirs(ctx);
  ctx.db = new Database(ctx.dbPath);
  ctx.db.run("PRAGMA journal_mode = WAL");
  ctx.db.run("PRAGMA foreign_keys = ON");
  ctx.db.run("PRAGMA busy_timeout = 10000");
  return ctx.db;
}

/** Close and release the database for the current context. */
export function closeDb(): void {
  const ctx = getContext();
  if (ctx.db) {
    try { ctx.db.close(); } catch {}
    ctx.db = null;
  }
}

// ── Test helpers ─────────────────────────────────────────────────────────────

export interface TestContext extends StoreContext {
  /** Remove temp directory and close db. */
  cleanup: () => void;
}

/**
 * Create an isolated test context with a temp directory.
 * Call setContext(ctx) to activate, ctx.cleanup() when done.
 */
export function createTestContext(): TestContext {
  const dir = mkdtempSync(join(tmpdir(), "ark-test-"));
  const ctx: TestContext = {
    arkDir: dir,
    dbPath: join(dir, "ark.db"),
    tracksDir: join(dir, "tracks"),
    worktreesDir: join(dir, "worktrees"),
    db: null,
    cleanup() {
      try { ctx.db?.close(); } catch {}
      ctx.db = null;
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
  return ctx;
}
