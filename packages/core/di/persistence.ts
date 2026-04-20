/**
 * DI registrations for persistence: database, repositories, resource stores.
 *
 * All registrations here are SINGLETON scoped -- one instance per container.
 * Factories use `asFunction` + explicit cradle reads so registrations survive
 * minification (bun build --compile mangles constructor parameter names).
 */

import { asFunction, asValue, Lifetime } from "awilix";
import { join } from "path";
import type { AppContainer } from "../container.js";
import type { IDatabase } from "../database/index.js";
import type { ArkConfig } from "../config.js";
import { resolveStoreBaseDir } from "../install-paths.js";
import {
  SessionRepository,
  ComputeRepository,
  ComputeTemplateRepository,
  EventRepository,
  MessageRepository,
  TodoRepository,
  ArtifactRepository,
} from "../repositories/index.js";
import { FileFlowStore, FileSkillStore, FileAgentStore, FileRecipeStore, FileRuntimeStore } from "../stores/index.js";
import { DbResourceStore, initResourceDefinitionsTable } from "../stores/db-resource-store.js";
import { KnowledgeStore } from "../knowledge/store.js";

/**
 * Register the database under `db`. The DB is provided by the caller because
 * opening it is async (SQLite vs Postgres) and must happen before schema init.
 * We register a disposer so `container.dispose()` closes the connection.
 */
export function registerDatabase(container: AppContainer, db: IDatabase): void {
  container.register({
    db: asValue(db),
  });
  // Awilix only auto-invokes disposers for asFunction/asClass registrations.
  // Re-register as a function so the disposer fires on container.dispose().
  container.register({
    db: asFunction(() => db, {
      lifetime: Lifetime.SINGLETON,
      dispose: (instance) => {
        try {
          instance.close();
        } catch {
          // best-effort: already closed is fine
        }
      },
    }),
  });
}

/**
 * Register all repositories as singletons. Repositories depend on `db` and
 * `config` (the latter for channel port bounds on SessionRepository).
 */
export function registerRepositories(container: AppContainer): void {
  container.register({
    sessions: asFunction(
      (c: { db: IDatabase; config: ArkConfig }) => {
        const repo = new SessionRepository(c.db);
        repo.setChannelBounds(c.config.channels.basePort, c.config.channels.range);
        return repo;
      },
      { lifetime: Lifetime.SINGLETON },
    ),

    computes: asFunction((c: { db: IDatabase }) => new ComputeRepository(c.db), { lifetime: Lifetime.SINGLETON }),

    computeTemplates: asFunction((c: { db: IDatabase }) => new ComputeTemplateRepository(c.db), {
      lifetime: Lifetime.SINGLETON,
    }),

    events: asFunction((c: { db: IDatabase }) => new EventRepository(c.db), { lifetime: Lifetime.SINGLETON }),
    messages: asFunction((c: { db: IDatabase }) => new MessageRepository(c.db), { lifetime: Lifetime.SINGLETON }),
    todos: asFunction((c: { db: IDatabase }) => new TodoRepository(c.db), { lifetime: Lifetime.SINGLETON }),
    artifacts: asFunction((c: { db: IDatabase }) => new ArtifactRepository(c.db), { lifetime: Lifetime.SINGLETON }),

    // Knowledge graph is persistence-adjacent -- keep it here with the repos.
    knowledge: asFunction((c: { db: IDatabase }) => new KnowledgeStore(c.db), { lifetime: Lifetime.SINGLETON }),
  });
}

/**
 * Register resource stores (flows, skills, agents, recipes, runtimes).
 *
 * Two modes:
 *   - Local (no databaseUrl): file-backed stores with three-tier resolution
 *     (builtin + user dirs).
 *   - Hosted (databaseUrl set): DB-backed stores with tenant scoping.
 */
export function registerResourceStores(container: AppContainer): void {
  container.register({
    flows: asFunction((c: { db: IDatabase; config: ArkConfig }) => makeFlowStore(c.db, c.config), {
      lifetime: Lifetime.SINGLETON,
    }),
    skills: asFunction((c: { db: IDatabase; config: ArkConfig }) => makeSkillStore(c.db, c.config), {
      lifetime: Lifetime.SINGLETON,
    }),
    agents: asFunction((c: { db: IDatabase; config: ArkConfig }) => makeAgentStore(c.db, c.config), {
      lifetime: Lifetime.SINGLETON,
    }),
    recipes: asFunction((c: { db: IDatabase; config: ArkConfig }) => makeRecipeStore(c.db, c.config), {
      lifetime: Lifetime.SINGLETON,
    }),
    runtimes: asFunction((c: { db: IDatabase; config: ArkConfig }) => makeRuntimeStore(c.db, c.config), {
      lifetime: Lifetime.SINGLETON,
    }),
  });
}

// ── Factory helpers ─────────────────────────────────────────────────────────

function isHosted(config: ArkConfig): boolean {
  return !!config.databaseUrl;
}

function makeFlowStore(db: IDatabase, config: ArkConfig) {
  if (isHosted(config)) {
    initResourceDefinitionsTable(db);
    return new DbResourceStore(db, "flow", { stages: [] });
  }
  return new FileFlowStore({
    builtinDir: join(resolveStoreBaseDir(), "flows", "definitions"),
    userDir: join(config.arkDir, "flows"),
  });
}

function makeSkillStore(db: IDatabase, config: ArkConfig) {
  if (isHosted(config)) {
    initResourceDefinitionsTable(db);
    return new DbResourceStore(db, "skill", { description: "", content: "" });
  }
  return new FileSkillStore({
    builtinDir: join(resolveStoreBaseDir(), "skills"),
    userDir: join(config.arkDir, "skills"),
  });
}

function makeAgentStore(db: IDatabase, config: ArkConfig) {
  if (isHosted(config)) {
    initResourceDefinitionsTable(db);
    return new DbResourceStore(db, "agent", {
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
  }
  return new FileAgentStore({
    builtinDir: join(resolveStoreBaseDir(), "agents"),
    userDir: join(config.arkDir, "agents"),
  });
}

function makeRecipeStore(db: IDatabase, config: ArkConfig) {
  if (isHosted(config)) {
    initResourceDefinitionsTable(db);
    return new DbResourceStore(db, "recipe", { description: "", flow: "default" });
  }
  return new FileRecipeStore({
    builtinDir: join(resolveStoreBaseDir(), "recipes"),
    userDir: join(config.arkDir, "recipes"),
  });
}

function makeRuntimeStore(db: IDatabase, config: ArkConfig) {
  if (isHosted(config)) {
    initResourceDefinitionsTable(db);
    return new DbResourceStore(db, "runtime", { description: "", type: "cli-agent", command: [] });
  }
  return new FileRuntimeStore({
    builtinDir: join(resolveStoreBaseDir(), "runtimes"),
    userDir: join(config.arkDir, "runtimes"),
  });
}
