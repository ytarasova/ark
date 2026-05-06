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
import type {
  Compute as NewCompute,
  Isolation as NewIsolation,
  ComputeKind,
  IsolationKind,
} from "../compute/core/types.js";
import type { ComputePool } from "../compute/core/pool/types.js";
import type { SnapshotStore } from "../compute/core/snapshot-store.js";
import type { Compute, Session, ComputeProviderName } from "../types/index.js";
import { track } from "./observability/telemetry.js";
import { setLogArkDir } from "./observability/structured-log.js";
import { setProfilesArkDir } from "./services/profile.js";
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
import type { SessionService, ComputeService } from "./services/index.js";
import type { SessionHooks } from "./services/session-hooks/index.js";
import type { SessionLifecycle } from "./services/session/index.js";
import type { SessionAttachService } from "./services/session/attach.js";
import type { DispatchService } from "./services/dispatch/index.js";
import type { StageAdvanceService } from "./services/stage-advance/index.js";
import type { FlowStore, SkillStore, AgentStore, RuntimeStore, ModelStore } from "./stores/index.js";
import type { WorkspaceStore } from "../workspace/store.js";
import { ComputeRegistries } from "./compute-registries.js";
import { resolveProvider, resolveComputeTarget } from "./compute-resolver.js";
import type { TranscriptParserRegistry } from "./runtimes/transcript-parser.js";
import type { PluginRegistry } from "./plugins/registry.js";
import { noopExecutor, NOOP_EXECUTOR_NAMES } from "./executors/noop.js";
import type { ApiKeyManager, TenantManager, TeamManager, UserManager, TenantPolicyManager } from "./auth/index.js";
import type { TenantClaudeAuthManager } from "./auth/tenant-claude-auth.js";
import type { WorkerRegistry } from "./hosted/worker-registry.js";
import type { SessionScheduler } from "./hosted/scheduler.js";
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
  // are registered imperatively during boot, not constructed from config.
  private _registries = new ComputeRegistries();

  private _eventBusReady = false;
  private _drizzle: DrizzleClient | null = null;

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
    // filesystem, DB open, schema migration, and compute-template seeding.
    // ApiKeyManager + the other auth managers are registered as singleton
    // factories in `di/persistence.ts` and resolved lazily on first access.
    this._initFilesystem();
    const db = await this._openDatabase();
    await this._initSchema(db);
    await this._seedComputeTemplates(db);

    // Container + lifecycle. `buildContainer()` wires every repo, store,
    // service, and infra launcher; `lifecycle.start()` resolves + calls
    // `start()` on each launcher in canonical order. Awilix tracks every
    // resolution so `container.dispose()` later tears them down in reverse.
    this._container = buildContainer({ app: this, config: this.config, db, bootOptions: this.options });

    // Re-apply a test-mode override across the placeholder->real container
    // swap. Production callers never touch `_modeOverrideForTest`; tests use
    // `_setModeForTest` to simulate hosted mode against a SQLite test DB.
    if (this._modeOverrideForTest) {
      this._container.register({ mode: asValue(this._modeOverrideForTest) });
    }
    // Apply any test-only cradle overrides queued via
    // `_setContainerOverridesForTest`. Used by hosted-mode regression tests
    // to inject stub blob/snapshot stores that satisfy the H6/H7 boot
    // guards without requiring real S3 / Postgres.
    if (Object.keys(this._containerOverridesForTest).length > 0) {
      const wrapped: Record<string, ReturnType<typeof asValue>> = {};
      for (const [k, v] of Object.entries(this._containerOverridesForTest)) {
        wrapped[k] = asValue(v);
      }
      this._container.register(wrapped);
    }

    // Eagerly resolve the cluster of stores whose hosted-mode contract is
    // "no local-disk fallback" so a misconfigured deployment fails at boot
    // with a clear error rather than at first session/pause or first input
    // upload (potentially under load). The factories themselves contain the
    // real configuration check; we just trip them here so awilix surfaces
    // the throw before lifecycle.start() spins up the conductor.
    if (this.mode.kind === "hosted") {
      this._container.resolve("blobStore");
      this._container.resolve("snapshotStore");
    }

    await this._container.cradle.lifecycle.start();

    // Test profile: register the noop executor for every real runtime name.
    // Without this, any test that triggers dispatch (directly or via the
    // conductor HTTP hooks) would reach the real claude-code / agent-sdk
    // executors and spawn tmux panes + live claude binaries, leaking into
    // the host environment.
    if (this.config.profile === "test") {
      installNoopExecutors(this);
      await installTestSecrets(this);
    }

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

    // Rehydrate status pollers + arkd events consumers for sessions that were
    // already mid-flight when the previous daemon process exited. Without
    // this, `bun --watch` reloads and operator restarts orphan running
    // sessions -- the worker keeps going but the conductor goes blind.
    // See #424 for the failure mode.
    void this._rehydrateRunningSessions();

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
    if (this.options.cleanupOnShutdown && existsSync(this.config.dirs.ark)) {
      rmSync(this.config.dirs.ark, { recursive: true, force: true });
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
        const cpTyped = cp as import("./services/flow.js").ForEachCheckpoint;

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
        const def = inlineFlow as import("./services/flow.js").FlowDefinition;
        if (!def.name || !Array.isArray(def.stages)) continue;
        this.flows.registerInline?.(def.name, def);
      }
    } catch {
      // Best-effort -- log nothing so tests don't see noise.
    }
  }

  /**
   * Re-arm status pollers + arkd events consumers for sessions that were
   * `running` when the daemon last stopped. Without this, hot-reloads
   * (`bun --watch`) and operator restarts orphan in-flight sessions: the
   * agents on the worker keep going, but the conductor stops polling and
   * stops draining the arkd events stream, so the UI never sees progress
   * and the session never auto-advances on completion. Closes #424.
   *
   * The status poller registry + the events-consumer registry are owned
   * by AppContext; they were torn down on the previous container's
   * disposal. Pollers are normally started by `post-launch.ts` on the
   * dispatch path. Events consumers are started by `EC2Compute.setup-
   * Transport` (and equivalents) during provisioning. Neither path runs
   * for an already-launched session at boot; this method fills that gap.
   */
  private async _rehydrateRunningSessions(): Promise<void> {
    const { logInfo: li, logWarn: lw } = await import("./observability/structured-log.js");
    let pollers = 0;
    let stalePortsCleared = 0;
    const computesNeedingTransport = new Map<string, string>();
    try {
      // Hosted deployments may have running sessions in many tenants; sweep
      // across all of them. Local single-tenant mode degenerates to one
      // tenant, no extra cost.
      const sessions = await this.sessions.listAcrossTenants({ status: "running", limit: 500 });
      for (const session of sessions) {
        // RESILIENCE: clear `arkd_local_forward_port` from session config on
        // boot. The port indexes a SSM port-forward subprocess that lived on
        // the PREVIOUS conductor process -- once the daemon restarts that
        // tunnel is dead, but the port stays cached on the session row. The
        // next arkd RPC (status-poller, action stages, terminal attach...)
        // would post to a port that nobody's listening on and fail with
        // ECONNREFUSED. Clearing here forces the next ensureReachable to
        // allocate a fresh tunnel before any RPC fires.
        const cfg = session.config as Record<string, unknown> | null;
        if (cfg && typeof cfg.arkd_local_forward_port === "number") {
          try {
            const tenantApp = this.forTenant(session.tenant_id);
            const next = { ...cfg };
            delete next.arkd_local_forward_port;
            await tenantApp.sessions.update(session.id, { config: next });
            stalePortsCleared++;
          } catch (err: any) {
            lw("boot", `rehydrate: failed to clear stale port for ${session.id}: ${err?.message ?? err}`);
          }
        }
        if (!session.session_id || !session.compute_name) continue;
        // Track the (compute, tenant) pair so we restart consumers exactly once
        // per compute, scoped to a tenant that owns at least one session there.
        if (!computesNeedingTransport.has(session.compute_name)) {
          computesNeedingTransport.set(session.compute_name, session.tenant_id);
        }
        try {
          const { startStatusPoller } = await import("./executors/status-poller.js");
          const { resolveSessionExecutor } = await import("./executors/resolve.js");
          // Read the canonical launch_executor (set by post-launch when the
          // session was dispatched), with the agent-definition runtime as
          // fallback for legacy sessions. Defaulting to "claude-code" was a
          // mix of concerns: each runtime needs its own probeStatus path
          // (#435) -- claude-agent uses /process/status, not tmux. A wrong
          // runtime here makes the poller probe the wrong endpoint.
          const tenantApp = this.forTenant(session.tenant_id);
          const runtime = await resolveSessionExecutor(tenantApp, session);
          if (!runtime) {
            lw("boot", `rehydrate: no runtime for session ${session.id} -- skipping poller`);
            continue;
          }
          startStatusPoller(tenantApp, session.id, session.session_id, runtime);
          pollers++;
        } catch (err: any) {
          lw("boot", `rehydrate poller failed for ${session.id}: ${err?.message ?? err}`);
        }
      }
    } catch (err: any) {
      lw("boot", `_rehydrateRunningSessions: scan failed: ${err?.message ?? err}`);
      return;
    }

    let consumers = 0;
    for (const [computeName, tenantId] of computesNeedingTransport) {
      try {
        const tenantApp = this.forTenant(tenantId);
        const compute = await tenantApp.computes.get(computeName);
        if (!compute) continue;
        const { resolveProvider } = await import("./compute-resolver.js");
        // resolveProvider takes a session; synthesise a minimal one here since
        // we just need the provider lookup -- it only reads compute_name + tenant_id.
        const fakeSession = { compute_name: computeName, tenant_id: tenantId } as import("../types/session.js").Session;
        const { provider } = await resolveProvider(tenantApp, fakeSession);
        if (!provider) continue;
        const arkdUrl = (provider as { getArkdUrl?: (c: typeof compute) => string }).getArkdUrl?.(compute);
        if (!arkdUrl) continue;
        const { startArkdEventsConsumer } = await import("./conductor/server/arkd-events-consumer.js");
        startArkdEventsConsumer(tenantApp, computeName, arkdUrl, process.env.ARK_ARKD_TOKEN ?? null);
        consumers++;
      } catch (err: any) {
        lw("boot", `rehydrate consumer failed for ${computeName}: ${err?.message ?? err}`);
      }
    }

    if (pollers > 0 || consumers > 0 || stalePortsCleared > 0) {
      li(
        "boot",
        `rehydrated ${pollers} status pollers + ${consumers} events consumers, cleared ${stalePortsCleared} stale arkd-tunnel ports for in-flight sessions`,
      );
    }
  }

  private _initFilesystem(): void {
    // Hosted mode: the conductor is a stateless multi-tenant control-plane
    // process. Per-process arkDir paths are not tenant-scoped and are lost
    // on pod restart, so we never materialise them. The structured-log file
    // sink and the profiles store both no-op when their arkDir is null --
    // skipping the setLog*/setProfiles* calls keeps them that way.
    //
    // We also stamp `ARK_MODE=hosted` on the process env so leaf helpers
    // (`claude/trust.ts`, anything that can't take an AppContext) can gate
    // local-fs writes without re-importing AppContext.
    //
    // Local mode keeps the existing behaviour: mkdir the four standard dirs
    // (ark/tracks/worktrees/logs) and bind the JSONL log + profiles file to
    // arkDir so subsequent writes land on disk.
    if (this.mode.kind === "hosted") {
      process.env.ARK_MODE = "hosted";
      // Laptop hosted dev: when ARK_DEV_ALLOW_LOCAL_HOSTED_STORAGE=1 is set,
      // the operator is running hosted mode against Docker Compose on a real
      // laptop filesystem (not an ephemeral pod). Materialise the arkDir and
      // bind the structured log so logInfo/logDebug calls become visible at
      // ${arkDir}/ark.jsonl. NEVER set this env in real k8s deployments --
      // the file sink stays null there, matching the original contract.
      if (process.env.ARK_DEV_ALLOW_LOCAL_HOSTED_STORAGE === "1") {
        for (const dir of [
          this.config.dirs.ark,
          this.config.dirs.tracks,
          this.config.dirs.worktrees,
          this.config.dirs.logs,
        ]) {
          mkdirSync(dir, { recursive: true });
        }
        setLogArkDir(this.config.dirs.ark);
        setProfilesArkDir(this.config.dirs.ark);
      }
      return;
    }

    for (const dir of [
      this.config.dirs.ark,
      this.config.dirs.tracks,
      this.config.dirs.worktrees,
      this.config.dirs.logs,
    ]) {
      mkdirSync(dir, { recursive: true });
    }
    setLogArkDir(this.config.dirs.ark);
    setProfilesArkDir(this.config.dirs.ark);
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

  /** Convenience shortcut for config.dirs.ark (used heavily in tests). */
  get arkDir(): string {
    return this.config.dirs.ark;
  }

  get db(): DatabaseAdapter {
    return this._resolve("db");
  }

  /**
   * Dialect-tagged drizzle client. Populated in `_openDatabase()`; available
   * after `boot()` starts. Null before `_openDatabase()` runs (rare -- tests
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

  /** Tenant CRUD manager. Available after boot. */
  get tenants(): TenantManager {
    return this._resolve("tenants");
  }

  /** Team CRUD + membership manager. Available after boot. */
  get teams(): TeamManager {
    return this._resolve("teams");
  }

  /** User CRUD manager. Available after boot. */
  get users(): UserManager {
    return this._resolve("users");
  }

  /** Per-tenant Claude credential binding manager. Available after boot. */
  get tenantClaudeAuth(): TenantClaudeAuthManager {
    return this._resolve("tenantClaudeAuth");
  }

  get sessionService(): SessionService {
    return this._resolve("sessionService");
  }
  get computeService(): ComputeService {
    return this._resolve("computeService");
  }
  get sessionHooks(): SessionHooks {
    return this._resolve("sessionHooks");
  }
  get sessionLifecycle(): SessionLifecycle {
    return this._resolve("sessionLifecycle");
  }
  get sessionAttach(): SessionAttachService {
    return this._resolve("sessionAttach");
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
  get runtimes(): RuntimeStore {
    return this._resolve("runtimes");
  }
  /** Three-layer model catalog (project > global > bundled). */
  get models(): ModelStore {
    return this._resolve("models");
  }
  /** Multi-repo workspace store (workspaces + workspace_repos). */
  get workspaces(): WorkspaceStore {
    return this._resolve("workspaces");
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

  /**
   * Test-only: install a pre-built `AppMode` so the accessor returns it
   * during boot (when phase is "booting") and after boot (via the
   * container override below). Used by `forHostedTestAsync` to simulate
   * hosted-mode contracts without standing up a real Postgres.
   *
   * Must be called BEFORE `boot()`. Sets the pre-boot cache and queues a
   * post-boot container registration so the swap survives `buildContainer`.
   */
  _setModeForTest(mode: AppMode): void {
    this._preBootMode = mode;
    // Persist the override across the placeholder->real container swap that
    // happens inside `boot()`. The hook fires once buildContainer finishes
    // wiring and right before lifecycle.start runs.
    this._modeOverrideForTest = mode;
  }

  /**
   * Test-only: queue arbitrary cradle overrides to apply after the
   * placeholder->real container swap inside `boot()`. Use to inject stub
   * stores (e.g. a fake snapshotStore) that would otherwise refuse hosted
   * mode at boot.
   */
  _setContainerOverridesForTest(overrides: Record<string, unknown>): void {
    this._containerOverridesForTest = { ...this._containerOverridesForTest, ...overrides };
  }

  /** @internal -- consumed by `boot()` to re-apply a test mode after the container swap. */
  private _modeOverrideForTest: AppMode | null = null;
  /** @internal -- consumed by `boot()` to re-apply test stubs after the container swap. */
  private _containerOverridesForTest: Record<string, unknown> = {};

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

  // ── Worker registry / scheduler / tenant policy (container-resolved) ─
  //
  // Registered in `packages/core/di/hosted.ts` when `mode.kind === "hosted"`.
  // In local mode the factories are absent, so the awilix resolve throws
  // with "Could not resolve 'X'". Tests that need a real instance in local
  // mode can override via `app.container.register({ workerRegistry: asValue(...) })`
  // -- the usual DI escape hatch for test doubles.

  /** Worker registry for hosted multi-tenant deployment. Throws in local mode. */
  get workerRegistry(): WorkerRegistry {
    try {
      return this._container.resolve("workerRegistry") as WorkerRegistry;
    } catch {
      throw new Error("Worker registry not initialized (hosted mode only)");
    }
  }

  /** Session scheduler for hosted multi-tenant deployment. Throws in local mode. */
  get scheduler(): SessionScheduler {
    try {
      return this._container.resolve("sessionScheduler") as SessionScheduler;
    } catch {
      throw new Error("Scheduler not initialized (hosted mode only)");
    }
  }

  /**
   * Tenant policy manager. Always available after boot (registered as a
   * DI singleton in `di/persistence.ts`). The return type stays nullable
   * for back-compat -- existing callers null-check this before use.
   */
  get tenantPolicyManager(): TenantPolicyManager | null {
    try {
      return this._container.resolve("tenantPolicyManager") as TenantPolicyManager;
    } catch {
      return null;
    }
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
   * Create a tenant-scoped view of this AppContext. Delegates to the mode's
   * `tenantScope` capability:
   *   - Local mode: single-tenant; returns self (no isolation to enforce).
   *   - Hosted mode: builds a child DI container scope, with re-entrancy
   *     short-circuit when already pinned to that tenant.
   *
   * Call sites must NOT branch on `mode.kind`. Any per-mode policy lives in
   * `local-app-mode.ts` / `hosted-app-mode.ts`.
   */
  forTenant(tenantId: string): AppContext {
    return this.mode.tenantScope.forTenant(this, tenantId);
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
  registerIsolation(r: NewIsolation): void {
    this._registries.registerIsolation(r);
  }
  getCompute(kind: ComputeKind): NewCompute | null {
    return this._registries.getCompute(kind);
  }
  getIsolation(kind: IsolationKind): NewIsolation | null {
    return this._registries.getIsolation(kind);
  }
  listComputes(): ComputeKind[] {
    return this._registries.listComputes();
  }
  listIsolations(): IsolationKind[] {
    return this._registries.listIsolations();
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
    const config = loadConfig({ dirs: { ark: tempDir } as any, env: "test", ...overrides });
    return new AppContext(config, TEST_OPTIONS);
  }

  /** Parallel-safe test AppContext -- allocates unique ports + arkDir per call. */
  static async forTestAsync(overrides?: Partial<ArkConfig>): Promise<AppContext> {
    const config = await loadAppConfig({ profile: "test", ...overrides });
    return new AppContext(config, TEST_OPTIONS);
  }
}

/**
 * Override every known executor name with the noop stub in the app's per-
 * instance plugin registry. `resolveExecutor` in dispatch consults the
 * per-app registry before the global one, so this prevents any test-mode
 * dispatch from reaching the real claude-code / claude-agent / goose
 * executors (which would spawn tmux panes + real agent binaries).
 */
function installNoopExecutors(app: AppContext): void {
  const reg = app.pluginRegistry;
  for (const name of NOOP_EXECUTOR_NAMES) {
    reg.register({ kind: "executor", name, impl: { ...noopExecutor, name } });
  }
}

/**
 * Test profile: pre-seed the secret store with dummy values for every
 * env-var secret declared by a builtin runtime YAML (claude-code.yaml's
 * CLAUDE_CODE_OAUTH_TOKEN, claude-agent's ANTHROPIC_API_KEY, etc).
 *
 * Without this, any test that runs through `dispatchService.dispatch`
 * fails at `buildLaunchEnv` with "Missing secrets for tenant 'default'"
 * because the test-mode arkDir is fresh and the secret store is empty.
 * The noop executor never reads these values; we just need them to be
 * resolvable so the runtime's secret contract is satisfied.
 *
 * Walks `app.runtimes` so future runtime-secret additions are seeded
 * automatically without anyone having to edit this list.
 */
async function installTestSecrets(app: AppContext): Promise<void> {
  const TENANT = "default";
  const runtimes = await app.runtimes.list();
  const seen = new Set<string>();
  for (const rt of runtimes) {
    const decls = (rt as { secrets?: unknown }).secrets;
    if (!Array.isArray(decls)) continue;
    for (const decl of decls as unknown[]) {
      const name = typeof decl === "string" ? decl : (decl as { name?: string })?.name;
      if (typeof name !== "string" || !name) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      try {
        await app.secrets.set(TENANT, name, "test-dummy-value", { type: "env-var" });
      } catch {
        // Secret-store backends differ; best-effort. The dispatch will
        // surface a clearer error if any of these turn out to be required.
      }
    }
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
