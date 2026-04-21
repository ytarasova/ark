/**
 * AppContext -- central owner of all services and their lifecycle.
 *
 * All startable/stoppable services live in the awilix DI container; the
 * container's dispose mechanism tears them down in reverse resolution
 * order. `boot()` reduces to building the container + resolving the
 * `Lifecycle` service; `shutdown()` to `container.dispose()`.
 *
 * Extracted infra (conductor, arkd, router, tensorzero, pollers,
 * signal handlers, stale-state scan) lives under packages/core/infra/
 * and is registered in packages/core/di/runtime.ts.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, existsSync, mkdtempSync } from "fs";
import type { IDatabase } from "./database/index.js";
import { BunSqliteAdapter } from "./database/index.js";
import { join } from "path";
import { tmpdir } from "os";

import { asValue } from "awilix";
import { createAppContainer, type AppContainer, type AppBootOptions } from "./container.js";
import { buildContainer } from "./di/index.js";
import { loadConfig, loadAppConfig, type ArkConfig } from "./config.js";
import { eventBus } from "./hooks.js";
import type { ComputeProvider } from "../compute/types.js";
import type { Compute as NewCompute, Runtime as NewRuntime, ComputeKind, RuntimeKind } from "../compute/core/types.js";
import type { ComputePool } from "../compute/core/pool/types.js";
import type { SnapshotStore } from "../compute/core/snapshot-store.js";
import { initSchema as initRepoSchema, seedLocalCompute } from "./repositories/schema.js";
import type { Compute, Session, ComputeProviderName } from "../types/index.js";
import { track } from "./observability/telemetry.js";
import { setLogArkDir } from "./observability/structured-log.js";
import { setProfilesArkDir } from "./state/profiles.js";
import type {
  SessionRepository,
  ComputeRepository,
  ComputeTemplateRepository,
  EventRepository,
  MessageRepository,
  TodoRepository,
  ArtifactRepository,
  FlowStateRepository,
  LedgerRepository,
} from "./repositories/index.js";
import { ComputeTemplateRepository as ComputeTemplateRepositoryCtor } from "./repositories/index.js";
import type { SessionService, ComputeService, HistoryService } from "./services/index.js";
import type { FlowStore, SkillStore, AgentStore, RecipeStore, RuntimeStore } from "./stores/index.js";
import { buildTenantScope } from "./tenant-scope.js";
import { ComputeRegistries } from "./compute-registries.js";
import { resolveProvider, resolveComputeTarget } from "./compute-resolver.js";
import type { TranscriptParserRegistry } from "./runtimes/transcript-parser.js";
import type { PluginRegistry } from "./plugins/registry.js";
import type { SessionLauncher } from "./session-launcher.js";
import { TmuxLauncher } from "./launchers/tmux.js";
import { NoopLauncher } from "./launchers/noop.js";
import { ApiKeyManager } from "./auth/index.js";
import type { WorkerRegistry } from "./hosted/worker-registry.js";
import type { SessionScheduler } from "./hosted/scheduler.js";
import type { TenantPolicyManager } from "./auth/index.js";
import type { KnowledgeStore } from "./knowledge/store.js";
import type { CodeIntelStore } from "./code-intel/store.js";
import { CodeIntelStore as CodeIntelStoreCtor } from "./code-intel/store.js";
import type { Deployment } from "./code-intel/interfaces/deployment.js";
import { buildDeployment } from "./code-intel/deployment.js";
import type { PricingRegistry } from "./observability/pricing.js";
import type { UsageRecorder } from "./observability/usage.js";
import type { TensorZeroManager } from "./router/tensorzero.js";
import type { BlobStore } from "./storage/blob-store.js";
import type { AppMode } from "./modes/app-mode.js";
import { buildAppMode } from "./modes/app-mode.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type Phase = "created" | "booting" | "ready" | "shutting_down" | "stopped";

export type AppOptions = AppBootOptions;

// ── AppContext ──────────────────────────────────────────────────────────────

export class AppContext {
  phase: Phase = "created";
  readonly config: ArkConfig;
  private readonly options: AppOptions;
  private _container: AppContainer;

  // Non-container state -- provider registries live here because providers
  // are registered imperatively during boot (they need a reference back to
  // the AppContext), not constructed from config.
  private _registries = new ComputeRegistries(this);

  private _launcher: SessionLauncher = new TmuxLauncher();
  private _eventBusReady = false;
  private _apiKeys: ApiKeyManager | null = null;
  private _codeIntel: CodeIntelStore | null = null;
  private _deployment: Deployment | null = null;
  private _hostedServices: {
    workerRegistry?: WorkerRegistry;
    scheduler?: SessionScheduler;
    tenantPolicyManager?: TenantPolicyManager;
  } = {};

  /** Rollback config stored here so conductor can access it without globalThis. */
  rollbackConfig: import("./config.js").RollbackSettings | null = null;

  constructor(config: ArkConfig, options: AppOptions = {}) {
    this.config = config;
    this.options = options;
    // Placeholder container -- the real one is built in boot() once the DB
    // is open. We still register `config` + `app` here so call sites that
    // read config before boot (rare, but a few tests do) keep working.
    this._container = createAppContainer();
    this._container.register({
      config: asValue(config),
      app: asValue(this),
      bootOptions: asValue(this.options as AppBootOptions),
    });
  }

  // ── Boot / Shutdown (one-liners; everything lives in the container) ──

  async boot(): Promise<void> {
    if (this.phase !== "created") {
      throw new Error(`Cannot boot AppContext in phase "${this.phase}"`);
    }
    this.phase = "booting";

    // Preconditions that must happen before the container can be built:
    // filesystem, DB open, schema migration, compute-template seeding, and
    // ApiKeyManager init (the API key manager currently creates its own
    // schema and isn't container-managed; kept here for minimal diff).
    this._initFilesystem();
    const db = await this._openDatabase();
    await this._initSchema(db);
    this._seedComputeTemplates(db);
    this._apiKeys = new ApiKeyManager(db);

    // Container + lifecycle. `buildContainer()` wires every repo, store,
    // service, and infra launcher; `lifecycle.start()` resolves + calls
    // `start()` on each launcher in canonical order. Awilix tracks every
    // resolution so `container.dispose()` later tears them down in reverse.
    this._container = buildContainer({ app: this, config: this.config, db, bootOptions: this.options });
    await this._container.cradle.lifecycle.start();

    track("app_boot");
    this.phase = "ready";
  }

  async shutdown(): Promise<void> {
    if (this.phase === "stopped" || this.phase === "shutting_down") return;
    const wasBooted = this.phase === "ready";
    this.phase = "shutting_down";

    if (wasBooted) {
      // container.dispose() walks every registered disposer in reverse
      // resolution order. ServiceWiring.stop() drains pending session
      // dispatches up front so running agents are told to exit before
      // we pull the rug.
      await this._container.dispose();
    } else {
      // Fast path: never booted -- dispose only closes the (likely unopened)
      // DB and clears the placeholder container.
      await this._container.dispose().catch(() => {});
    }

    // Clean up temp directory (test mode)
    if (this.options.cleanupOnShutdown && existsSync(this.config.arkDir)) {
      rmSync(this.config.arkDir, { recursive: true, force: true });
    }

    this.phase = "stopped";
  }

  // ── Boot helpers (pre-container bootstrap only) ──────────────────────

  private _initFilesystem(): void {
    for (const dir of [this.config.arkDir, this.config.tracksDir, this.config.worktreesDir, this.config.logDir]) {
      mkdirSync(dir, { recursive: true });
    }
    setLogArkDir(this.config.arkDir);
    setProfilesArkDir(this.config.arkDir);
  }

  private async _openDatabase(): Promise<IDatabase> {
    const dbUrl = this.config.databaseUrl;
    if (dbUrl && (dbUrl.startsWith("postgres://") || dbUrl.startsWith("postgresql://"))) {
      const { PostgresAdapter } = await import("./database/postgres.js");
      return new PostgresAdapter(dbUrl);
    }
    const rawDb = new Database(this.config.dbPath);
    rawDb.run("PRAGMA journal_mode = WAL");
    rawDb.run("PRAGMA busy_timeout = 5000");
    return new BunSqliteAdapter(rawDb);
  }

  private async _initSchema(db: IDatabase): Promise<void> {
    const dbUrl = this.config.databaseUrl;
    const isPostgres = !!(dbUrl && (dbUrl.startsWith("postgres://") || dbUrl.startsWith("postgresql://")));
    if (isPostgres) {
      const { initPostgresSchema, seedLocalComputePostgres } = await import("./repositories/schema-postgres.js");
      initPostgresSchema(db);
      seedLocalComputePostgres(db);
    } else {
      initRepoSchema(db);
      seedLocalCompute(db);
    }
  }

  private _seedComputeTemplates(db: IDatabase): void {
    if (!this.config.computeTemplates?.length) return;
    const tmplRepo = new ComputeTemplateRepositoryCtor(db);
    for (const tmpl of this.config.computeTemplates) {
      if (!tmplRepo.get(tmpl.name)) {
        tmplRepo.create({
          name: tmpl.name,
          description: tmpl.description,
          provider: tmpl.provider as ComputeProviderName,
          config: tmpl.config,
        });
      }
    }
  }

  // ── Accessors (resolved from the DI container) ────────────────────────

  /** Convenience shortcut for config.arkDir (used heavily in tests). */
  get arkDir(): string {
    return this.config.arkDir;
  }

  get db(): IDatabase {
    return this._resolve("db");
  }

  get eventBus(): typeof eventBus {
    if (!this._eventBusReady) throw new Error("AppContext not booted -- eventBus not available");
    return eventBus;
  }

  get sessions(): SessionRepository {
    return this._resolve("sessions");
  }
  get computes(): ComputeRepository {
    return this._resolve("computes");
  }
  get computeTemplates(): ComputeTemplateRepository {
    return this._resolve("computeTemplates");
  }
  get events(): EventRepository {
    return this._resolve("events");
  }
  get messages(): MessageRepository {
    return this._resolve("messages");
  }
  get todos(): TodoRepository {
    return this._resolve("todos");
  }
  get artifacts(): ArtifactRepository {
    return this._resolve("artifacts");
  }
  get flowStates(): FlowStateRepository {
    return this._resolve("flowStates");
  }
  get ledger(): LedgerRepository {
    return this._resolve("ledger");
  }

  /** API key manager for multi-tenant auth. Available after boot. */
  get apiKeys(): ApiKeyManager {
    if (!this._apiKeys) throw new Error("AppContext not booted -- apiKeys not available");
    return this._apiKeys;
  }

  get sessionService(): SessionService {
    return this._resolve("sessionService");
  }
  get computeService(): ComputeService {
    return this._resolve("computeService");
  }
  get historyService(): HistoryService {
    return this._resolve("historyService");
  }

  // ── Resource stores ────────────────────────────────────────────────────

  get flows(): FlowStore {
    return this._resolve("flows");
  }
  get skills(): SkillStore {
    return this._resolve("skills");
  }
  get agents(): AgentStore {
    return this._resolve("agents");
  }
  get recipes(): RecipeStore {
    return this._resolve("recipes");
  }
  get runtimes(): RuntimeStore {
    return this._resolve("runtimes");
  }
  get knowledge(): KnowledgeStore {
    return this._resolve("knowledge");
  }

  /**
   * Code-intel store -- lazy. Constructed on first access and migrated
   * automatically. Backed by SQLite locally, Postgres in control-plane.
   * The store is independent of the legacy KnowledgeStore (which keeps
   * operating in parallel).
   */
  get codeIntel(): CodeIntelStore {
    if (!this._codeIntel) {
      this._codeIntel = CodeIntelStoreCtor.fromApp(this);
      this._codeIntel.migrate();
    }
    return this._codeIntel;
  }

  /** Deployment facade -- mode + store backend + vendor resolver. Lazy. */
  get deployment(): Deployment {
    if (!this._deployment) {
      this._deployment = buildDeployment(this);
    }
    return this._deployment;
  }

  // ── Snapshot persistence ───────────────────────────────────────────────

  /** Snapshot store used by `session/pause` + `session/resume`. */
  get snapshotStore(): SnapshotStore {
    return this._resolve("snapshotStore");
  }

  // ── Blob storage (inputs, exports) ────────────────────────────────────

  /** Blob store for session input uploads. Local-disk or S3 depending on profile. */
  get blobStore(): BlobStore {
    return this._resolve("blobStore");
  }

  // ── Deployment-mode descriptor ────────────────────────────────────────
  //
  // Picked ONCE at DI composition based on `config.database.url`; resolved
  // polymorphically thereafter. Handlers/services/components never branch on
  // a `hosted` boolean -- they look at `app.mode.<capability>` and act on its
  // presence/absence.
  //
  // Available before boot: we build a pre-boot AppMode directly from config so
  // call sites that inspect `app.mode.kind` during construction (e.g. handler
  // registration, which happens before `lifecycle.start()` for the conductor
  // path) keep working. Once the container is built, the DI-registered mode
  // shadows the pre-boot one.
  private _preBootMode: AppMode | null = null;

  get mode(): AppMode {
    if (this.phase === "ready" || this.phase === "shutting_down") {
      try {
        return this._container.resolve("mode");
      } catch {
        // fall through to the pre-boot mode below
      }
    }
    if (!this._preBootMode) {
      this._preBootMode = buildAppMode(this.config, this);
    }
    return this._preBootMode;
  }

  // ── Tenant scoping ───────────────────────────────────────────────────
  //
  // Base AppContext is not tenant-scoped. `forTenant(id)` returns a shallow
  // copy that sets `tenantId` via Object.defineProperty, so this accessor
  // returns null on the root context and the scoped id on per-tenant views.

  get tenantId(): string | null {
    return null;
  }

  // ── Cost tracking ─────────────────────────────────────────────────────

  get pricing(): PricingRegistry {
    return this._resolve("pricing");
  }
  get usageRecorder(): UsageRecorder {
    return this._resolve("usageRecorder");
  }

  // ── Runtime transcript parsers ────────────────────────────────────────

  get transcriptParsers(): TranscriptParserRegistry {
    return this._resolve("transcriptParsers");
  }

  // ── Plugin registry ────────────────────────────────────────────────────

  get pluginRegistry(): PluginRegistry {
    return this._resolve("pluginRegistry");
  }

  // ── Infra launcher accessors (container-managed internal state) ──────

  /** Orphaned sessions detected during boot (running but tmux dead). */
  get orphanedSessions(): Session[] {
    if (this.phase !== "ready") return [];
    try {
      return this._container.cradle.staleStateDetector.orphanedSessions;
    } catch {
      return [];
    }
  }

  /** Legacy compat: expose the conductor handle (null when skipConductor). */
  get conductor(): { stop(): void } | null {
    if (this.phase !== "ready") return null;
    try {
      const launcher = this._container.cradle.conductorLauncher;
      return launcher.running ? { stop: () => launcher.stop() } : null;
    } catch {
      return null;
    }
  }

  /** Legacy compat: expose the arkd handle (null when skipConductor). */
  get arkd(): { stop(): void } | null {
    if (this.phase !== "ready") return null;
    try {
      const launcher = this._container.cradle.arkdLauncher;
      return launcher.running ? { stop: () => launcher.stop() } : null;
    } catch {
      return null;
    }
  }

  /** Legacy compat: expose the metrics poller handle (null when skipMetrics). */
  get metricsPoller(): { stop(): void } | null {
    if (this.phase !== "ready") return null;
    try {
      const poller = this._container.cradle.metricsPoller;
      return poller.running ? { stop: () => poller.stop() } : null;
    } catch {
      return null;
    }
  }

  // ── TensorZero gateway ────────────────────────────────────────────────

  /** TensorZero manager, or null if not enabled. */
  get tensorZero(): TensorZeroManager | null {
    if (this.phase !== "ready") return null;
    try {
      return this._container.cradle.tensorZeroLauncher.instance;
    } catch {
      return null;
    }
  }

  /** URL for the TensorZero gateway, or null if not enabled. */
  get tensorZeroUrl(): string | null {
    return this.tensorZero?.url ?? process.env.ARK_TENSORZERO_URL ?? null;
  }

  // ── Session launcher ──────────────────────────────────────────────────

  /** The session launcher (defaults to TmuxLauncher for local compute). */
  get launcher(): SessionLauncher {
    return this._launcher;
  }

  /** Replace the session launcher (e.g. for remote compute or testing). */
  setLauncher(launcher: SessionLauncher): void {
    this._launcher = launcher;
  }

  // ── Worker registry / scheduler / tenant policy (container-resolved) ─

  /** Worker registry for hosted multi-tenant deployment. Throws until set. */
  get workerRegistry(): WorkerRegistry {
    if (!this._hostedServices.workerRegistry) {
      throw new Error("Worker registry not initialized (hosted mode only)");
    }
    return this._hostedServices.workerRegistry;
  }

  setWorkerRegistry(r: WorkerRegistry): void {
    this._hostedServices.workerRegistry = r;
    this._container.register({ workerRegistry: asValue(r) });
  }

  /** Session scheduler for hosted multi-tenant deployment. Throws until set. */
  get scheduler(): SessionScheduler {
    if (!this._hostedServices.scheduler) {
      throw new Error("Scheduler not initialized (hosted mode only)");
    }
    return this._hostedServices.scheduler;
  }

  setScheduler(s: SessionScheduler): void {
    this._hostedServices.scheduler = s;
    this._container.register({ sessionScheduler: asValue(s) });
  }

  /** Tenant policy manager. Null until `setTenantPolicyManager` is called. */
  get tenantPolicyManager(): TenantPolicyManager | null {
    return this._hostedServices.tenantPolicyManager ?? null;
  }

  setTenantPolicyManager(pm: TenantPolicyManager): void {
    this._hostedServices.tenantPolicyManager = pm;
    this._container.register({ tenantPolicyManager: asValue(pm) });
  }

  // ── Private helpers used by ServiceWiring ──────────────────────────────

  /** Called by ServiceWiring.start to flip the eventBus accessor live. */
  _markEventBusReady(): void {
    this._eventBusReady = true;
  }

  /** Called by ServiceWiring.stop to revert the eventBus accessor. */
  _markEventBusStopped(): void {
    this._eventBusReady = false;
  }

  /** Resolve from container with a user-friendly error if not booted yet. */
  private _resolve<K extends keyof import("./container.js").Cradle>(key: K): import("./container.js").Cradle[K] {
    try {
      return this._container.resolve(key);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`AppContext not booted -- ${key} not available (${reason})`);
    }
  }

  // ── Tenant scoping ─────────────────────────────────────────────────────

  /**
   * Create a tenant-scoped view of this AppContext.
   * Returns a shallow copy with all repositories scoped to the given tenant.
   * Shares the same DB, container, providers, and infrastructure.
   */
  forTenant(tenantId: string): AppContext {
    return buildTenantScope(this, tenantId);
  }

  // ── Container access ───────────────────────────────────────────────────

  /** Expose the DI container for advanced use (e.g. registering test doubles). */
  get container(): AppContainer {
    return this._container;
  }

  // ── Provider / Compute / Runtime / Pool registries ─────────────────────

  registerProvider(provider: ComputeProvider): void {
    this._registries.registerProvider(provider);
  }
  getProvider(name: string): ComputeProvider | null {
    return this._registries.getProvider(name);
  }
  listProviders(): string[] {
    return this._registries.listProviders();
  }

  registerCompute(c: NewCompute): void {
    this._registries.registerCompute(c);
  }
  registerRuntime(r: NewRuntime): void {
    this._registries.registerRuntime(r);
  }
  getCompute(kind: ComputeKind): NewCompute | null {
    return this._registries.getCompute(kind);
  }
  getRuntime(kind: RuntimeKind): NewRuntime | null {
    return this._registries.getRuntime(kind);
  }
  listComputes(): ComputeKind[] {
    return this._registries.listComputes();
  }
  listRuntimes(): RuntimeKind[] {
    return this._registries.listRuntimes();
  }

  registerComputePool(pool: ComputePool): void {
    this._registries.registerPool(pool);
  }
  deregisterComputePool(kind: ComputeKind): void {
    this._registries.deregisterPool(kind);
  }
  getComputePool(kind: ComputeKind): ComputePool | null {
    return this._registries.getPool(kind);
  }
  listComputePools(): ComputeKind[] {
    return this._registries.listPools();
  }

  /** Resolve the compute provider for a session. Delegated to compute-resolver.ts. */
  resolveProvider(session: Session): { provider: ComputeProvider | null; compute: Compute | null } {
    return resolveProvider(this, session);
  }

  /** Resolve the ComputeTarget for a session. Delegated to compute-resolver.ts. */
  resolveComputeTarget(
    session: Session,
  ): Promise<{ target: import("../compute/core/compute-target.js").ComputeTarget | null; compute: Compute | null }> {
    return resolveComputeTarget(this, session);
  }

  // ── Factory ────────────────────────────────────────────────────────────

  /** Synchronous test AppContext -- uses well-known ports (serial tests only). */
  static forTest(overrides?: Partial<ArkConfig>): AppContext {
    const tempDir = mkdtempSync(join(tmpdir(), "ark-test-"));
    const config = loadConfig({ arkDir: tempDir, env: "test", ...overrides });
    const app = new AppContext(config, TEST_OPTIONS);
    app.setLauncher(new NoopLauncher());
    return app;
  }

  /** Parallel-safe test AppContext -- allocates unique ports + arkDir per call. */
  static async forTestAsync(overrides?: Partial<ArkConfig>): Promise<AppContext> {
    const config = await loadAppConfig({ profile: "test", ...overrides });
    const app = new AppContext(config, TEST_OPTIONS);
    app.setLauncher(new NoopLauncher());
    return app;
  }
}

// Shared test boot options used by both forTest factories.
const TEST_OPTIONS: AppOptions = {
  skipConductor: true,
  skipMetrics: true,
  skipSignals: true,
  cleanupOnShutdown: true,
};

// The module-level `getApp/setApp/clearApp` service locator has been
// removed. All callers must now receive AppContext through constructor
// injection or an explicit parameter (preferred). The CLI entry point
// holds the lone process-wide AppContext and threads it through its
// command handlers.
