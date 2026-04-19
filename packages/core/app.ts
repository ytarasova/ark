/**
 * AppContext -- central owner of all services and their lifecycle.
 *
 * Replaces scattered singletons with explicit boot/shutdown. Every service
 * (database, event bus, conductor, metrics) is created during boot() and
 * torn down in reverse order during shutdown().
 */

import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, existsSync, mkdtempSync, readFileSync } from "fs";
import type { IDatabase } from "./database/index.js";
import { BunSqliteAdapter } from "./database/index.js";
import { join } from "path";
import { tmpdir } from "os";
import { resolveStoreBaseDir } from "./install-paths.js";

import { asValue } from "awilix";
import { createAppContainer, type AppContainer } from "./container.js";
import { loadConfig, loadAppConfig, type ArkConfig } from "./config.js";
import { configureOtlp } from "./observability/otlp.js";
import { safeAsync } from "./safe.js";
import { eventBus } from "./hooks.js";
import type { ComputeProvider } from "../compute/types.js";
import type { Compute as NewCompute, Runtime as NewRuntime, ComputeKind, RuntimeKind } from "../compute/core/types.js";
import { safeParseConfig } from "./util.js";
import { initSchema as initRepoSchema, seedLocalCompute } from "./repositories/schema.js";
import type { Compute, Session, ComputeProviderName } from "../types/index.js";
import { setProviderResolver, clearProviderResolver } from "./provider-registry.js";
import { updateTmuxStatusBar, clearTmuxStatusBar } from "./infra/tmux-notify.js";
import { startNotifyDaemon } from "./infra/notify-daemon.js";
import { track, configureTelemetry } from "./observability/telemetry.js";
import { logError, logWarn, setLogArkDir } from "./observability/structured-log.js";
import { setProfilesArkDir } from "./state/profiles.js";
import { registerExecutor } from "./executor.js";
import { builtinExecutors, loadPluginExecutors } from "./executors/index.js";
import {
  SessionRepository,
  ComputeRepository,
  ComputeTemplateRepository,
  EventRepository,
  MessageRepository,
  TodoRepository,
  ArtifactRepository,
} from "./repositories/index.js";
import { SessionService, ComputeService, HistoryService } from "./services/index.js";
import { FileFlowStore, FileSkillStore, FileAgentStore, FileRecipeStore, FileRuntimeStore } from "./stores/index.js";
import { TranscriptParserRegistry } from "./runtimes/transcript-parser.js";
import { createPluginRegistry, type PluginRegistry } from "./plugins/registry.js";
import { ClaudeTranscriptParser } from "./runtimes/claude/parser.js";
import { CodexTranscriptParser } from "./runtimes/codex/parser.js";
import { GeminiTranscriptParser } from "./runtimes/gemini/parser.js";
import { DbResourceStore, initResourceDefinitionsTable } from "./stores/db-resource-store.js";
import type { FlowStore, SkillStore, AgentStore, RecipeStore, RuntimeStore } from "./stores/index.js";
import type { SessionLauncher } from "./session-launcher.js";
import { TmuxLauncher } from "./launchers/tmux.js";
import { ApiKeyManager } from "./auth/index.js";
import type { WorkerRegistry } from "./hosted/worker-registry.js";
import type { SessionScheduler } from "./hosted/scheduler.js";
import type { TenantPolicyManager } from "./auth/index.js";
import { KnowledgeStore } from "./knowledge/store.js";
import { PricingRegistry } from "./observability/pricing.js";
import { UsageRecorder } from "./observability/usage.js";
import type { TensorZeroManager } from "./router/tensorzero.js";

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

  // Wave 1 Compute + Runtime registries. Live alongside `_providers`; Wave 3
  // retires the old registry once every dispatch path reads from these.
  private _computes = new Map<ComputeKind, NewCompute>();
  private _runtimes = new Map<RuntimeKind, NewRuntime>();

  private _launcher: SessionLauncher = new TmuxLauncher();
  private _workerRegistry: WorkerRegistry | null = null;
  private _scheduler: SessionScheduler | null = null;
  private _tenantPolicyManager: TenantPolicyManager | null = null;

  conductor: { stop(): void } | null = null;
  arkd: { stop(): void } | null = null;
  metricsPoller: { stop(): void } | null = null;
  /** Rollback config stored here so conductor can access it without globalThis. */
  rollbackConfig: import("./config.js").RollbackSettings | null = null;

  private _tensorZero: TensorZeroManager | null = null;
  private _router: any = null;

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
  get arkDir(): string {
    return this.config.arkDir;
  }

  get db(): IDatabase {
    return this._resolve("db");
  }

  get eventBus(): typeof eventBus {
    if (!this._eventBus) throw new Error("AppContext not booted -- eventBus not available");
    return this._eventBus;
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

  private _apiKeys: ApiKeyManager | null = null;

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

  // ── Plugin registry (executors, compute providers, transcript parsers) ──

  get pluginRegistry(): PluginRegistry {
    return this._resolve("pluginRegistry");
  }

  // ── TensorZero gateway ────────────────────────────────────────────────

  /** TensorZero manager, or null if not enabled. */
  get tensorZero(): TensorZeroManager | null {
    return this._tensorZero;
  }

  /** URL for the TensorZero gateway, or null if not enabled. */
  get tensorZeroUrl(): string | null {
    if (this._tensorZero) return this._tensorZero.url;
    return process.env.ARK_TENSORZERO_URL ?? null;
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

  // ── Worker registry (hosted mode only) ─────────────────────────────────

  /** Worker registry for hosted multi-tenant deployment. Throws if not initialized. */
  get workerRegistry(): WorkerRegistry {
    if (!this._workerRegistry) throw new Error("Worker registry not initialized (hosted mode only)");
    return this._workerRegistry;
  }

  /** Set the worker registry (called by hosted entry point). */
  setWorkerRegistry(r: WorkerRegistry): void {
    this._workerRegistry = r;
  }

  // ── Session scheduler (hosted mode only) ───────────────────────────────

  /** Session scheduler for hosted multi-tenant deployment. Throws if not initialized. */
  get scheduler(): SessionScheduler {
    if (!this._scheduler) throw new Error("Scheduler not initialized (hosted mode only)");
    return this._scheduler;
  }

  /** Set the session scheduler (called by hosted entry point). */
  setScheduler(s: SessionScheduler): void {
    this._scheduler = s;
  }

  // ── Tenant policy manager (hosted mode only) ──────────────────────────

  /** Tenant policy manager for hosted multi-tenant deployment. Null if not initialized. */
  get tenantPolicyManager(): TenantPolicyManager | null {
    return this._tenantPolicyManager;
  }

  /** Set the tenant policy manager (called by hosted entry point). */
  setTenantPolicyManager(pm: TenantPolicyManager): void {
    this._tenantPolicyManager = pm;
  }

  /** Resolve from container with a user-friendly error if not booted yet. */
  private _resolve<K extends keyof import("./container.js").Cradle>(key: K): import("./container.js").Cradle[K] {
    try {
      return this._container.resolve(key);
    } catch {
      throw new Error(`AppContext not booted -- ${key} not available`);
    }
  }

  // ── Tenant scoping ─────────────────────────────────────────────────────

  /**
   * Create a tenant-scoped view of this AppContext.
   * Returns a shallow copy with all repositories scoped to the given tenant.
   * Shares the same DB, container, providers, and infrastructure.
   */
  forTenant(tenantId: string): AppContext {
    const scoped = Object.create(this) as AppContext;
    // Override repository accessors to return tenant-scoped instances.
    // We create new repo instances that share the same DB but are scoped to the tenant.
    const db = this.db;
    const scopedSessions = new SessionRepository(db);
    scopedSessions.setTenant(tenantId);
    const scopedComputes = new ComputeRepository(db);
    scopedComputes.setTenant(tenantId);
    const scopedEvents = new EventRepository(db);
    scopedEvents.setTenant(tenantId);
    const scopedMessages = new MessageRepository(db);
    scopedMessages.setTenant(tenantId);
    const scopedTodos = new TodoRepository(db);
    scopedTodos.setTenant(tenantId);

    const scopedArtifacts = new ArtifactRepository(db);
    scopedArtifacts.setTenant(tenantId);
    const scopedKnowledge = new KnowledgeStore(db);
    scopedKnowledge.setTenant(tenantId);

    const scopedComputeTemplates = new ComputeTemplateRepository(db);
    scopedComputeTemplates.setTenant(tenantId);

    // UsageRecorder with tenant default
    const scopedUsage = new UsageRecorder(db, this.pricing);
    scopedUsage.setTenant(tenantId);

    Object.defineProperty(scoped, "sessions", { get: () => scopedSessions, configurable: true });
    Object.defineProperty(scoped, "computes", { get: () => scopedComputes, configurable: true });
    Object.defineProperty(scoped, "computeTemplates", { get: () => scopedComputeTemplates, configurable: true });
    Object.defineProperty(scoped, "events", { get: () => scopedEvents, configurable: true });
    Object.defineProperty(scoped, "messages", { get: () => scopedMessages, configurable: true });
    Object.defineProperty(scoped, "todos", { get: () => scopedTodos, configurable: true });
    Object.defineProperty(scoped, "artifacts", { get: () => scopedArtifacts, configurable: true });
    Object.defineProperty(scoped, "knowledge", { get: () => scopedKnowledge, configurable: true });
    Object.defineProperty(scoped, "usageRecorder", { get: () => scopedUsage, configurable: true });

    // Scope DB-backed resource stores (hosted mode only)
    if (this.config.databaseUrl) {
      const scopedAgents = new DbResourceStore(db, "agent", {
        description: "",
        model: "sonnet",
        max_turns: 200,
        system_prompt: "",
        tools: [],
        mcp_servers: [],
        skills: [],
        memories: [],
        context: [],
        permission_mode: "bypassPermissions",
        env: {},
      });
      scopedAgents.setTenant(tenantId);
      const scopedFlows = new DbResourceStore(db, "flow", { stages: [] });
      scopedFlows.setTenant(tenantId);
      const scopedSkills = new DbResourceStore(db, "skill", { description: "", content: "" });
      scopedSkills.setTenant(tenantId);
      const scopedRecipes = new DbResourceStore(db, "recipe", { description: "", flow: "default" });
      scopedRecipes.setTenant(tenantId);
      const scopedRuntimes = new DbResourceStore(db, "runtime", { description: "", type: "cli-agent", command: [] });
      scopedRuntimes.setTenant(tenantId);

      Object.defineProperty(scoped, "agents", { get: () => scopedAgents, configurable: true });
      Object.defineProperty(scoped, "flows", { get: () => scopedFlows, configurable: true });
      Object.defineProperty(scoped, "skills", { get: () => scopedSkills, configurable: true });
      Object.defineProperty(scoped, "recipes", { get: () => scopedRecipes, configurable: true });
      Object.defineProperty(scoped, "runtimes", { get: () => scopedRuntimes, configurable: true });
    }

    return scoped;
  }

  // ── Container access ───────────────────────────────────────────────────

  /** Expose the DI container for advanced use (e.g. registering test doubles). */
  get container(): AppContainer {
    return this._container;
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

  // ── Compute / Runtime registry (Wave 1) ───────────────────────────────
  //
  // Wave 1 lands the interfaces and a single `LocalCompute` + `DirectRuntime`
  // pair. Wave 2 migrates the remaining providers. Wave 3 retires
  // `registerProvider` / `getProvider` above and wires dispatch through
  // these registries instead.

  registerCompute(c: NewCompute): void {
    c.setApp?.(this);
    this._computes.set(c.kind, c);
  }

  registerRuntime(r: NewRuntime): void {
    r.setApp?.(this);
    this._runtimes.set(r.kind, r);
  }

  getCompute(kind: ComputeKind): NewCompute | null {
    return this._computes.get(kind) ?? null;
  }

  getRuntime(kind: RuntimeKind): NewRuntime | null {
    return this._runtimes.get(kind) ?? null;
  }

  listComputes(): ComputeKind[] {
    return [...this._computes.keys()];
  }

  listRuntimes(): RuntimeKind[] {
    return [...this._runtimes.keys()];
  }

  /** Resolve the compute provider for a session. Defaults to local. */
  resolveProvider(session: Session): { provider: ComputeProvider | null; compute: Compute | null } {
    const computeName = session.compute_name || "local";
    // Query compute directly via the app DB to avoid circular imports
    const row = this.db?.prepare("SELECT * FROM compute WHERE name = ?").get(computeName) as
      | { name: string; provider: string; status: string; config: string; created_at: string; updated_at: string }
      | undefined;
    if (!row) return { provider: null, compute: null };
    const compute = { ...row, config: safeParseConfig(row.config) } as unknown as Compute;
    const provider = this.getProvider(compute.provider);
    return { provider: provider ?? null, compute };
  }

  /**
   * Wave 3: resolve the ComputeTarget for a session.
   *
   * Reads `compute_kind` + `runtime_kind` from the compute row. For legacy
   * rows that pre-date the schema change, falls back to `providerToPair`
   * so dispatch still works.
   *
   * Returns null if the (compute, runtime) pair is not registered. Callers
   * should fall back to the legacy `ComputeProvider` path in that case.
   */
  async resolveComputeTarget(
    session: Session,
  ): Promise<{ target: import("../compute/core/compute-target.js").ComputeTarget | null; compute: Compute | null }> {
    const { compute } = this.resolveProvider(session);
    if (!compute) return { target: null, compute: null };

    // Prefer explicit columns; fall back to provider-map for legacy rows.
    const { providerToPair } = await import("../compute/adapters/provider-map.js");
    const fallback = providerToPair(compute.provider);
    const computeKind = ((compute as any).compute_kind ?? fallback.compute) as ComputeKind;
    const runtimeKind = ((compute as any).runtime_kind ?? fallback.runtime) as RuntimeKind;

    const c = this.getCompute(computeKind);
    const r = this.getRuntime(runtimeKind);
    if (!c || !r) return { target: null, compute };

    const { ComputeTarget } = await import("../compute/core/compute-target.js");
    return { target: new ComputeTarget(c, r), compute };
  }

  // ── Boot ───────────────────────────────────────────────────────────────

  async boot(): Promise<void> {
    if (this.phase !== "created") {
      throw new Error(`Cannot boot AppContext in phase "${this.phase}"`);
    }
    this.phase = "booting";

    // Auto-register as global singleton (used by flow.ts loadFlow fallback)
    if (!_app) _app = this;

    this._initFilesystem();
    const db = await this._openDatabase();
    await this._initSchema(db);
    this._seedComputeTemplates(db);
    this._apiKeys = new ApiKeyManager(db);
    this._registerContainer(db);
    await this._registerComputeProviders();
    this._wireServices();
    await this._startOptionalServices();
    this._startMaintenance();
    await this._detectStaleState();

    track("app_boot");
    this.phase = "ready";
  }

  // ── Boot helpers (split out from the original 308-line boot()) ────────────

  /** Step 1: ensure ark directories exist and configure module-level paths. */
  private _initFilesystem(): void {
    for (const dir of [this.config.arkDir, this.config.tracksDir, this.config.worktreesDir, this.config.logDir]) {
      mkdirSync(dir, { recursive: true });
    }
    setLogArkDir(this.config.arkDir);
    setProfilesArkDir(this.config.arkDir);
  }

  /** Step 2: open the underlying SQLite or Postgres database. */
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

  /** Step 3: initialize schema for the chosen DB engine and seed local compute. */
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

  /** Step 3a: copy compute templates from config.yaml into the DB on first boot. */
  private _seedComputeTemplates(db: IDatabase): void {
    if (!this.config.computeTemplates?.length) return;
    const tmplRepo = new ComputeTemplateRepository(db);
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

  /** Step 3b: register all repositories, services, stores, and registries in the DI container. */
  private _registerContainer(db: IDatabase): void {
    const storeBaseDir = resolveStoreBaseDir();
    const pricingRegistry = new PricingRegistry();

    // Construct repositories eagerly so we can register them as values.
    // asClass(...) used to work here, but `bun build --compile` minifies
    // constructor parameter names which breaks awilix's name-based DI
    // resolution -- the compiled binary fails with
    // "AppContext not booted -- sessionService not available" because
    // SessionService(constructor(a, b, c)) can't be matched against the
    // cradle. Constructing eagerly side-steps that entirely.
    const sessions = new SessionRepository(db);
    // Push channel port bounds from config into the repo so its
    // channelPort(id) respects the active profile (test profile
    // randomizes the base port to avoid cross-worker collisions).
    sessions.setChannelBounds(this.config.channels.basePort, this.config.channels.range);
    const computes = new ComputeRepository(db);
    const computeTemplates = new ComputeTemplateRepository(db);
    const events = new EventRepository(db);
    const messages = new MessageRepository(db);
    const todos = new TodoRepository(db);
    const artifacts = new ArtifactRepository(db);
    const sessionService = new SessionService(sessions, events, messages, this);
    const computeService = new ComputeService(computes);
    const historyService = new HistoryService(db);

    this._container.register({
      db: asValue(db),

      // Repositories
      sessions: asValue(sessions),
      computes: asValue(computes),
      computeTemplates: asValue(computeTemplates),
      events: asValue(events),
      messages: asValue(messages),
      todos: asValue(todos),
      artifacts: asValue(artifacts),

      // Services
      sessionService: asValue(sessionService),
      computeService: asValue(computeService),
      historyService: asValue(historyService),

      // Resource stores: file-backed for local mode, DB-backed for hosted/control plane
      ...this.createResourceStores(db, storeBaseDir),

      // Knowledge graph
      knowledge: asValue(new KnowledgeStore(db)),

      // Cost tracking
      pricing: asValue(pricingRegistry),
      usageRecorder: asValue(new UsageRecorder(db, pricingRegistry)),

      // Runtime transcript parsers (polymorphic, one per agent tool)
      transcriptParsers: asValue(this.createTranscriptParserRegistry()),

      // Plugin registry -- canonical source for extensible collections
      // (executors today; compute providers, runtimes, transcript parsers in Phase 2)
      pluginRegistry: asValue(createPluginRegistry()),
    });

    // Non-blocking remote price refresh
    pricingRegistry.refreshFromRemote().catch(() => {});
  }

  /** Step 4: register every compute provider available in the current install. */
  private async _registerComputeProviders(): Promise<void> {
    await safeAsync("boot: load compute providers", async () => {
      const compute = await import("../compute/index.js");
      compute.setComputeApp(this);
      // Docker is the arkd-sidecar LocalDockerProvider (arkd runs INSIDE the
      // container on a loopback-mapped port). The legacy "host tmux + docker
      // exec" DockerProvider class stays exported for compatibility but is
      // no longer registered.
      const providers = [
        new compute.LocalProvider(),
        new compute.LocalDockerProvider(),
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

      // Optional providers (skip if their SDK isn't installed)
      try {
        const { E2BProvider } = await import("../compute/providers/e2b.js");
        const e2b = new E2BProvider();
        e2b.setApp(this);
        this.registerProvider(e2b);
      } catch {
        /* e2b SDK not installed */
      }

      try {
        const { K8sProvider, KataProvider } = await import("../compute/providers/k8s.js");
        const k8s = new K8sProvider();
        k8s.setApp(this);
        this.registerProvider(k8s);
        const kata = new KataProvider();
        kata.setApp(this);
        this.registerProvider(kata);
      } catch {
        /* @kubernetes/client-node not installed */
      }

      // Wave 2 Compute registrations for Kubernetes. Gated the same way as
      // the legacy K8sProvider above -- if `@kubernetes/client-node` isn't
      // installed, skip silently and leave the registry without a `k8s` /
      // `k8s-kata` kind.
      try {
        await import("@kubernetes/client-node");
        const { K8sCompute } = await import("../compute/core/k8s.js");
        const { KataCompute } = await import("../compute/core/k8s-kata.js");
        this.registerCompute(new K8sCompute());
        this.registerCompute(new KataCompute());
      } catch {
        /* @kubernetes/client-node not installed */
      }

      // Wave 1/2 Compute + Runtime registry. Additive -- the legacy provider
      // registry above still runs every dispatch path. Wave 3 flips dispatch
      // to consume these.
      const { LocalCompute } = await import("../compute/core/local.js");
      const { EC2Compute } = await import("../compute/core/ec2.js");
      const { DirectRuntime } = await import("../compute/runtimes/direct.js");
      const { DockerRuntime } = await import("../compute/runtimes/docker.js");
      const { DevcontainerRuntime } = await import("../compute/runtimes/devcontainer.js");
      const { DockerComposeRuntime } = await import("../compute/runtimes/docker-compose.js");
      this.registerCompute(new LocalCompute());
      this.registerCompute(new EC2Compute());
      this.registerRuntime(new DirectRuntime());
      this.registerRuntime(new DockerRuntime());
      this.registerRuntime(new DevcontainerRuntime());
      this.registerRuntime(new DockerComposeRuntime());

      // Phase 2: FirecrackerCompute. Gated on the availability probe so we
      // don't register on macOS (no /dev/kvm). `registerFirecrackerIfAvailable`
      // logs at info level when the gating fires so the skip is observable.
      const { registerFirecrackerIfAvailable } = await import("../compute/core/firecracker/compute.js");
      registerFirecrackerIfAvailable(this);
    });
  }

  /** Step 5: wire services and the global event bus. */
  private _wireServices(): void {
    this.sessionService.setApp(this);
    setProviderResolver((session: Session) => this.resolveProvider(session));

    // Built-in executors -- register into the PluginRegistry (authoritative)
    // and the module-level legacy map (for call sites without an AppContext,
    // e.g. older tests). Both see the same instances.
    const pluginRegistry = this.pluginRegistry;
    for (const ex of builtinExecutors) {
      pluginRegistry.register({ kind: "executor", name: ex.name, impl: ex, source: "builtin" });
      registerExecutor(ex);
    }

    // fire-and-forget: plugin loading is best-effort, never blocks boot
    loadPluginExecutors(this.config.arkDir, (msg) => logWarn("plugins", msg))
      .then((plugins) => {
        for (const ex of plugins) {
          pluginRegistry.register({ kind: "executor", name: ex.name, impl: ex, source: "user" });
          registerExecutor(ex);
        }
      })
      .catch((e: any) => logWarn("plugins", `loadPluginExecutors failed: ${e?.message ?? e}`));

    this._eventBus = eventBus;
    this._eventBus.clear();

    configureOtlp(this.config.otlp);
    this.rollbackConfig = this.config.rollback;
    configureTelemetry(this.config.telemetry);
  }

  /** Step 6: optionally start TensorZero, the LLM router, and the conductor. */
  private async _startOptionalServices(): Promise<void> {
    if (this.config.tensorZero?.enabled && !this.options.skipConductor) {
      await safeAsync("boot: start TensorZero", async () => {
        const { TensorZeroManager } = await import("./router/tensorzero.js");
        this._tensorZero = new TensorZeroManager({
          port: this.config.tensorZero!.port,
          configDir: this.config.tensorZero!.configDir,
          anthropicKey: process.env.ANTHROPIC_API_KEY,
          openaiKey: process.env.OPENAI_API_KEY,
          geminiKey: process.env.GEMINI_API_KEY,
        });
        if (this.config.tensorZero!.autoStart) {
          await this._tensorZero.start();
        }
      });
    }

    if (this.config.router?.enabled && this.config.router.autoStart && !this.options.skipConductor) {
      await safeAsync("boot: start router", async () => {
        const { loadRouterConfig, startRouter } = await import("../router/index.js");
        const routerConfig = loadRouterConfig({
          port: parseInt(this.config.router!.url.split(":").pop() ?? "8430", 10),
          policy: this.config.router!.policy,
        });
        if (routerConfig.providers.length > 0) {
          const tensorZeroUrl = this._tensorZero?.url;
          this._router = startRouter(routerConfig, {
            tensorZeroUrl,
            onUsage: (event) => {
              this.usageRecorder.record({
                sessionId: "router",
                model: event.model,
                provider: event.provider,
                usage: { input_tokens: event.input_tokens, output_tokens: event.output_tokens },
              });
            },
          });
        }
      });
    }

    if (!this.options.skipConductor) {
      await safeAsync("boot: start conductor", async () => {
        const { startConductor } = await import("./conductor/conductor.js");
        this.conductor = startConductor(this, this.config.conductorPort, { quiet: true });
      });

      // Start arkd (local agent proxy) alongside the conductor.
      // Agents post reports to arkd, which forwards to the conductor.
      await safeAsync("boot: start arkd", async () => {
        const { startArkd } = await import("../arkd/server.js");
        const conductorUrl = `http://localhost:${this.config.conductorPort}`;
        this.arkd = startArkd(this.config.arkdPort ?? 19300, { conductorUrl, quiet: true });
      });
    }
  }

  /** Step 7: start polling/maintenance loops and signal handlers. */
  private _startMaintenance(): void {
    if (!this.options.skipMetrics) {
      this.metricsPoller = this._startMetricsPoller();
    }
    if (!this.options.skipSignals) {
      this._registerSignalHandlers();
    }

    // Purge expired soft-deletes every 30s
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
      } catch {
        /* container may be disposed during shutdown */
      }
    }, 30_000);

    // tmux status bar every 5s
    this._tmuxStatusInterval = setInterval(() => {
      updateTmuxStatusBar(this);
    }, 5_000);

    this._notifyDaemon = startNotifyDaemon(this);

    // Log cleanup is fire-and-forget
    safeAsync("boot: cleanup logs", async () => {
      const { cleanupLogs } = await import("./observability/log-manager.js");
      cleanupLogs(this);
    });
  }

  /** Step 8: detect orphaned/stale sessions and stale .claude/settings.local.json. */
  private async _detectStaleState(): Promise<void> {
    await safeAsync("boot: detect orphaned sessions", async () => {
      const { findOrphanedSessions } = await import("./session/checkpoint.js");
      const orphaned = findOrphanedSessions(this);
      if (orphaned.length > 0) {
        this._orphanedSessions = orphaned;
        for (const s of orphaned) {
          logWarn("session", `Orphaned session detected: ${s.id} (status: ${s.status}, stage: ${s.stage})`);
        }
      }
    });

    await safeAsync("boot: cleanup stale hooks", async () => {
      const cwd = process.cwd();
      const settingsPath = join(cwd, ".claude", "settings.local.json");
      if (!existsSync(settingsPath)) return;
      try {
        const content = JSON.parse(readFileSync(settingsPath, "utf-8"));
        const cmd = content?.hooks?.Stop?.[0]?.hooks?.[0]?.command ?? "";
        if (!cmd.includes("ark-status")) return;
        const match = cmd.match(/session=([^'&\s]+)/);
        const sid = match?.[1];
        if (!sid) return;
        const session = this.sessions.get(sid);
        if (!session || !["running", "waiting"].includes(session.status)) {
          logWarn(
            "session",
            `Removing stale settings for ${sid} from ${cwd} (status: ${session?.status ?? "not found"})`,
          );
          const { removeSettings } = await import("./claude/claude.js");
          removeSettings(cwd);
        }
      } catch {
        /* settings.local.json may be malformed; safe to skip */
      }
    });

    await safeAsync("boot: cleanup stale mcp config", async () => {
      const cwd = process.cwd();
      const mcpPath = join(cwd, ".mcp.json");
      if (!existsSync(mcpPath)) return;
      try {
        const content = JSON.parse(readFileSync(mcpPath, "utf-8"));
        const channelEnv = content?.mcpServers?.["ark-channel"]?.env;
        if (!channelEnv?.ARK_SESSION_ID) return;
        const sid = channelEnv.ARK_SESSION_ID;
        const session = this.sessions.get(sid);
        if (!session || !["running", "waiting"].includes(session.status)) {
          const { removeChannelConfig } = await import("./claude/claude.js");
          removeChannelConfig(cwd);
        }
      } catch {
        /* .mcp.json may be malformed; safe to skip */
      }
    });

    await safeAsync("boot: detect stale sessions", async () => {
      const { sessionExistsAsync } = await import("./infra/tmux.js");
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

    try {
      const { stopAllPollers } = await import("./executors/status-poller.js");
      stopAllPollers();
    } catch {
      /* poller module may not be loaded */
    }

    if (this._notifyDaemon) {
      this._notifyDaemon.stop();
      this._notifyDaemon = null;
    }
    if (this._tmuxStatusInterval) {
      clearInterval(this._tmuxStatusInterval);
      this._tmuxStatusInterval = null;
    }
    clearTmuxStatusBar();
    if (this._purgeInterval) {
      clearInterval(this._purgeInterval);
      this._purgeInterval = null;
    }
    if (this.metricsPoller) {
      this.metricsPoller.stop();
      this.metricsPoller = null;
    }
    if (this._router) {
      this._router.stop();
      this._router = null;
    }
    if (this._tensorZero) {
      await this._tensorZero.stop().catch(() => {});
      this._tensorZero = null;
    }
    if (this.arkd) {
      this.arkd.stop();
      this.arkd = null;
    }
    if (this.conductor) {
      this.conductor.stop();
      this.conductor = null;
    }
    if (this._eventBus) {
      this._eventBus.clear();
      this._eventBus = null;
    }

    // Step 2: flush observability
    try {
      const { flush: flushTelemetry } = await import("./telemetry.js");
      const { flushSpans, resetOtlp } = await import("./otlp.js");
      await flushTelemetry();
      await flushSpans();
      resetOtlp();
    } catch {
      /* telemetry flush is best-effort */
    }

    // Step 3: tear down compute + DI container (reverse of boot steps 3-5)
    clearProviderResolver();
    try {
      this._container.resolve("db").close();
    } catch {
      /* db may already be closed */
    }
    await this._container.dispose();

    // Step 4: clean up temp directory (test mode)
    if (this.options.cleanupOnShutdown && existsSync(this.config.arkDir)) {
      rmSync(this.config.arkDir, { recursive: true, force: true });
    }

    // Clear global singleton if this instance is the current one
    if (_app === this) _app = null;

    this.phase = "stopped";
  }

  // ── Resource Store Factory ─────────────────────────────────────────────

  /**
   * Build the TranscriptParserRegistry with all known runtime parsers.
   * To add a new runtime, create a parser class under packages/core/runtimes/<name>/parser.ts
   * and register it here.
   */
  private createTranscriptParserRegistry(): TranscriptParserRegistry {
    const registry = new TranscriptParserRegistry();
    // Claude parser uses session.claude_session_id (set at launch via --session-id)
    // to construct the exact transcript path. The sessionIdLookup bridges workdir
    // back to that stored ID by querying the session repo.
    registry.register(
      new ClaudeTranscriptParser(undefined, (workdir) => {
        try {
          const sessions = this.sessions.list({ limit: 50 });
          const match = sessions.find((s) => s.workdir === workdir && s.claude_session_id);
          return match?.claude_session_id ?? null;
        } catch {
          return null;
        }
      }),
    );
    registry.register(new CodexTranscriptParser());
    registry.register(new GeminiTranscriptParser());
    return registry;
  }

  private createResourceStores(db: IDatabase, storeBaseDir: string): Record<string, any> {
    const isHosted = !!this.config.databaseUrl;

    if (isHosted) {
      // Control plane: DB-backed stores with tenant scoping
      initResourceDefinitionsTable(db);
      return {
        flows: asValue(new DbResourceStore(db, "flow", { stages: [] })),
        skills: asValue(new DbResourceStore(db, "skill", { description: "", content: "" })),
        agents: asValue(
          new DbResourceStore(db, "agent", {
            description: "",
            model: "sonnet",
            max_turns: 200,
            system_prompt: "",
            tools: [],
            mcp_servers: [],
            skills: [],
            memories: [],
            context: [],
            permission_mode: "bypassPermissions",
            env: {},
          }),
        ),
        recipes: asValue(new DbResourceStore(db, "recipe", { description: "", flow: "default" })),
        runtimes: asValue(new DbResourceStore(db, "runtime", { description: "", type: "cli-agent", command: [] })),
      };
    }

    // Local mode: file-backed stores with three-tier resolution
    return {
      flows: asValue(
        new FileFlowStore({
          builtinDir: join(storeBaseDir, "flows", "definitions"),
          userDir: join(this.config.arkDir, "flows"),
        }),
      ),
      skills: asValue(
        new FileSkillStore({
          builtinDir: join(storeBaseDir, "skills"),
          userDir: join(this.config.arkDir, "skills"),
        }),
      ),
      agents: asValue(
        new FileAgentStore({
          builtinDir: join(storeBaseDir, "agents"),
          userDir: join(this.config.arkDir, "agents"),
        }),
      ),
      recipes: asValue(
        new FileRecipeStore({
          builtinDir: join(storeBaseDir, "recipes"),
          userDir: join(this.config.arkDir, "recipes"),
        }),
      ),
      runtimes: asValue(
        new FileRuntimeStore({
          builtinDir: join(storeBaseDir, "runtimes"),
          userDir: join(this.config.arkDir, "runtimes"),
        }),
      ),
    };
  }

  // ── Metrics Poller ─────────────────────────────────────────────────────

  private _startMetricsPoller(): { stop(): void } {
    const handle = setInterval(async () => {
      await safeAsync("metrics: poll computes", async () => {
        const computes = this.computes?.list({ status: "running" }) ?? [];
        for (const c of computes) {
          await safeAsync(`metrics: poll compute "${c.name}"`, async () => {
            const compute = (await import("../compute/index.js")) as Record<string, unknown>;
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
   *
   * Uses fixed well-known ports (via the sync `loadConfig`), which is
   * fine when tests run serially (current `make test --concurrency 1`).
   * New test files that want parallel-safe ports should use
   * `forTestAsync()` instead, which routes through the test-profile
   * resolver and allocates ephemeral ports per-call.
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

  /**
   * Parallel-safe test AppContext factory.
   *
   * Routes through `loadAppConfig({ profile: "test" })`, which:
   *   - binds :0 to allocate 4 unique ports (conductor/arkd/server/web);
   *   - mkdtemp's a per-pid unique arkDir under os.tmpdir();
   *   - randomizes channels.basePort so concurrent test workers don't
   *     collide on the sessionId -> channel-port hash.
   *
   * Prefer this for any new test that boots a real server/daemon.
   */
  static async forTestAsync(overrides?: Partial<ArkConfig>): Promise<AppContext> {
    const config = await loadAppConfig({ profile: "test", ...overrides });
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
