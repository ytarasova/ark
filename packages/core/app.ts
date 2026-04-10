/**
 * AppContext -- central owner of all services and their lifecycle.
 *
 * Replaces scattered singletons with explicit boot/shutdown. Every service
 * (database, event bus, conductor, metrics) is created during boot() and
 * torn down in reverse order during shutdown().
 */

import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, existsSync, mkdtempSync, readFileSync } from "fs";
import type { IDatabase } from "./database.js";
import { BunSqliteAdapter } from "./database-sqlite.js";
import { join } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";

import { asClass, asValue } from "awilix";
import { createAppContainer, type AppContainer } from "./container.js";
import { loadConfig, type ArkConfig } from "./config.js";
import { configureOtlp } from "./otlp.js";
import { safeAsync } from "./safe.js";
import { eventBus } from "./hooks.js";
import type { ComputeProvider } from "../compute/types.js";
import { safeParseConfig } from "./util.js";
import { initSchema as initRepoSchema, seedLocalCompute } from "./repositories/schema.js";
import type { Compute, Session } from "../types/index.js";
import { setProviderResolver, clearProviderResolver } from "./provider-registry.js";
import { updateTmuxStatusBar, clearTmuxStatusBar } from "./tmux-notify.js";
import { startNotifyDaemon } from "./notify-daemon.js";
import { track, configureTelemetry } from "./telemetry.js";
import { logError, logWarn, logInfo, setLogArkDir } from "./structured-log.js";
import { setProfilesArkDir } from "./profiles.js";
import { registerExecutor } from "./executor.js";
import { claudeCodeExecutor } from "./executors/claude-code.js";
import { subprocessExecutor } from "./executors/subprocess.js";
import { cliAgentExecutor } from "./executors/cli-agent.js";
import { SessionRepository, ComputeRepository, EventRepository, MessageRepository, TodoRepository } from "./repositories/index.js";
import { SessionService, ComputeService, HistoryService } from "./services/index.js";
import { FileFlowStore, FileSkillStore, FileAgentStore, FileRecipeStore } from "./stores/index.js";
import type { FlowStore, SkillStore, AgentStore, RecipeStore } from "./stores/index.js";

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
  private _container: AppContainer;

  // Keep infrastructure fields that aren't in the container
  private _eventBus: typeof eventBus | null = null;
  private _providers = new Map<string, ComputeProvider>();

  conductor: { stop(): void } | null = null;
  metricsPoller: { stop(): void } | null = null;
  /** Rollback config stored here so conductor can access it without globalThis. */
  rollbackConfig: import("./config.js").RollbackSettings | null = null;

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
    this._container = createAppContainer();
    this._container.register({ config: asValue(config) });
  }

  // ── Accessors (resolved from the DI container) ────────────────────────

  /** Convenience shortcut for config.arkDir (used heavily in tests). */
  get arkDir(): string { return this.config.arkDir; }

  get db(): IDatabase { return this._resolve("db"); }

  get eventBus(): typeof eventBus {
    if (!this._eventBus) throw new Error("AppContext not booted -- eventBus not available");
    return this._eventBus;
  }

  get sessions(): SessionRepository { return this._resolve("sessions"); }
  get computes(): ComputeRepository { return this._resolve("computes"); }
  get events(): EventRepository { return this._resolve("events"); }
  get messages(): MessageRepository { return this._resolve("messages"); }
  get todos(): TodoRepository { return this._resolve("todos"); }

  get sessionService(): SessionService { return this._resolve("sessionService"); }
  get computeService(): ComputeService { return this._resolve("computeService"); }
  get historyService(): HistoryService { return this._resolve("historyService"); }

  // ── Resource stores ────────────────────────────────────────────────────

  get flows(): FlowStore { return this._resolve("flows"); }
  get skills(): SkillStore { return this._resolve("skills"); }
  get agents(): AgentStore { return this._resolve("agents"); }
  get recipes(): RecipeStore { return this._resolve("recipes"); }

  /** Resolve from container with a user-friendly error if not booted yet. */
  private _resolve<K extends keyof import("./container.js").Cradle>(key: K): import("./container.js").Cradle[K] {
    try {
      return this._container.resolve(key);
    } catch {
      throw new Error(`AppContext not booted -- ${key} not available`);
    }
  }

  // ── Container access ───────────────────────────────────────────────────

  /** Expose the DI container for advanced use (e.g. registering test doubles). */
  get container(): AppContainer { return this._container; }

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
    const row = this.db?.prepare("SELECT * FROM compute WHERE name = ?").get(computeName) as
      { name: string; provider: string; status: string; config: string; created_at: string; updated_at: string } | undefined;
    if (!row) return { provider: null, compute: null };
    const compute = { ...row, config: safeParseConfig(row.config) } as unknown as Compute;
    const provider = this.getProvider(compute.provider);
    return { provider: provider ?? null, compute };
  }

  // ── Boot ───────────────────────────────────────────────────────────────

  async boot(): Promise<void> {
    if (this.phase !== "created") {
      throw new Error(`Cannot boot AppContext in phase "${this.phase}"`);
    }
    this.phase = "booting";

    // Auto-register as global singleton so paths.ts / getApp() work during boot
    if (!_app) _app = this;

    // 1. Ensure directories
    for (const dir of [
      this.config.arkDir,
      this.config.tracksDir,
      this.config.worktreesDir,
      this.config.logDir,
    ]) {
      mkdirSync(dir, { recursive: true });
    }

    // 1b. Configure module-level state with the resolved arkDir
    setLogArkDir(this.config.arkDir);
    setProfilesArkDir(this.config.arkDir);

    // 2. Open database with pragmas
    const rawDb = new Database(this.config.dbPath);
    rawDb.run("PRAGMA journal_mode = WAL");
    rawDb.run("PRAGMA busy_timeout = 5000");
    const db = new BunSqliteAdapter(rawDb);

    // 3. Initialize schema (new column names: ticket, summary, flow)
    initRepoSchema(db);
    seedLocalCompute(db);

    // 3b. Register all dependencies in the container
    const storeBaseDir = join(fileURLToPath(import.meta.url), "..", "..", "..");

    this._container.register({
      db: asValue(db),

      // Repositories
      sessions: asClass(SessionRepository).singleton(),
      computes: asClass(ComputeRepository).singleton(),
      events: asClass(EventRepository).singleton(),
      messages: asClass(MessageRepository).singleton(),
      todos: asClass(TodoRepository).singleton(),

      // Services
      sessionService: asClass(SessionService).singleton(),
      computeService: asClass(ComputeService).singleton(),
      historyService: asClass(HistoryService).singleton(),

      // Resource stores (constructed with config, not DI)
      flows: asValue(new FileFlowStore({
        builtinDir: join(storeBaseDir, "flows", "definitions"),
        userDir: join(this.config.arkDir, "flows"),
      })),
      skills: asValue(new FileSkillStore({
        builtinDir: join(storeBaseDir, "skills"),
        userDir: join(this.config.arkDir, "skills"),
      })),
      agents: asValue(new FileAgentStore({
        builtinDir: join(storeBaseDir, "agents"),
        userDir: join(this.config.arkDir, "agents"),
      })),
      recipes: asValue(new FileRecipeStore({
        builtinDir: join(storeBaseDir, "recipes"),
        userDir: join(this.config.arkDir, "recipes"),
      })),
    });

    // 4. Register compute providers
    await safeAsync("boot: load compute providers", async () => {
      const compute = await import("../compute/index.js");
      // Initialize compute registry with this AppContext
      compute.setComputeApp(this);
      // Legacy providers (backward compat -- same names: "local", "ec2", "docker")
      const providers = [
        new compute.LocalProvider(),
        new compute.DockerProvider(),
        // ArkD-backed providers (new: "devcontainer", "firecracker", "ec2-docker", etc.)
        new compute.LocalDevcontainerProvider(),
        new compute.LocalFirecrackerProvider(),
        new compute.RemoteDockerProvider(),
        new compute.RemoteDevcontainerProvider(),
        new compute.RemoteFirecrackerProvider(),
      ];
      for (const p of providers) {
        p.setApp?.(this);
        this.registerProvider(p);
      }

      // E2B provider (optional -- only if e2b SDK is available)
      try {
        const { E2BProvider } = await import("../compute/providers/e2b.js");
        const e2b = new E2BProvider();
        e2b.setApp(this);
        this.registerProvider(e2b);
      } catch {} // e2b SDK not installed

      // Kubernetes providers (optional -- only if @kubernetes/client-node is available)
      try {
        const { K8sProvider, KataProvider } = await import("../compute/providers/k8s.js");
        const k8s = new K8sProvider();
        k8s.setApp(this);
        this.registerProvider(k8s);
        const kata = new KataProvider();
        kata.setApp(this);
        this.registerProvider(kata);
      } catch {} // @kubernetes/client-node not installed
    });

    // 4b. Wire SessionService with AppContext
    this.sessionService.setApp(this);

    // 5. Wire provider resolver for session.ts
    setProviderResolver((session: Session) => this.resolveProvider(session));

    // 5b. Register executors
    registerExecutor(claudeCodeExecutor);
    registerExecutor(subprocessExecutor);
    registerExecutor(cliAgentExecutor);

    // 6. Set up event bus
    this._eventBus = eventBus;
    this._eventBus.clear();

    // 6b. Configure OTLP exporter
    configureOtlp(this.config.otlp);

    // 6c. Store rollback config for conductor webhook handler
    this.rollbackConfig = this.config.rollback;
    configureTelemetry(this.config.telemetry);

    // 7. Optionally start conductor (dynamic import to avoid circular deps)
    if (!this.options.skipConductor) {
      await safeAsync("boot: start conductor", async () => {
        const { startConductor } = await import("./conductor.js");
        this.conductor = startConductor(this, this.config.conductorPort, { quiet: true });
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
      const orphaned = findOrphanedSessions(this);
      if (orphaned.length > 0) {
        this._orphanedSessions = orphaned;
        for (const s of orphaned) {
          logWarn("session", `Orphaned session detected: ${s.id} (status: ${s.status}, stage: ${s.stage})`);
        }
      }
    });

    // 11. Purge expired soft-deletes every 30s
    this._purgeInterval = setInterval(() => {
      try {
        const deleted = this.sessions.listDeleted();
        const cutoff = Date.now() - 90 * 1000;
        for (const s of deleted) {
          const deletedAt = s.config?._deleted_at as string | undefined;
          if (deletedAt && new Date(deletedAt).getTime() < cutoff) {
            this.sessions.delete(s.id);
          }
        }
      } catch { /* container may be disposed during shutdown */ }
    }, 30_000);

    // 12. Update tmux status bar every 5s
    this._tmuxStatusInterval = setInterval(() => {
      updateTmuxStatusBar(this);
    }, 5_000);

    // 13. Start notification daemon (if bridge config exists)
    this._notifyDaemon = startNotifyDaemon(this);

    // 14. Clean up logs on boot (non-blocking)
    safeAsync("boot: cleanup logs", async () => {
      const { cleanupLogs } = await import("./log-manager.js");
      cleanupLogs(this);
    });

    // 15. Clean up stale hook configs in cwd
    await safeAsync("boot: cleanup stale hooks", async () => {
      const cwd = process.cwd();
      const settingsPath = join(cwd, ".claude", "settings.local.json");
      if (existsSync(settingsPath)) {
        try {
          const content = JSON.parse(readFileSync(settingsPath, "utf-8"));
          const cmd = content?.hooks?.Stop?.[0]?.hooks?.[0]?.command ?? "";
          if (cmd.includes("ark-status")) {
            const match = cmd.match(/session=([^'&\s]+)/);
            const sid = match?.[1];
            if (sid) {
              const session = this.sessions.get(sid);
              if (!session || !["running", "waiting"].includes(session.status)) {
                const { removeHooksConfig } = await import("./claude.js");
                removeHooksConfig(cwd);
              }
            }
          }
        } catch { /* ignore parse errors */ }
      }
    });

    // 16. Detect stale running sessions (tmux died while TUI was closed)
    await safeAsync("boot: detect stale sessions", async () => {
      const { sessionExistsAsync } = await import("./tmux.js");
      const running = this.sessions.list({ status: "running" });
      for (const s of running) {
        if (s.session_id && !(await sessionExistsAsync(s.session_id))) {
          this.sessions.update(s.id, {
            status: "failed",
            error: "Agent process exited while Ark was not running",
            session_id: null,
          });
          this.events.log(s.id, "session_stale_detected", { actor: "system" });
        }
      }
    });

    // 17. Telemetry: track app boot
    track("app_boot");

    this.phase = "ready";
  }

  // ── Shutdown ───────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    if (this.phase === "stopped" || this.phase === "shutting_down") return;
    const wasBooted = this.phase === "ready";
    this.phase = "shutting_down";

    // Fast path: if never booted, skip all infrastructure teardown
    if (!wasBooted) {
      await this._container.dispose();
      if (this.options.cleanupOnShutdown && existsSync(this.config.arkDir)) {
        rmSync(this.config.arkDir, { recursive: true, force: true });
      }
      if (_app === this) _app = null;
      this.phase = "stopped";
      return;
    }

    // Reverse order of boot

    // Shutdown in reverse order of boot.
    // Step 0: stop running sessions (test mode only -- production sessions survive)
    if (this.options?.cleanupOnShutdown) {
      await this.sessionService.stopAll();
    }

    // Step 1: tear down infrastructure (reverse of boot steps 7-10)
    this._removeSignalHandlers();

    try { const { stopAllPollers } = await import("./executors/status-poller.js"); stopAllPollers(); } catch {}

    if (this._notifyDaemon) { this._notifyDaemon.stop(); this._notifyDaemon = null; }
    if (this._tmuxStatusInterval) { clearInterval(this._tmuxStatusInterval); this._tmuxStatusInterval = null; }
    clearTmuxStatusBar();
    if (this._purgeInterval) { clearInterval(this._purgeInterval); this._purgeInterval = null; }
    if (this.metricsPoller) { this.metricsPoller.stop(); this.metricsPoller = null; }
    if (this.conductor) { this.conductor.stop(); this.conductor = null; }
    if (this._eventBus) { this._eventBus.clear(); this._eventBus = null; }

    // Step 2: flush observability
    try {
      const { flush: flushTelemetry } = await import("./telemetry.js");
      const { flushSpans, resetOtlp } = await import("./otlp.js");
      await flushTelemetry();
      await flushSpans();
      resetOtlp();
    } catch {}

    // Step 3: tear down compute + DI container (reverse of boot steps 3-5)
    clearProviderResolver();
    try { this._container.resolve("db").close(); } catch {}
    await this._container.dispose();

    // Step 4: clean up temp directory (test mode)
    if (this.options.cleanupOnShutdown && existsSync(this.config.arkDir)) {
      rmSync(this.config.arkDir, { recursive: true, force: true });
    }

    // Clear global singleton if this instance is the current one
    if (_app === this) _app = null;

    this.phase = "stopped";
  }

  // ── Metrics Poller ─────────────────────────────────────────────────────

  private _startMetricsPoller(): { stop(): void } {
    const handle = setInterval(async () => {
      await safeAsync("metrics: poll computes", async () => {
        const computes = this.computes?.list({ status: "running" }) ?? [];
        for (const c of computes) {
          await safeAsync(`metrics: poll compute "${c.name}"`, async () => {
            const compute = await import("../compute/index.js") as Record<string, unknown>;
            if (typeof compute.pollMetrics === "function") {
              await (compute.pollMetrics as (name: string) => Promise<void>)(c.name);
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
      process.on(signal as NodeJS.Signals, handler);
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
  if (!_app) throw new Error("AppContext not initialized -- call setApp() first");
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
