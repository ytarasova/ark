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
import type { DatabaseAdapter } from "./database/index.js";
import { BunSqliteAdapter } from "./database/index.js";
import { buildSqliteDrizzle, buildPostgresDrizzle, type DrizzleClient } from "./drizzle/index.js";
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
import type { SessionHooks } from "./services/session-hooks/index.js";
import type { SessionLifecycle } from "./services/session/index.js";
import type { DispatchService } from "./services/dispatch/index.js";
import type { StageAdvanceService } from "./services/stage-advance/index.js";
import type { FlowStore, SkillStore, AgentStore, RecipeStore, RuntimeStore } from "./stores/index.js";
import { buildTenantScope } from "./tenant-scope.js";
import { ComputeRegistries } from "./compute-registries.js";
import { resolveProvider, resolveComputeTarget } from "./compute-resolver.js";
import type { TranscriptParserRegistry } from "./runtimes/transcript-parser.js";
import type { PluginRegistry } from "./plugins/registry.js";
import type { SessionLauncher } from "./session-launcher.js";
import { TmuxLauncher } from "./launchers/tmux.js";
import { NoopLauncher } from "./launchers/noop.js";
import type { ApiKeyManager } from "./auth/index.js";
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
  private _drizzle: DrizzleClient | null = null;
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
    // filesystem, DB open, schema migration, compute-template seeding.
    this._initFilesystem();
    const db = await this._openDatabase();
    await this._initSchema(db);
    await this._seedComputeTemplates(db);

    // Container + lifecycle. `buildContainer()` wires every repo, store,
    // service, and infra launcher; `lifecycle.start()` resolves + calls
    // `start()` on each launcher in canonical order. Awilix tracks every
    // resolution so `container.dispose()` later tears them down in reverse.
    this._container = buildContainer({ app: this, config: this.config, db, bootOptions: this.options });
    await this._container.cradle.lifecycle.start();

    // Rehydrate ephemeral inline-flow definitions persisted in session config.
    // When a child session is spawned with an inline flow object, the definition
    // is written to session.config.inline_flow AND registered in the ephemeral
    // overlay on app.flows. After a daemon restart the overlay is empty, so we
    // scan all active sessions and re-register any inline_flow definitions here.
    void this._rehydrateInlineFlows();

    // Boot-time reconciliation of for_each sessions that were mid-loop when the
    // daemon last stopped. Re-dispatches any running session whose config has a
    // for_each_checkpoint so the loop resumes from where it left off.
    void this._reconcileForEachSessions();

    // Hosted-mode only: on a fresh DB the `resource_definitions` table is empty,
    // so `agent/list` + friends return []. Seed the builtin YAMLs shipped with
    // the source tree (or install prefix) on every boot; the seeder is idempotent
    // and leaves any user-authored override rows untouched.
    //
    // Gate on `mode.kind` rather than `config.databaseUrl` -- modes layer
    // (packages/core/modes/app-mode.ts) explicitly forbids URL / `isHostedMode()`
    // sniffing so deployment-mode decisions flow through one canonical switch.
    if (this.mode.kind === "hosted") {
      const { seedBuiltinResources } = await import("./di/seed-builtins.js");
      await seedBuiltinResources(this);
    }

    // Boot-time reconciliation of orphaned per-session creds Secrets.
    // Runs as a background tail-task so a slow / unreachable cluster
    // never blocks the daemon from serving its first request. See
    // `services/creds-secret-reconciler.ts` for the full contract.
    void (async () => {
      try {
        const { reconcileOrphanedCredsSecrets } = await import("./services/creds-secret-reconciler.js");
        await reconcileOrphanedCredsSecrets(this);
      } catch (e: any) {
        const { logWarn } = await import("./observability/structured-log.js");
        logWarn("session", `creds-reconciler: boot invocation failed: ${e?.message ?? e}`);
      }
    })();

    // Eagerly construct + migrate the code-intel store. The store's migrate()
    // is async and we want it to land before any handler reads `app.codeIntel`.
    // The accessor below remains synchronous so handlers stay simple; if a
    // caller hits the accessor before `boot()` finishes (rare), they will get
    // a freshly-constructed but as-yet-unmigrated store.
    this._codeIntel = CodeIntelStoreCtor.fromApp(this);
    await this._codeIntel.migrate();

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
      await this._container.dispose().catch(async (err) => {
        const { logWarn } = await import("./observability/structured-log.js");
        logWarn("session", `AppContext: pre-boot container dispose failed (fast-path shutdown)`, {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    // Clean up temp directory (test mode)
    if (this.options.cleanupOnShutdown && existsSync(this.config.arkDir)) {
      rmSync(this.config.arkDir, { recursive: true, force: true });
    }

    this.phase = "stopped";
  }

  // ── Boot helpers (pre-container bootstrap only) ──────────────────────

  /**
   * Boot-time reconciliation of for_each sessions that were mid-loop when
   * the daemon last stopped.
   *
   * Scans all sessions with status=running that have a for_each_checkpoint in
   * their config. For each such session, re-dispatches it so the ForEachDispatcher
   * sees the checkpoint and resumes from where it left off (skipping completed
   * iterations, retrying the in-flight one).
   *
   * Must run AFTER the container is booted (so dispatchService is available)
   * but BEFORE the server accepts traffic (so no concurrent dispatches race
   * with this reconciliation). Called as a void background task from boot()
   * so an error here does not prevent the daemon from starting.
   *
   * Design choice: we re-dispatch the session directly, which sets it back to
   * status=ready -> running. A concurrent incoming dispatch for the same session
   * would be rejected by dispatch-core.ts ("Already running") so there is no
   * double-dispatch hazard once the reconcile kick lands.
   */
  async _reconcileForEachSessions(): Promise<void> {
    try {
      const { logInfo: li, logError: le } = await import("./observability/structured-log.js");
      // Sweep every tenant -- a hosted deployment can have running sessions
      // across many tenant_ids, and the root repo is bound to "default" only.
      const running = await this.sessions.listAcrossTenants({ status: "running", limit: 500 });
      for (const session of running) {
        const cp = (session.config as Record<string, unknown> | null)?.for_each_checkpoint;
        if (!cp || typeof cp !== "object") continue;
        const cpTyped = cp as import("./state/flow.js").ForEachCheckpoint;

        li(
          "boot",
          `reconciling for_each session ${session.id} stage '${cpTyped.stage_name}' ` +
            `at iteration ${cpTyped.next_index}/${cpTyped.total_items}`,
        );

        // Reset session to ready so dispatch can proceed (it was left as running
        // when the daemon crashed). Route every write + dispatch through the
        // session's tenant scope so tenant-scoped repos, services, and providers
        // land in the right tenant (Core P1-6).
        try {
          const tenantApp = this.forTenant(session.tenant_id);
          await tenantApp.sessions.update(session.id, { status: "ready", session_id: null });
          await tenantApp.dispatchService.dispatch(session.id);
        } catch (err: any) {
          le("boot", `reconcile for_each session ${session.id} failed: ${err?.message ?? err}`);
        }
      }
    } catch (err: any) {
      try {
        const { logWarn: lw2 } = await import("./observability/structured-log.js");
        lw2("boot", `_reconcileForEachSessions: scan failed: ${err?.message ?? err}`);
      } catch {
        // best-effort
      }
    }
  }

  /**
   * Rehydrate inline-flow definitions from persisted session config after a
   * daemon restart. Sessions spawned with an inline flow store the definition
   * under `config.inline_flow`; on restart the ephemeral overlay is empty so
   * we scan active sessions and re-register any definitions found there.
   *
   * Best-effort: a failure here does not prevent boot from completing. If a
   * session's inline flow cannot be rehydrated, stage lookups for that session
   * will fail gracefully (flow not found) rather than crashing the daemon.
   */
  private async _rehydrateInlineFlows(): Promise<void> {
    try {
      // Sweep every tenant -- inline flow definitions persist under
      // session.config.inline_flow across all tenants, not just "default".
      // The flows store's inline overlay is process-wide (shared registry),
      // so registering a tenant-A inline flow here is safe: the flow store
      // is keyed by name and used by dispatch to look up the definition.
      const sessions = await this.sessions.listAcrossTenants({ limit: 1000 });
      for (const session of sessions) {
        const inlineFlow = (session.config as Record<string, unknown> | null)?.inline_flow;
        if (!inlineFlow || typeof inlineFlow !== "object") continue;
        const def = inlineFlow as import("./state/flow.js").FlowDefinition;
        if (!def.name || !Array.isArray(def.stages)) continue;
        this.flows.registerInline?.(def.name, def);
      }
    } catch {
      // Best-effort -- log nothing so tests don't see noise.
    }
  }

  private _initFilesystem(): void {
    for (const dir of [this.config.arkDir, this.config.tracksDir, this.config.worktreesDir, this.config.logDir]) {
      mkdirSync(dir, { recursive: true });
    }
    setLogArkDir(this.config.arkDir);
    setProfilesArkDir(this.config.arkDir);
  }

  private async _openDatabase(): Promise<DatabaseAdapter> {
    // `this.mode` lazily builds a `preBootMode` when the container isn't up
    // yet -- safe at boot-time because `buildAppMode` is a pure function of
    // config. All downstream dialect decisions read `mode.database.dialect`
    // instead of re-sniffing `databaseUrl`, so this is the ONE place in the
    // codebase that converts a URL into a dialect + constructs the adapter.
    if (this.mode.database.dialect === "postgres") {
      const { PostgresAdapter } = await import("./database/postgres.js");
      const adapter = new PostgresAdapter(this.mode.database.url!);
      // Expose a drizzle client sharing the same postgres.js connection so
      // repository rewrites (Phase B of the cutover) can opt in incrementally
      // without spinning up a second pool.
      this._drizzle = buildPostgresDrizzle(adapter.connection);
      return adapter;
    }
    const rawDb = new Database(this.config.dbPath);
    rawDb.run("PRAGMA journal_mode = WAL");
    rawDb.run("PRAGMA busy_timeout = 5000");
    this._drizzle = buildSqliteDrizzle(rawDb);
    return new BunSqliteAdapter(rawDb);
  }

  private async _initSchema(db: DatabaseAdapter): Promise<void> {
    // Schema bootstrap + ongoing migrations both flow through AppMode.migrations.
    // The capability is dialect-bound at construction; the runner records
    // every applied version in `ark_schema_migrations`. Backwards compat for
    // pre-migration installs (laptop SQLite + the running pai-risk-mlops
    // Postgres) is handled inside the runner: if the apply log is empty but
    // the canonical legacy `compute` table exists, 001_initial is recorded
    // as already-applied so its body doesn't re-run.
    await this.mode.migrations.apply(db);
    await this.mode.computeBootstrap.seed(db);
  }

  private async _seedComputeTemplates(db: DatabaseAdapter): Promise<void> {
    if (!this.config.computeTemplates?.length) return;
    // Seed under the `__system__` sentinel tenant. Every tenant-scoped
    // `computeTemplates.list/get` unions in system rows, so hosted
    // deployments see the seeded blueprints from every tenant without
    // duplicating one row per tenant. A tenant can override any system
    // template by creating one of the same name under their own tenant_id.
    const { SYSTEM_TENANT_ID } = await import("./repositories/compute-template.js");
    const tmplRepo = new ComputeTemplateRepositoryCtor(db);
    tmplRepo.setTenant(SYSTEM_TENANT_ID);
    for (const tmpl of this.config.computeTemplates) {
      if (!(await tmplRepo.get(tmpl.name))) {
        await tmplRepo.create({
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

  get db(): DatabaseAdapter {
    return this._resolve("db");
  }

  /**
   * Dialect-tagged drizzle client. Populated in `_openDatabase()`; available
   * after `boot()` starts. Null before `_openDatabase()` runs (rare — tests
   * that construct AppContext without booting).
   *
   * This is the Phase-A foothold for the drizzle cutover: repositories are
   * still on hand-rolled SQL, but new code can opt in to the typed query
   * builder by reading from `app.drizzle.db` + `app.drizzle.schema`.
   */
  get drizzle(): DrizzleClient {
    if (!this._drizzle) {
      throw new Error("AppContext drizzle client not initialized -- _openDatabase() has not run");
    }
    return this._drizzle;
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
    return this._resolve("apiKeys");
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
  get sessionHooks(): SessionHooks {
    return this._resolve("sessionHooks");
  }
  get sessionLifecycle(): SessionLifecycle {
    return this._resolve("sessionLifecycle");
  }
  get dispatchService(): DispatchService {
    return this._resolve("dispatchService");
  }
  get stageAdvance(): StageAdvanceService {
    return this._resolve("stageAdvance");
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
   * Code-intel store -- normally eagerly initialized in `boot()` so its
   * async `migrate()` finishes before any handler reads this. Pre-boot
   * callers (rare; mostly tests that instantiate AppContext but skip
   * boot) fall back to a freshly-constructed store; in that case the
   * caller is responsible for awaiting `app.codeIntel.migrate()` itself.
   * Backed by SQLite locally, Postgres in control-plane.
   */
  get codeIntel(): CodeIntelStore {
    if (!this._codeIntel) {
      this._codeIntel = CodeIntelStoreCtor.fromApp(this);
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

  /**
   * Tenant-scoped secrets backend. Delegates to `app.mode.secrets` so callers
   * never need to know whether they're talking to the file-backed or AWS SSM
   * implementation. See `packages/core/secrets/types.ts`.
   */
  get secrets(): import("./secrets/types.js").SecretsCapability {
    return this.mode.secrets;
  }

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

  /** Per-app status-poller interval registry (replaces the old module-level Map). */
  get statusPollers(): import("./executors/status-poller.js").StatusPollerRegistry {
    return this._resolve("statusPollers");
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
  resolveProvider(session: Session): Promise<{ provider: ComputeProvider | null; compute: Compute | null }> {
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
