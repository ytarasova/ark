/**
 * Tenant-scoped AppContext helpers.
 *
 * `forTenant()` returns a shallow copy of the parent AppContext whose DI
 * container is a child scope of the parent's. Tenant-scoped repositories
 * (with `setTenant(tenantId)` already applied) are registered on the child
 * scope; everything else (providers, infra launchers, pricing, ...) falls
 * through to the parent scope's singleton registrations.
 *
 * Why awilix `createScope()` instead of manual `new X(db)`? The old code
 * constructed each repo with `new SessionRepository(db)`, bypassing the DI
 * container's factory. Any repo that gained a new constructor dependency
 * (e.g. config, mode, drizzle client) silently lost it in the tenant scope
 * because `buildTenantScope` only passed `db`. Routing through the child
 * scope means the child's factory invocations pick up every dep the parent
 * factory declared, so adding a dep to a repo can never again skip the
 * tenant-scope path.
 */
import { asFunction, Lifetime } from "awilix";
import type { AppContext } from "./app.js";
import type { AppContainer } from "./container.js";
import type { DatabaseAdapter } from "./database/index.js";
import type { ArkConfig } from "./config.js";
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
} from "./repositories/index.js";
import { KnowledgeStore } from "./knowledge/store.js";
import { DbResourceStore } from "./stores/db-resource-store.js";
import { UsageRecorder } from "./observability/usage.js";
import { ComputeService } from "./services/compute.js";
import type { PricingRegistry } from "./observability/pricing.js";

/**
 * Build a tenant-scoped AppContext. The returned object shadows every
 * tenant-aware registration (repos, usage recorder, compute service,
 * knowledge store, hosted resource stores) through a child scope of the
 * parent container. All other services (providers, infra launchers,
 * pricing, transcript parsers, plugins) resolve from the parent scope.
 */
export function buildTenantScope(parent: AppContext, tenantId: string): AppContext {
  const scoped = Object.create(parent) as AppContext;
  const childContainer = parent.container.createScope() as AppContainer;

  // Repositories -- each factory pulls `db` (and any future dep) from the
  // cradle and applies `setTenant()` before returning. The child scope's
  // Lifetime.SCOPED means the factory runs once per child container, and
  // the resulting instance is cached on the child so every
  // `scoped.sessions` call within this tenant scope returns the same
  // instance.
  childContainer.register({
    sessions: asFunction(
      (c: { db: DatabaseAdapter; config: ArkConfig }) => {
        const repo = new SessionRepository(c.db);
        repo.setChannelBounds(c.config.channels.basePort, c.config.channels.range);
        repo.setTenant(tenantId);
        return repo;
      },
      { lifetime: Lifetime.SCOPED },
    ),
    computes: asFunction(
      (c: { db: DatabaseAdapter }) => {
        const repo = new ComputeRepository(c.db);
        repo.setTenant(tenantId);
        return repo;
      },
      { lifetime: Lifetime.SCOPED },
    ),
    computeTemplates: asFunction(
      (c: { db: DatabaseAdapter }) => {
        const repo = new ComputeTemplateRepository(c.db);
        repo.setTenant(tenantId);
        return repo;
      },
      { lifetime: Lifetime.SCOPED },
    ),
    events: asFunction(
      (c: { db: DatabaseAdapter }) => {
        const repo = new EventRepository(c.db);
        repo.setTenant(tenantId);
        return repo;
      },
      { lifetime: Lifetime.SCOPED },
    ),
    messages: asFunction(
      (c: { db: DatabaseAdapter }) => {
        const repo = new MessageRepository(c.db);
        repo.setTenant(tenantId);
        return repo;
      },
      { lifetime: Lifetime.SCOPED },
    ),
    todos: asFunction(
      (c: { db: DatabaseAdapter }) => {
        const repo = new TodoRepository(c.db);
        repo.setTenant(tenantId);
        return repo;
      },
      { lifetime: Lifetime.SCOPED },
    ),
    artifacts: asFunction(
      (c: { db: DatabaseAdapter }) => {
        const repo = new ArtifactRepository(c.db);
        repo.setTenant(tenantId);
        return repo;
      },
      { lifetime: Lifetime.SCOPED },
    ),
    flowStates: asFunction(
      (c: { db: DatabaseAdapter }) => {
        const repo = new FlowStateRepository(c.db);
        repo.setTenant(tenantId);
        return repo;
      },
      { lifetime: Lifetime.SCOPED },
    ),
    ledger: asFunction(
      (c: { db: DatabaseAdapter }) => {
        const repo = new LedgerRepository(c.db);
        repo.setTenant(tenantId);
        return repo;
      },
      { lifetime: Lifetime.SCOPED },
    ),
    knowledge: asFunction(
      (c: { db: DatabaseAdapter }) => {
        const store = new KnowledgeStore(c.db);
        store.setTenant(tenantId);
        return store;
      },
      { lifetime: Lifetime.SCOPED },
    ),
    usageRecorder: asFunction(
      (c: { db: DatabaseAdapter; pricing: PricingRegistry }) => {
        const rec = new UsageRecorder(c.db, c.pricing);
        rec.setTenant(tenantId);
        return rec;
      },
      { lifetime: Lifetime.SCOPED },
    ),
    // ComputeService consumes the child-scope `computes` repo so writes
    // land in the tenant's rows. Awilix resolves the `computes` dep from
    // the same child scope, so a new ctor dep on ComputeService (or any
    // transitive dep on a repo) is picked up automatically.
    computeService: asFunction(
      (c: { computes: ComputeRepository; app: AppContext }) => new ComputeService(c.computes, c.app),
      { lifetime: Lifetime.SCOPED },
    ),
  });

  // Hosted-mode DB-backed resource stores. File-backed local stores are
  // shared across tenants (the local mode has no tenant concept above the
  // store boundary), so we only override in hosted mode. This check is at
  // DI composition time -- still safe under the AppMode invariant.
  if (parent.mode.kind === "hosted") {
    childContainer.register({
      agents: asFunction(
        (c: { db: DatabaseAdapter }) => {
          const store = new DbResourceStore(c.db, "agent", {
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
          store.setTenant(tenantId);
          return store;
        },
        { lifetime: Lifetime.SCOPED },
      ),
      flows: asFunction(
        (c: { db: DatabaseAdapter }) => {
          const store = new DbResourceStore(c.db, "flow", { stages: [] });
          store.setTenant(tenantId);
          return store;
        },
        { lifetime: Lifetime.SCOPED },
      ),
      skills: asFunction(
        (c: { db: DatabaseAdapter }) => {
          const store = new DbResourceStore(c.db, "skill", { description: "", content: "" });
          store.setTenant(tenantId);
          return store;
        },
        { lifetime: Lifetime.SCOPED },
      ),
      recipes: asFunction(
        (c: { db: DatabaseAdapter }) => {
          const store = new DbResourceStore(c.db, "recipe", { description: "", flow: "default" });
          store.setTenant(tenantId);
          return store;
        },
        { lifetime: Lifetime.SCOPED },
      ),
      runtimes: asFunction(
        (c: { db: DatabaseAdapter }) => {
          const store = new DbResourceStore(c.db, "runtime", {
            description: "",
            type: "cli-agent",
            command: [],
          });
          store.setTenant(tenantId);
          return store;
        },
        { lifetime: Lifetime.SCOPED },
      ),
    });
  }

  // Route every `this._resolve(...)` on the scoped context through the
  // child scope. AppContext reads `this._container` (a plain instance
  // field) inside `_resolve`; shadowing it via Object.defineProperty is
  // enough because `Object.create(parent)` only copies the prototype --
  // own-field writes land on `scoped`, not `parent`.
  Object.defineProperty(scoped, "_container", {
    value: childContainer,
    configurable: true,
    writable: true,
    enumerable: false,
  });
  Object.defineProperty(scoped, "container", {
    get: () => childContainer,
    configurable: true,
  });
  Object.defineProperty(scoped, "tenantId", {
    get: () => tenantId,
    configurable: true,
  });

  return scoped;
}
