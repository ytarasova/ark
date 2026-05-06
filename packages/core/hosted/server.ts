/**
 * Hosted entry point -- starts Ark as a multi-tenant control plane
 * with worker registry, session scheduler, and optional Redis SSE bus.
 *
 * Usage:
 *   import { startHostedServer } from "./hosted.js";
 *   const { app, stop } = await startHostedServer(config);
 */

import type { ArkConfig } from "../config.js";
import { AppContext } from "../app.js";
import { logDebug, logInfo } from "../observability/structured-log.js";

export async function startHostedServer(config: ArkConfig): Promise<{
  app: AppContext;
  stop: () => Promise<void>;
}> {
  const app = new AppContext(config, {
    skipConductor: false,
    skipMetrics: false,
    skipSignals: false,
  });
  await app.boot();

  // Warm the DbResourceStore caches for agents and runtimes. DbResourceStore.get()
  // returns a Promise on a cold cache, which resolveAgent (sync) treats as a
  // truthy non-null object, corrupting the AgentDefinition. Awaiting list()
  // populates the sync cache so all subsequent sync .get() calls return real values.
  try {
    const defaultTenant = config.authSection.defaultTenant ?? "default";
    const tenantApp = app.forTenant(defaultTenant);
    await (tenantApp.agents as any).list?.();
    await (tenantApp.runtimes as any).list?.();
    logInfo("web", "agent/runtime caches warmed for tenant: " + defaultTenant);
  } catch (err: any) {
    logInfo("web", "cache warm failed (non-fatal): " + (err?.message ?? err));
  }

  // WorkerRegistry / TenantPolicyManager / SessionScheduler are registered
  // in the DI container via `registerHosted(container)` (gated on hosted
  // mode). Resolve them once to force eager construction so the periodic
  // health checker below has a registry to prune. The scheduler factory
  // attaches the policy manager automatically.
  const { workerRegistry: registry } = app.container.cradle;
  // Force-resolve the other hosted services so they're fully wired and
  // any construction errors surface synchronously during boot rather than
  // at first request.
  void app.container.cradle.tenantPolicyManager;
  void app.container.cradle.sessionScheduler;

  // Start SSE bus (Redis if configured, in-memory otherwise)
  let redisBus: import("./sse-redis.js").RedisSSEBus | null = null;
  if (config.redisUrl) {
    const { RedisSSEBus } = await import("./sse-redis.js");
    redisBus = new RedisSSEBus(config.redisUrl);
    await redisBus.connect();
  }

  // Start web server
  const { startWebServer } = await import("./web.js");
  const webServer = startWebServer(app, { port: config.ports.web });

  // Start worker health checker (prune stale workers every 60s)
  const healthInterval = setInterval(() => {
    void registry.pruneStale(90_000); // 90s timeout
  }, 60_000);

  // Dispatch poller: pick up any sessions that are `ready` but haven't been
  // dispatched yet. This covers the gap where the per-scope sessionService
  // listener chain doesn't reach the root dispatchService (each forTenant()
  // creates a fresh child scope with its own SessionDispatchListeners, so
  // registerDefaultDispatcher on the root app doesn't propagate). Runs every
  // 2 seconds so the dev loop doesn't feel laggy.
  const dispatchInterval = setInterval(() => {
    void (async () => {
      try {
        // Root app.sessions has no tenant set -- use listAcrossTenants
        // to see sessions from all tenants.
        const ready = await app.sessions.listAcrossTenants({ status: "ready", limit: 20 });
        for (const s of ready) {
          const tenantApp = s.tenant_id ? app.forTenant(s.tenant_id) : app;
          // Warm agent/runtime caches for this tenant scope so resolveAgent
          // (which is sync) doesn't see a Promise instead of an AgentDefinition.
          await (tenantApp.agents as any).list?.().catch(() => {});
          await (tenantApp.runtimes as any).list?.().catch(() => {});
          void tenantApp.dispatchService.dispatch(s.id).catch((err: Error) => {
            logInfo("web", `dispatch poller: ${s.id} failed: ${err?.message ?? err}`);
          });
        }
      } catch (err: any) {
        logInfo("web", `dispatch poller error: ${err?.message ?? err}`);
      }
    })();
  }, 10_000);

  // Start LLM router if configured
  if (config.router.enabled) {
    try {
      const { startRouter } = await import("../../router/server.js");
      startRouter(config.router as unknown as import("../../router/types.js").RouterConfig);
    } catch {
      logDebug("web", "Router module not available - skip");
    }
  }

  return {
    app,
    stop: async () => {
      clearInterval(healthInterval);
      clearInterval(dispatchInterval);
      webServer.stop();
      if (redisBus) {
        await redisBus.disconnect();
      }
      await app.shutdown();
    },
  };
}
