/**
 * JSON-RPC handlers for trigger CRUD.
 *
 * Methods:
 *   trigger/list    -> list configs for the caller's tenant
 *   trigger/get     -> fetch a single config by name
 *   trigger/enable  -> flip enabled=true (in-memory only for Phase 1)
 *   trigger/disable -> flip enabled=false
 *   trigger/reload  -> drop cached YAML; next list re-reads from disk
 *   trigger/sources -> list registered source connectors + status
 *   trigger/test    -> evaluate a sample payload against a trigger
 *                      without sending HTTP (dry-run for CLI `test` cmd)
 *
 * All methods read trigger configs via the file-backed store. Phase 1 does
 * not create/delete -- YAML in `triggers/` is the source of truth, and
 * enable/disable is ephemeral until the store is promoted to DB-backed.
 */

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { RpcError, ErrorCodes } from "../../protocol/types.js";
import {
  DefaultTriggerDispatcher,
  defaultMatcher,
  createDefaultRegistry,
  createFileTriggerStore,
  type FileTriggerStore,
  type TriggerSourceRegistry,
  type NormalizedEvent,
} from "../../core/triggers/index.js";
import { resolveStoreBaseDir } from "../../core/install-paths.js";
import { clearWebhookCaches } from "./webhooks.js";

const storeCache = new WeakMap<AppContext, FileTriggerStore>();
const registryCache = new WeakMap<AppContext, TriggerSourceRegistry>();

function getStore(app: AppContext): FileTriggerStore {
  let store = storeCache.get(app);
  if (!store) {
    store = createFileTriggerStore({
      arkDir: app.config.arkDir,
      builtinBaseDir: resolveStoreBaseDir(),
    });
    storeCache.set(app, store);
  }
  return store;
}

function getRegistry(app: AppContext): TriggerSourceRegistry {
  let reg = registryCache.get(app);
  if (!reg) {
    reg = createDefaultRegistry();
    registryCache.set(app, reg);
  }
  return reg;
}

export function registerTriggerHandlers(router: Router, app: AppContext): void {
  router.handle("trigger/list", async (params) => {
    const { tenant } = extract<{ tenant?: string }>(params, []);
    const store = getStore(app);
    const t = tenant ?? currentTenant(app);
    return { triggers: store.list(t) };
  });

  router.handle("trigger/get", async (params) => {
    const { name, tenant } = extract<{ name: string; tenant?: string }>(params, ["name"]);
    const store = getStore(app);
    const t = tenant ?? currentTenant(app);
    const cfg = store.get(name, t);
    if (!cfg) throw new RpcError(`Trigger ${name} not found`, ErrorCodes.SESSION_NOT_FOUND);
    return { trigger: cfg };
  });

  router.handle("trigger/enable", async (params) => {
    const { name, tenant } = extract<{ name: string; tenant?: string }>(params, ["name"]);
    const store = getStore(app);
    const t = tenant ?? currentTenant(app);
    const ok = store.enable(name, true, t);
    if (!ok) throw new RpcError(`Trigger ${name} not found`, ErrorCodes.SESSION_NOT_FOUND);
    return { ok: true, name, enabled: true, ephemeral: true };
  });

  router.handle("trigger/disable", async (params) => {
    const { name, tenant } = extract<{ name: string; tenant?: string }>(params, ["name"]);
    const store = getStore(app);
    const t = tenant ?? currentTenant(app);
    const ok = store.enable(name, false, t);
    if (!ok) throw new RpcError(`Trigger ${name} not found`, ErrorCodes.SESSION_NOT_FOUND);
    return { ok: true, name, enabled: false, ephemeral: true };
  });

  router.handle("trigger/reload", async () => {
    getStore(app).reload();
    clearWebhookCaches(app);
    return { ok: true };
  });

  router.handle("trigger/sources", async () => {
    return {
      sources: getRegistry(app)
        .list()
        .map((s) => ({
          name: s.name,
          label: s.label,
          status: s.status,
          secretEnvVar: s.secretEnvVar,
        })),
    };
  });

  router.handle("trigger/test", async (params) => {
    const { name, payload, headers, tenant, dryRun } = extract<{
      name: string;
      payload: unknown;
      headers?: Record<string, string>;
      tenant?: string;
      dryRun?: boolean;
    }>(params, ["name", "payload"]);
    const store = getStore(app);
    const t = tenant ?? currentTenant(app);
    const cfg = store.get(name, t);
    if (!cfg) throw new RpcError(`Trigger ${name} not found`, ErrorCodes.SESSION_NOT_FOUND);

    const event: NormalizedEvent = {
      source: cfg.source,
      event: cfg.event ?? "test",
      payload,
      receivedAt: Date.now(),
      sourceMeta: { synthetic: true, headers },
    };

    const fires = defaultMatcher.match(event, [cfg]);
    if (fires.length === 0 || dryRun) {
      return { ok: true, fired: fires.length > 0, dryRun: true, event };
    }

    const dispatcher = new DefaultTriggerDispatcher(app);
    const result = await dispatcher.dispatch({ event, config: cfg });
    return { ok: result.ok, fired: true, sessionId: result.sessionId, message: result.message };
  });
}

/** Resolve the tenant for the current RPC call. Phase 1: always "default". */
function currentTenant(_app: AppContext): string {
  // TODO: hook into extractTenantContext once trigger RPC is behind auth.
  return "default";
}
