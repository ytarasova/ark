/**
 * Tenant-scoped AppContext helpers.
 *
 * `forTenant()` returns a shallow copy of the parent AppContext whose DI
 * container is a child scope of the parent's. Tenant-scoped repositories
 * (with `setTenant(tenantId)` already applied) are registered on the child
 * scope, together with scoped re-registrations of every core service whose
 * dep graph closes over a tenant-sensitive repo (dispatch, lifecycle, hooks,
 * stage-advance, history, session, compute). Everything else (providers,
 * infra launchers, pricing, ...) falls through to the parent scope's
 * singleton registrations.
 *
 * Why awilix `createScope()` instead of manual `new X(db)`? The old code
 * constructed each repo with `new SessionRepository(db)`, bypassing the DI
 * container's factory. Any repo that gained a new constructor dependency
 * (e.g. config, mode, drizzle client) silently lost it in the tenant scope
 * because `buildTenantScope` only passed `db`. Routing through the child
 * scope means the child's factory invocations pick up every dep the parent
 * factory declared, so adding a dep to a repo can never again skip the
 * tenant-scope path.
 *
 * Why re-register services as SCOPED? Awilix `strict: true` resolves
 * SINGLETON deps through the parent scope. If services stayed SINGLETON,
 * `tenantApp.dispatchService === rootApp.dispatchService` and every "tenant"
 * call would land in default-tenant repos. SCOPED forces a fresh construction
 * per child container, and registering `app: asValue(scoped)` on the child
 * makes every callback that closes over `c.app` route through the child
 * scope too.
 */
import { asFunction, asValue, Lifetime } from "awilix";
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
import type { PricingRegistry } from "./observability/pricing.js";
import { registerServices } from "./di/services.js";

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

  // Services must see the TENANT-SCOPED AppContext, not the root. Registering
  // `app: asValue(scoped)` on the child container shadows the parent's
  // `asValue(root)`, so every service factory below (invoked via
  // `registerServices(..., Lifetime.SCOPED)`) receives `c.app === scoped`.
  // Callbacks like `c.app.dispatchService.dispatch(id)` then route through
  // the child scope, so repo reads/writes land in the right tenant. Without
  // this, awilix `strict: true` resolves `app` (a SINGLETON value) through
  // the parent, binding services back to default-tenant repos.
  childContainer.register({ app: asValue(scoped) });

  // Re-register every core service as SCOPED on the child container. Shares
  // the exact factory list in `di/services.ts` so adding a service dep can
  // never silently bypass the tenant scope. Each factory reads deps from the
  // child cradle -- which now resolves repos from `childContainer.register`
  // above and `app` from `asValue(scoped)` just above.
  registerServices(childContainer, Lifetime.SCOPED);

  return scoped;
}
