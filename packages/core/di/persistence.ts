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
import type { DatabaseAdapter } from "../database/index.js";
import type { ArkConfig } from "../config.js";
import type { AppMode } from "../modes/app-mode.js";
import { resolveStoreBaseDir } from "../install-paths.js";
import {
  SessionRepository,
  ComputeRepository,
  ComputeTemplateRepository,
  EventRepository,
  MessageRepository,
  TodoRepository,
  ArtifactRepository,
  FlowStateRepository,
  LedgerRepository,
} from "../repositories/index.js";
import { ApiKeyManager, TenantManager, TeamManager, UserManager, TenantPolicyManager } from "../auth/index.js";
import { TenantClaudeAuthManager } from "../auth/tenant-claude-auth.js";
import {
  FileFlowStore,
  FileSkillStore,
  FileAgentStore,
  FileRuntimeStore,
  FileModelStore,
  EphemeralFlowStore,
} from "../stores/index.js";
import type { ModelStore } from "../stores/model-store.js";
import { DbResourceStore, initResourceDefinitionsTable } from "../stores/db-resource-store.js";
import { WorkspaceStore } from "../workspace/store.js";

/**
 * Register the database under `db`. The DB is provided by the caller because
 * opening it is async (SQLite vs Postgres) and must happen before schema init.
 * We register a disposer so `container.dispose()` closes the connection.
 */
export function registerDatabase(container: AppContainer, db: DatabaseAdapter): void {
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
      (c: { db: DatabaseAdapter; config: ArkConfig }) => {
        const repo = new SessionRepository(c.db);
        repo.setChannelBounds(c.config.channels.basePort, c.config.channels.range);
        return repo;
      },
      { lifetime: Lifetime.SINGLETON },
    ),

    computes: asFunction((c: { db: DatabaseAdapter }) => new ComputeRepository(c.db), { lifetime: Lifetime.SINGLETON }),

    computeTemplates: asFunction((c: { db: DatabaseAdapter }) => new ComputeTemplateRepository(c.db), {
      lifetime: Lifetime.SINGLETON,
    }),

    events: asFunction((c: { db: DatabaseAdapter }) => new EventRepository(c.db), { lifetime: Lifetime.SINGLETON }),
    messages: asFunction((c: { db: DatabaseAdapter }) => new MessageRepository(c.db), { lifetime: Lifetime.SINGLETON }),
    todos: asFunction((c: { db: DatabaseAdapter }) => new TodoRepository(c.db), { lifetime: Lifetime.SINGLETON }),
    artifacts: asFunction((c: { db: DatabaseAdapter }) => new ArtifactRepository(c.db), {
      lifetime: Lifetime.SINGLETON,
    }),
    flowStates: asFunction((c: { db: DatabaseAdapter }) => new FlowStateRepository(c.db), {
      lifetime: Lifetime.SINGLETON,
    }),
    ledger: asFunction((c: { db: DatabaseAdapter }) => new LedgerRepository(c.db), { lifetime: Lifetime.SINGLETON }),

    // Auth managers -- all six share the same shape: `new X(db)`. Registering
    // them as singletons means handler bodies resolve via `app.container.cradle.X`
    // (or the equivalent AppContext accessor) instead of `new X(app.db)` on
    // every request. Tests can inject fakes via
    // `container.register({ tenants: asValue(fake) })`.
    //
    // `tenantPolicyManager` is registered here (not in `di/hosted.ts`) so the
    // local-mode CLI + handlers can still set / read tenant policies against
    // the local SQLite DB -- useful for single-user installs that want to
    // experiment with router / auto-index policies without spinning up the
    // full hosted stack. `sessionScheduler` remains hosted-only because it
    // depends on the WorkerRegistry.
    apiKeys: asFunction((c: { db: DatabaseAdapter }) => new ApiKeyManager(c.db), { lifetime: Lifetime.SINGLETON }),
    tenants: asFunction((c: { db: DatabaseAdapter }) => new TenantManager(c.db), { lifetime: Lifetime.SINGLETON }),
    teams: asFunction((c: { db: DatabaseAdapter }) => new TeamManager(c.db), { lifetime: Lifetime.SINGLETON }),
    users: asFunction((c: { db: DatabaseAdapter }) => new UserManager(c.db), { lifetime: Lifetime.SINGLETON }),
    tenantClaudeAuth: asFunction((c: { db: DatabaseAdapter }) => new TenantClaudeAuthManager(c.db), {
      lifetime: Lifetime.SINGLETON,
    }),
    tenantPolicyManager: asFunction((c: { db: DatabaseAdapter }) => new TenantPolicyManager(c.db), {
      lifetime: Lifetime.SINGLETON,
    }),
  });
}

/**
 * Register resource stores (flows, skills, agents, recipes, runtimes).
 *
 * Two modes:
 *   - Local (SQLite / no Postgres URL): file-backed stores with three-tier
 *     resolution (builtin + user dirs).
 *   - Hosted (Postgres URL): DB-backed stores with tenant scoping.
 *
 * The factories receive `AppMode` from the cradle rather than re-sniffing
 * `config.database.url` themselves -- that decision is made exactly once
 * in `buildAppMode` and everyone downstream reads `mode.kind`.
 */
export function registerResourceStores(container: AppContainer): void {
  container.register({
    flows: asFunction(
      (c: { db: DatabaseAdapter; config: ArkConfig; mode: AppMode }) => makeFlowStore(c.db, c.config, c.mode),
      {
        lifetime: Lifetime.SINGLETON,
      },
    ),
    skills: asFunction(
      (c: { db: DatabaseAdapter; config: ArkConfig; mode: AppMode }) => makeSkillStore(c.db, c.config, c.mode),
      { lifetime: Lifetime.SINGLETON },
    ),
    agents: asFunction(
      (c: { db: DatabaseAdapter; config: ArkConfig; mode: AppMode; models: ModelStore }) =>
        makeAgentStore(c.db, c.config, c.mode, c.models),
      { lifetime: Lifetime.SINGLETON },
    ),
    runtimes: asFunction(
      (c: { db: DatabaseAdapter; config: ArkConfig; mode: AppMode }) => makeRuntimeStore(c.db, c.config, c.mode),
      { lifetime: Lifetime.SINGLETON },
    ),
    models: asFunction((c: { config: ArkConfig }) => makeModelStore(c.config), { lifetime: Lifetime.SINGLETON }),
    workspaces: asFunction((c: { db: DatabaseAdapter }) => new WorkspaceStore(c.db), {
      lifetime: Lifetime.SINGLETON,
    }),
  });
}

// ── Factory helpers ─────────────────────────────────────────────────────────

function makeFlowStore(db: DatabaseAdapter, config: ArkConfig, mode: AppMode) {
  if (mode.kind === "hosted") {
    initResourceDefinitionsTable(db);
    return new EphemeralFlowStore(new DbResourceStore(db, "flow", { stages: [] }));
  }
  return new EphemeralFlowStore(
    new FileFlowStore({
      builtinDir: join(resolveStoreBaseDir(), "flows", "definitions"),
      userDir: join(config.dirs.ark, "flows"),
    }),
  );
}

function makeSkillStore(db: DatabaseAdapter, config: ArkConfig, mode: AppMode) {
  if (mode.kind === "hosted") {
    initResourceDefinitionsTable(db);
    return new DbResourceStore(db, "skill", { description: "", content: "" });
  }
  return new FileSkillStore({
    builtinDir: join(resolveStoreBaseDir(), "skills"),
    userDir: join(config.dirs.ark, "skills"),
  });
}

function makeAgentStore(db: DatabaseAdapter, config: ArkConfig, mode: AppMode, models: ModelStore) {
  if (mode.kind === "hosted") {
    initResourceDefinitionsTable(db);
    // `model` default comes from the catalog (alias "sonnet") rather than a
    // hardcoded string. A fresh install with an empty catalog throws here
    // by design -- a missing catalog is a broken install, not a data state
    // we want to paper over with a stale slug.
    return new DbResourceStore(db, "agent", {
      description: "",
      model: models.default().id,
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
    userDir: join(config.dirs.ark, "agents"),
  });
}

function makeRuntimeStore(db: DatabaseAdapter, config: ArkConfig, mode: AppMode) {
  if (mode.kind === "hosted") {
    initResourceDefinitionsTable(db);
    return new DbResourceStore(db, "runtime", { description: "", type: "cli-agent", command: [] });
  }
  return new FileRuntimeStore({
    builtinDir: join(resolveStoreBaseDir(), "runtimes"),
    userDir: join(config.dirs.ark, "runtimes"),
  });
}

/**
 * Model catalog is file-only (never DB-backed). Hosted mode still reads from
 * the shipped YAMLs: model definitions are the user-invariant technical
 * catalog (provider slugs, pricing) -- not tenant content -- so there's
 * nothing tenant-scoped to store.
 */
function makeModelStore(config: ArkConfig) {
  return new FileModelStore({
    builtinDir: join(resolveStoreBaseDir(), "models"),
    userDir: join(config.dirs.ark, "models"),
  });
}
