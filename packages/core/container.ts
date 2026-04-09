/**
 * Awilix DI container -- the single source of truth for all dependencies.
 *
 * Boot order:
 *   config -> db -> repos -> services -> stores
 *
 * Shutdown:
 *   stopAll sessions -> stop infra -> container.dispose() -> close db
 */

import {
  createContainer,
  InjectionMode,
  type AwilixContainer,
} from "awilix";
import type { Database } from "bun:sqlite";
import type { ArkConfig } from "./config.js";
import type { SessionRepository } from "./repositories/session.js";
import type { ComputeRepository } from "./repositories/compute.js";
import type { EventRepository } from "./repositories/event.js";
import type { MessageRepository } from "./repositories/message.js";
import type { TodoRepository } from "./repositories/todo.js";
import type { SessionService } from "./services/session.js";
import type { ComputeService } from "./services/compute.js";
import type { HistoryService } from "./services/history.js";
import type { FlowStore } from "./stores/flow-store.js";
import type { SkillStore } from "./stores/skill-store.js";
import type { AgentStore } from "./stores/agent-store.js";
import type { RecipeStore } from "./stores/recipe-store.js";

/**
 * The cradle -- everything resolvable from the container.
 * Constructor parameter names MUST match these keys (CLASSIC injection mode).
 */
export interface Cradle {
  // Config
  config: ArkConfig;

  // Database
  db: Database;

  // Repositories
  sessions: SessionRepository;
  computes: ComputeRepository;
  events: EventRepository;
  messages: MessageRepository;
  todos: TodoRepository;

  // Services
  sessionService: SessionService;
  computeService: ComputeService;
  historyService: HistoryService;

  // Resource stores
  flows: FlowStore;
  skills: SkillStore;
  agents: AgentStore;
  recipes: RecipeStore;
}

export type AppContainer = AwilixContainer<Cradle>;

/**
 * Create an empty container. Registrations happen during boot().
 */
export function createAppContainer(): AppContainer {
  return createContainer<Cradle>({
    injectionMode: InjectionMode.CLASSIC,
    strict: true,
  });
}
