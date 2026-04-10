/**
 * Hosted entry point -- starts Ark as a multi-tenant control plane
 * with worker registry, session scheduler, and optional Redis SSE bus.
 *
 * Usage:
 *   import { startHostedServer } from "./hosted.js";
 *   const { app, stop } = await startHostedServer(config);
 */

import type { ArkConfig } from "./config.js";
import { AppContext, setApp } from "./app.js";
import { WorkerRegistry } from "./worker-registry.js";
import { SessionScheduler } from "./scheduler.js";
import { TenantPolicyManager } from "./auth/index.js";

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
  setApp(app);

  // Initialize worker registry
  const registry = new WorkerRegistry(app.db);
  app.setWorkerRegistry(registry);

  // Initialize tenant policy manager
  const policyManager = new TenantPolicyManager(app.db);
  app.setTenantPolicyManager(policyManager);

  // Initialize scheduler with tenant policy enforcement
  const scheduler = new SessionScheduler(app);
  scheduler.setPolicyManager(policyManager);
  app.setScheduler(scheduler);

  // Start SSE bus (Redis if configured, in-memory otherwise)
  let redisBus: import("./sse-redis.js").RedisSSEBus | null = null;
  if (config.redisUrl) {
    const { RedisSSEBus } = await import("./sse-redis.js");
    redisBus = new RedisSSEBus(config.redisUrl);
    await redisBus.connect();
  }

  // Start web server
  const { startWebServer } = await import("./web.js");
  const webServer = startWebServer(app, config);

  // Start worker health checker (prune stale workers every 60s)
  const healthInterval = setInterval(() => {
    registry.pruneStale(90_000); // 90s timeout
  }, 60_000);

  // Start LLM router if configured
  if (config.router?.enabled) {
    try {
      const { startRouter } = await import("../router/server.js");
      startRouter(config.router);
    } catch {
      // Router module not available - skip
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
