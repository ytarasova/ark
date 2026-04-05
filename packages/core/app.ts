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
import { configureOtlp } from "./otlp.js";
import { safeAsync } from "./safe.js";
import { eventBus } from "./hooks.js";
import type { ComputeProvider } from "../compute/types.js";
import { initSchema as initStoreSchema, setAppStore, clearAppStore, safeParseConfig, purgeExpiredDeletes } from "./store.js";
import type { Compute, Session } from "./store.js";
import { setProviderResolver, clearProviderResolver } from "./session.js";
import { updateTmuxStatusBar, clearTmuxStatusBar } from "./tmux-notify.js";
import { startNotifyDaemon } from "./notify-daemon.js";
import { track, configureTelemetry } from "./telemetry.js";
import { logError, logWarn, logInfo } from "./structured-log.js";

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
  private _orphanedSessions: Session[] = [];
  private _purgeInterval: ReturnType<typeof setInterval> | null = null;
  private _tmuxStatusInterval: ReturnType<typeof setInterval> | null = null;
  private _notifyDaemon: { stop(): void } | null = null;

  /** Sessions detected as orphaned during boot (running but tmux dead). */
  get orphanedSessions(): Session[] {
    return this._orphanedSessions;
  }

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
    // Query compute directly via the app DB to avoid circular imports
    const row = this._db?.prepare("SELECT * FROM compute WHERE name = ?").get(computeName) as
      { name: string; provider: string; status: string; config: string; created_at: string; updated_at: string } | undefined;
    if (!row) return { provider: null, compute: null };
    const compute: Compute = { ...row, config: safeParseConfig(row.config) };
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

    // 3. Initialize schema + wire store paths
    initStoreSchema(this._db);
    setAppStore(this._db, this.config);
    // Seed directly on this._db since _app singleton isn't set yet during boot
    const row = this._db.prepare("SELECT name FROM compute WHERE name = 'local'").get();
    if (!row) {
      const ts = new Date().toISOString();
      this._db.prepare(
        "INSERT OR IGNORE INTO compute (name, provider, status, config, created_at, updated_at) VALUES ('local', 'local', 'running', '{}', ?, ?)"
      ).run(ts, ts);
    }

    // 4. Register compute providers
    await safeAsync("boot: load compute providers", async () => {
      const compute = await import("../compute/index.js");
      // Legacy providers (backward compat — same names: "local", "ec2", "docker")
      this.registerProvider(new compute.LocalProvider());
      this.registerProvider(new compute.EC2Provider());
      this.registerProvider(new compute.DockerProvider());

      // ArkD-backed providers (new: "devcontainer", "firecracker", "ec2-docker", etc.)
      this.registerProvider(new compute.LocalDevcontainerProvider());
      this.registerProvider(new compute.LocalFirecrackerProvider());
      this.registerProvider(new compute.RemoteDockerProvider());
      this.registerProvider(new compute.RemoteDevcontainerProvider());
      this.registerProvider(new compute.RemoteFirecrackerProvider());
    });

    // 5. Wire provider resolver for session.ts
    setProviderResolver((session) => this.resolveProvider(session));

    // 6. Set up event bus
    this._eventBus = eventBus;
    this._eventBus.clear();

    // 6b. Configure OTLP exporter
    configureOtlp(this.config.otlp);

    // 6c. Store rollback config for conductor webhook handler
    (globalThis as any).__arkRollbackConfig = this.config.rollback;
    configureTelemetry(this.config.telemetry);

    // 7. Optionally start conductor (dynamic import to avoid circular deps)
    if (!this.options.skipConductor) {
      await safeAsync("boot: start conductor", async () => {
        const { startConductor } = await import("./conductor.js");
        this.conductor = startConductor(this.config.conductorPort, { quiet: true });
      });
    }

    // 8. Optionally start metrics poller
    if (!this.options.skipMetrics) {
      this.metricsPoller = this._startMetricsPoller();
    }

    // 9. Register signal handlers
    if (!this.options.skipSignals) {
      this._registerSignalHandlers();
    }

    // 10. Detect orphaned sessions (crashed while running)
    await safeAsync("boot: detect orphaned sessions", async () => {
      const { findOrphanedSessions } = await import("./checkpoint.js");
      const orphaned = findOrphanedSessions();
      if (orphaned.length > 0) {
        this._orphanedSessions = orphaned;
        for (const s of orphaned) {
          logWarn("session", `Orphaned session detected: ${s.id} (status: ${s.status}, stage: ${s.stage})`);
        }
      }
    });

    // 11. Purge expired soft-deletes every 30s
    this._purgeInterval = setInterval(() => {
      purgeExpiredDeletes(90);
    }, 30_000);

    // 12. Update tmux status bar every 5s
    this._tmuxStatusInterval = setInterval(() => {
      updateTmuxStatusBar();
    }, 5_000);

    // 13. Start notification daemon (if bridge config exists)
    this._notifyDaemon = startNotifyDaemon();

    // 14. Clean up logs on boot (non-blocking)
    safeAsync("boot: cleanup logs", async () => {
      const { cleanupLogs } = await import("./log-manager.js");
      cleanupLogs();
    });

    // 15. Telemetry: track app boot
    track("app_boot");

    this.phase = "ready";
  }

  // ── Shutdown ───────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    if (this.phase === "stopped" || this.phase === "shutting_down") return;
    this.phase = "shutting_down";

    // Reverse order of boot

    // 1. Remove signal handlers
    this._removeSignalHandlers();

    // 2. Close SSH connection pools
    await safeAsync("shutdown: destroy SSH pools", async () => {
      const { destroyAllPools } = await import("../compute/providers/ec2/pool.js");
      await destroyAllPools();
    });

    // 3. Stop notification daemon
    if (this._notifyDaemon) {
      this._notifyDaemon.stop();
      this._notifyDaemon = null;
    }

    // 4. Clear tmux status bar
    if (this._tmuxStatusInterval) {
      clearInterval(this._tmuxStatusInterval);
      this._tmuxStatusInterval = null;
    }
    clearTmuxStatusBar();

    // 5. Stop purge interval
    if (this._purgeInterval) {
      clearInterval(this._purgeInterval);
      this._purgeInterval = null;
    }

    // 6. Stop metrics poller
    if (this.metricsPoller) {
      this.metricsPoller.stop();
      this.metricsPoller = null;
    }

    // 7. Stop conductor
    if (this.conductor) {
      this.conductor.stop();
      this.conductor = null;
    }

    // 8. Clear event bus
    if (this._eventBus) {
      this._eventBus.clear();
      this._eventBus = null;
    }

    // 8b. Flush telemetry and OTLP before shutdown
    try {
      const { flush: flushTelemetry } = await import("./telemetry.js");
      const { flushSpans, resetOtlp } = await import("./otlp.js");
      await flushTelemetry();
      await flushSpans();
      resetOtlp();
    } catch { /* best-effort */ }

    // 9. Clear provider resolver + app store bindings + close database
    clearProviderResolver();
    clearAppStore();
    if (this._db) {
      try { this._db.close(); } catch (e: any) {
        // DB may already be closed — log but don't fail shutdown
        logError("general", `shutdown: failed to close database: ${e?.message ?? e}`);
      }
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
      await safeAsync("metrics: poll computes", async () => {
        const store = await import("./store.js");
        const computes = store.listCompute({ status: "running" });
        for (const c of computes) {
          await safeAsync(`metrics: poll compute "${c.name}"`, async () => {
            const compute = await import("../compute/index.js") as any;
            if (typeof compute.pollMetrics === "function") {
              await compute.pollMetrics(c.name);
            }
          });
        }
      });
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
          logError("general", `Error during ${signal} shutdown: ${err}`);
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
