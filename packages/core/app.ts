/**
 * AppContext — central owner of all services and their lifecycle.
 *
 * Replaces scattered singletons with explicit boot/shutdown. Every service
 * (database, event bus, conductor, metrics) is created during boot() and
 * torn down in reverse order during shutdown().
 */

import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, existsSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { loadConfig, type ArkConfig } from "./config.js";
import { eventBus } from "./hooks.js";
import type { ComputeProvider } from "../compute/types.js";
import type { Compute, Session } from "./store.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type Phase = "created" | "booting" | "ready" | "shutting_down" | "stopped";

export interface AppOptions {
  /** Skip conductor start on boot (default: false in production, true in test) */
  skipConductor?: boolean;
  /** Skip metrics poller on boot (default: false in production, true in test) */
  skipMetrics?: boolean;
  /** Skip signal handler registration (default: false in production, true in test) */
  skipSignals?: boolean;
  /** Remove arkDir on shutdown (used by forTest) */
  cleanupOnShutdown?: boolean;
}

// ── Schema ─────────────────────────────────────────────────────────────────

function initSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      jira_key TEXT,
      jira_summary TEXT,
      repo TEXT,
      branch TEXT,
      compute_name TEXT,
      session_id TEXT,
      claude_session_id TEXT,
      stage TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      pipeline TEXT NOT NULL DEFAULT 'default',
      agent TEXT,
      workdir TEXT,
      pr_url TEXT,
      pr_id TEXT,
      error TEXT,
      parent_id TEXT,
      fork_group TEXT,
      group_name TEXT,
      breakpoint_reason TEXT,
      attached_by TEXT,
      config TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id TEXT NOT NULL,
      type TEXT NOT NULL,
      stage TEXT,
      actor TEXT,
      data TEXT,
      created_at TEXT NOT NULL
    )
  `);

  db.run("CREATE INDEX IF NOT EXISTS idx_events_track ON events(track_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)");
  db.run("CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)");
  db.run("CREATE INDEX IF NOT EXISTS idx_sessions_repo ON sessions(repo)");
  db.run("CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_sessions_group ON sessions(group_name)");

  db.run(`
    CREATE TABLE IF NOT EXISTS compute (
      name TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'local',
      status TEXT NOT NULL DEFAULT 'stopped',
      config TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run("CREATE INDEX IF NOT EXISTS idx_compute_provider ON compute(provider)");
  db.run("CREATE INDEX IF NOT EXISTS idx_compute_status ON compute(status)");

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text',
      read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);

  db.run("CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)");

  db.run(`
    CREATE TABLE IF NOT EXISTS groups (
      name TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    )
  `);
}

function seedLocalCompute(db: Database): void {
  const row = db.prepare("SELECT name FROM compute WHERE name = 'local'").get();
  if (!row) {
    const ts = new Date().toISOString();
    db.prepare(
      "INSERT OR IGNORE INTO compute (name, provider, status, config, created_at, updated_at) VALUES ('local', 'local', 'running', '{}', ?, ?)"
    ).run(ts, ts);
  }
}

// ── AppContext ──────────────────────────────────────────────────────────────

export class AppContext {
  phase: Phase = "created";
  readonly config: ArkConfig;
  private readonly options: AppOptions;

  private _db: Database | null = null;
  private _eventBus: typeof eventBus | null = null;
  private _providers = new Map<string, ComputeProvider>();

  conductor: { stop(): void } | null = null;
  metricsPoller: { stop(): void } | null = null;

  private _signalHandlers: { signal: string; handler: () => void }[] = [];
  private _forceExitCount = 0;

  constructor(config: ArkConfig, options: AppOptions = {}) {
    this.config = config;
    this.options = options;
  }

  // ── Accessors ──────────────────────────────────────────────────────────

  get db(): Database {
    if (!this._db) throw new Error("AppContext not booted — db not available");
    return this._db;
  }

  get eventBus(): typeof eventBus {
    if (!this._eventBus) throw new Error("AppContext not booted — eventBus not available");
    return this._eventBus;
  }

  // ── Provider registry ──────────────────────────────────────────────────

  registerProvider(provider: ComputeProvider): void {
    this._providers.set(provider.name, provider);
  }

  getProvider(name: string): ComputeProvider | null {
    return this._providers.get(name) ?? null;
  }

  listProviders(): string[] {
    return [...this._providers.keys()];
  }

  /** Resolve the compute provider for a session. Defaults to local. */
  resolveProvider(session: Session): { provider: ComputeProvider | null; compute: Compute | null } {
    const computeName = session.compute_name || "local";
    const { getCompute } = require("./store.js");
    const compute = getCompute(computeName);
    if (!compute) return { provider: null, compute: null };
    const provider = this.getProvider(compute.provider);
    return { provider: provider ?? null, compute };
  }

  // ── Boot ───────────────────────────────────────────────────────────────

  async boot(): Promise<void> {
    if (this.phase !== "created") {
      throw new Error(`Cannot boot AppContext in phase "${this.phase}"`);
    }
    this.phase = "booting";

    // 1. Ensure directories
    for (const dir of [
      this.config.arkDir,
      this.config.tracksDir,
      this.config.worktreesDir,
      this.config.logDir,
    ]) {
      mkdirSync(dir, { recursive: true });
    }

    // 2. Open database with pragmas
    this._db = new Database(this.config.dbPath);
    this._db.run("PRAGMA journal_mode = WAL");
    this._db.run("PRAGMA busy_timeout = 5000");

    // 3. Initialize schema + seed local compute
    initSchema(this._db);
    seedLocalCompute(this._db);

    // 4. Register compute providers
    try {
      const compute = await import("../compute/index.js");
      this.registerProvider(new compute.LocalProvider());
      this.registerProvider(new compute.EC2Provider());
      this.registerProvider(new compute.DockerProvider());
    } catch {
      // compute module may not be available in minimal builds
    }

    // 5. Set up event bus
    this._eventBus = eventBus;
    this._eventBus.clear();

    // 6. Optionally start conductor (dynamic import to avoid circular deps)
    if (!this.options.skipConductor) {
      try {
        const { startConductor } = await import("./conductor.js");
        this.conductor = startConductor(this.config.conductorPort, { quiet: true });
      } catch {
        // conductor module may not exist yet — that's fine
      }
    }

    // 7. Optionally start metrics poller
    if (!this.options.skipMetrics) {
      this.metricsPoller = this._startMetricsPoller();
    }

    // 8. Register signal handlers
    if (!this.options.skipSignals) {
      this._registerSignalHandlers();
    }

    this.phase = "ready";
  }

  // ── Shutdown ───────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    if (this.phase === "stopped" || this.phase === "shutting_down") return;
    this.phase = "shutting_down";

    // Reverse order of boot

    // 1. Remove signal handlers
    this._removeSignalHandlers();

    // 2. Stop metrics poller
    if (this.metricsPoller) {
      this.metricsPoller.stop();
      this.metricsPoller = null;
    }

    // 3. Stop conductor
    if (this.conductor) {
      this.conductor.stop();
      this.conductor = null;
    }

    // 4. Clear event bus
    if (this._eventBus) {
      this._eventBus.clear();
      this._eventBus = null;
    }

    // 5. Close database
    if (this._db) {
      try { this._db.close(); } catch { /* already closed */ }
      this._db = null;
    }

    // 6. Clean up temp directory (test mode)
    if (this.options.cleanupOnShutdown && existsSync(this.config.arkDir)) {
      rmSync(this.config.arkDir, { recursive: true, force: true });
    }

    this.phase = "stopped";
  }

  // ── Metrics Poller ─────────────────────────────────────────────────────

  private _startMetricsPoller(): { stop(): void } {
    const handle = setInterval(async () => {
      try {
        const store = await import("./store.js");
        const computes = store.listCompute({ status: "running" });
        for (const c of computes) {
          // Poll metrics for each running compute
          try {
            const compute = await import("./compute.js");
            if (typeof compute.pollMetrics === "function") {
              await compute.pollMetrics(c.name);
            }
          } catch {
            // compute module may not have pollMetrics — skip
          }
        }
      } catch {
        // store not available yet — skip this tick
      }
    }, 30_000);

    return { stop: () => clearInterval(handle) };
  }

  // ── Signal Handlers ────────────────────────────────────────────────────

  private _registerSignalHandlers(): void {
    const makeHandler = (signal: string) => {
      const handler = () => {
        this._forceExitCount++;
        if (this._forceExitCount >= 2) {
          process.exit(1);
        }
        this.shutdown().catch((err) => {
          console.error(`Error during ${signal} shutdown:`, err);
          process.exit(1);
        });
      };
      this._signalHandlers.push({ signal, handler });
      process.on(signal as any, handler);
    };

    makeHandler("SIGINT");
    makeHandler("SIGTERM");
  }

  private _removeSignalHandlers(): void {
    for (const { signal, handler } of this._signalHandlers) {
      process.removeListener(signal, handler);
    }
    this._signalHandlers = [];
  }

  // ── Factory ────────────────────────────────────────────────────────────

  /**
   * Create an AppContext for tests with an isolated temp directory.
   * The temp dir is cleaned up on shutdown.
   */
  static forTest(overrides?: Partial<ArkConfig>): AppContext {
    const tempDir = mkdtempSync(join(tmpdir(), "ark-test-"));
    const config = loadConfig({
      arkDir: tempDir,
      env: "test",
      ...overrides,
    });
    return new AppContext(config, {
      skipConductor: true,
      skipMetrics: true,
      skipSignals: true,
      cleanupOnShutdown: true,
    });
  }
}

// ── Global Singleton ───────────────────────────────────────────────────────

let _app: AppContext | null = null;

/** Get the global AppContext. Throws if not set. */
export function getApp(): AppContext {
  if (!_app) throw new Error("AppContext not initialized — call setApp() first");
  return _app;
}

/** Set the global AppContext singleton. */
export function setApp(app: AppContext): void {
  _app = app;
}

/** Clear the global AppContext (for tests). */
export function clearApp(): void {
  _app = null;
}
