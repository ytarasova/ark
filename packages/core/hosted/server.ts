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
import { logDebug } from "../observability/structured-log.js";

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
      webServer.stop();
      if (redisBus) {
        await redisBus.disconnect();
      }
      await app.shutdown();
    },
  };
}
