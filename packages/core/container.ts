/**
 * Awilix DI container -- the single source of truth for all dependencies.
 *
 * Boot order:
 *   config -> db -> repos -> services -> stores
 *
 * Shutdown:
 *   stopAll sessions -> stop infra -> container.dispose() -> close db
 */

import { createContainer, InjectionMode, type AwilixContainer } from "awilix";
import type { DatabaseAdapter } from "./database/index.js";
import type { ArkConfig } from "./config.js";
import type { SessionRepository } from "./repositories/session.js";
import type { ComputeRepository } from "./repositories/compute.js";
import type { ComputeTemplateRepository } from "./repositories/compute-template.js";
import type { EventRepository } from "./repositories/event.js";
import type { MessageRepository } from "./repositories/message.js";
import type { TodoRepository } from "./repositories/todo.js";
import type { ArtifactRepository } from "./repositories/artifact.js";
import type { FlowStateRepository } from "./repositories/flow-state.js";
import type { LedgerRepository } from "./repositories/ledger.js";
import type { ApiKeyManager } from "./auth/index.js";
import type { StatusPollerRegistry } from "./executors/status-poller.js";
import type { SessionService } from "./services/session.js";
import type { ComputeService } from "./services/compute.js";
import type { HistoryService } from "./services/history.js";
import type { SessionHooks } from "./services/session-hooks/index.js";
import type { SessionLifecycle } from "./services/session/index.js";
import type { DispatchService } from "./services/dispatch/index.js";
import type { StageAdvanceService } from "./services/stage-advance/index.js";
import type { FlowStore } from "./stores/flow-store.js";
import type { SkillStore } from "./stores/skill-store.js";
import type { AgentStore } from "./stores/agent-store.js";
import type { RuntimeStore } from "./stores/runtime-store.js";
import type { ModelStore } from "./stores/model-store.js";
import type { KnowledgeStore } from "./knowledge/store.js";
import type { PricingRegistry } from "./observability/pricing.js";
import type { UsageRecorder } from "./observability/usage.js";
import type { TranscriptParserRegistry } from "./runtimes/transcript-parser.js";
import type { PluginRegistry } from "./plugins/registry.js";
import type { SnapshotStore } from "../compute/core/snapshot-store.js";
import type { BlobStore } from "./storage/blob-store.js";
import type { AppContext } from "./app.js";
import type { AppMode } from "./modes/app-mode.js";
import type { Lifecycle } from "./lifecycle.js";
import type { ConductorLauncher } from "./infra/conductor-launcher.js";
import type { ArkdLauncher } from "./infra/arkd-launcher.js";
import type { RouterLauncher } from "./infra/router-launcher.js";
import type { TensorZeroLauncher } from "./infra/tensorzero-launcher.js";
import type { MetricsPoller } from "./infra/metrics-poller.js";
import type { MaintenancePollers } from "./infra/maintenance-pollers.js";
import type { SignalHandlers } from "./infra/signal-handlers.js";
import type { BootCleanup } from "./infra/boot-cleanup.js";
import type { ServiceWiring } from "./infra/service-wiring.js";
import type { ComputeProvidersBoot } from "./infra/compute-providers-boot.js";
import type { SessionDrain } from "./infra/session-drain.js";
import type { WorkerRegistry } from "./hosted/worker-registry.js";
import type { SessionScheduler } from "./hosted/scheduler.js";
import type { TenantPolicyManager, ApiKeyManager, TenantManager, TeamManager, UserManager } from "./auth/index.js";
import type { TenantClaudeAuthManager } from "./auth/tenant-claude-auth.js";
import type { TicketProviderRegistry } from "./tickets/registry.js";
import type { McpPool } from "./mcp-pool.js";

/**
 * The cradle -- everything resolvable from the container.
 *
 * Factories registered via `asFunction` read dependencies from this cradle.
 * We avoid `asClass` + CLASSIC injection because `bun build --compile`
 * minifies constructor parameter names, which breaks name-based matching.
 * See packages/core/di/ for the actual registrations.
 */
/**
 * Boot options that toggle optional background services. Registered in the
 * cradle so launchers can read flags without reaching back into AppContext.
 */
export interface AppBootOptions {
  skipConductor?: boolean;
  skipMetrics?: boolean;
  skipSignals?: boolean;
  cleanupOnShutdown?: boolean;
}

export interface Cradle {
  // Config
  config: ArkConfig;
  bootOptions: AppBootOptions;

  // AppContext itself -- registered as a scoped value so services can
  // resolve it without passing it through every constructor manually.
  app: AppContext;

  // Deployment-mode descriptor. Picked once at DI composition based on
  // `config.database.url`; resolved polymorphically thereafter. Handlers,
  // services, and components never branch on a `hosted` boolean -- they
  // read `app.mode.<capability>` and act on its presence/absence.
  mode: AppMode;

  // Database
  db: DatabaseAdapter;

  // Repositories
  sessions: SessionRepository;
  computes: ComputeRepository;
  computeTemplates: ComputeTemplateRepository;
  events: EventRepository;
  messages: MessageRepository;
  todos: TodoRepository;
  artifacts: ArtifactRepository;
  flowStates: FlowStateRepository;
  ledger: LedgerRepository;

  // Auth
  apiKeys: ApiKeyManager;

  // Services
  sessionService: SessionService;
  computeService: ComputeService;
  historyService: HistoryService;
  sessionHooks: SessionHooks;
  sessionLifecycle: SessionLifecycle;
  dispatchService: DispatchService;
  stageAdvance: StageAdvanceService;

  // Resource stores
  flows: FlowStore;
  skills: SkillStore;
  agents: AgentStore;
  runtimes: RuntimeStore;
  models: ModelStore;

  // Knowledge graph
  knowledge: KnowledgeStore;

  // Cost tracking
  pricing: PricingRegistry;
  usageRecorder: UsageRecorder;

  // Runtime transcript parsers
  transcriptParsers: TranscriptParserRegistry;

  // Plugin registry (executors, compute providers, etc.)
  pluginRegistry: PluginRegistry;

  // Snapshot persistence
  snapshotStore: SnapshotStore;

  // Blob storage (session input uploads, exports)
  blobStore: BlobStore;

  // Lifecycle + infra launchers (container-managed start/stop)
  lifecycle: Lifecycle;
  serviceWiring: ServiceWiring;
  computeProvidersBoot: ComputeProvidersBoot;
  tensorZeroLauncher: TensorZeroLauncher;
  routerLauncher: RouterLauncher;
  conductorLauncher: ConductorLauncher;
  arkdLauncher: ArkdLauncher;
  metricsPoller: MetricsPoller;
  maintenancePollers: MaintenancePollers;
  bootCleanup: BootCleanup;
  signalHandlers: SignalHandlers;
  sessionDrain: SessionDrain;

  // Status polling registry (per-AppContext; disposed on shutdown)
  statusPollers: StatusPollerRegistry;

  // Ticket provider registry (tenant-scoped Jira/GitHub/Linear bindings)
  ticketProviderRegistry: TicketProviderRegistry;

  // MCP socket pool (shares MCP server processes across sessions)
  mcpPool: McpPool;

  // Hosted-mode services (registered via `di/hosted.ts` only when
  // `mode.kind === "hosted"`; resolving in local mode throws and the
  // AppContext accessors wrap that into "hosted mode only").
  workerRegistry?: WorkerRegistry;
  sessionScheduler?: SessionScheduler;

  // Auth managers -- shared across local + hosted. Always present after
  // boot because `registerRepositories` registers them unconditionally.
  apiKeys: ApiKeyManager;
  tenants: TenantManager;
  teams: TeamManager;
  users: UserManager;
  tenantClaudeAuth: TenantClaudeAuthManager;
  tenantPolicyManager: TenantPolicyManager;
}

export type AppContainer = AwilixContainer<Cradle>;

/**
 * Create an empty container. Registrations happen during boot().
 *
 * Uses PROXY injection mode: factories registered via `asFunction` receive
 * a single cradle-proxy argument and access deps via property lookup
 * (`c.db`, `c.sessions`). Property access is string-based, so the pattern
 * survives `bun build --compile` minification -- unlike CLASSIC mode which
 * relies on introspecting constructor parameter names.
 */
export function createAppContainer(): AppContainer {
  return createContainer<Cradle>({
    injectionMode: InjectionMode.PROXY,
    strict: true,
  });
}
