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
import type { IDatabase } from "./database/index.js";
import type { ArkConfig } from "./config.js";
import type { SessionRepository } from "./repositories/session.js";
import type { ComputeRepository } from "./repositories/compute.js";
import type { ComputeTemplateRepository } from "./repositories/compute-template.js";
import type { EventRepository } from "./repositories/event.js";
import type { MessageRepository } from "./repositories/message.js";
import type { TodoRepository } from "./repositories/todo.js";
import type { ArtifactRepository } from "./repositories/artifact.js";
import type { SessionService } from "./services/session.js";
import type { ComputeService } from "./services/compute.js";
import type { HistoryService } from "./services/history.js";
import type { FlowStore } from "./stores/flow-store.js";
import type { SkillStore } from "./stores/skill-store.js";
import type { AgentStore } from "./stores/agent-store.js";
import type { RecipeStore } from "./stores/recipe-store.js";
import type { RuntimeStore } from "./stores/runtime-store.js";
import type { KnowledgeStore } from "./knowledge/store.js";
import type { PricingRegistry } from "./observability/pricing.js";
import type { UsageRecorder } from "./observability/usage.js";
import type { TranscriptParserRegistry } from "./runtimes/transcript-parser.js";
import type { PluginRegistry } from "./plugins/registry.js";
import type { SnapshotStore } from "../compute/core/snapshot-store.js";
import type { AppContext } from "./app.js";

/**
 * The cradle -- everything resolvable from the container.
 *
 * Factories registered via `asFunction` read dependencies from this cradle.
 * We avoid `asClass` + CLASSIC injection because `bun build --compile`
 * minifies constructor parameter names, which breaks name-based matching.
 * See packages/core/di/ for the actual registrations.
 */
export interface Cradle {
  // Config
  config: ArkConfig;

  // AppContext itself -- registered as a scoped value so services can
  // resolve it without passing it through every constructor manually.
  app: AppContext;

  // Database
  db: IDatabase;

  // Repositories
  sessions: SessionRepository;
  computes: ComputeRepository;
  computeTemplates: ComputeTemplateRepository;
  events: EventRepository;
  messages: MessageRepository;
  todos: TodoRepository;
  artifacts: ArtifactRepository;

  // Services
  sessionService: SessionService;
  computeService: ComputeService;
  historyService: HistoryService;

  // Resource stores
  flows: FlowStore;
  skills: SkillStore;
  agents: AgentStore;
  recipes: RecipeStore;
  runtimes: RuntimeStore;

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
