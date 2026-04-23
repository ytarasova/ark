/**
 * DI registrations for hosted-mode services.
 *
 * Hosted mode introduces two coordination components -- WorkerRegistry and
 * SessionScheduler -- that exist only when the control plane runs against a
 * real multi-tenant Postgres. In local mode these factories are never
 * registered; resolving them throws, which is exactly how
 * `app.workerRegistry` / `app.scheduler` signal "hosted mode only" to
 * callers.
 *
 * TenantPolicyManager is registered unconditionally in `di/persistence.ts`
 * -- the local CLI and handlers can still set / read tenant policies
 * against the local SQLite DB.
 *
 * Registration gates on `cradle.mode.kind === "hosted"`. `buildContainer()`
 * calls `registerHosted` unconditionally; the function itself makes the
 * mode decision so the call site stays declarative.
 */

import { asFunction, Lifetime } from "awilix";
import type { AppContainer } from "../container.js";
import type { AppContext } from "../app.js";
import type { DatabaseAdapter } from "../database/index.js";
import type { AppMode } from "../modes/app-mode.js";
import type { TenantPolicyManager } from "../auth/index.js";
import { WorkerRegistry } from "../hosted/worker-registry.js";
import { SessionScheduler } from "../hosted/scheduler.js";

/**
 * Register hosted-mode coordination services (WorkerRegistry,
 * SessionScheduler) as singleton factories.
 *
 * In local mode the factories are not registered at all; resolving
 * `workerRegistry` / `sessionScheduler` throws and the AppContext
 * accessors wrap that into "hosted mode only".
 *
 * SessionScheduler depends on both the AppContext and the TenantPolicyManager
 * (registered in `di/persistence.ts`). The factory attaches the policy
 * manager eagerly so schedulers resolved from the cradle are fully wired
 * without an extra `setX` step.
 */
export function registerHosted(container: AppContainer): void {
  const mode = container.cradle.mode as AppMode;
  if (mode.kind !== "hosted") return;

  container.register({
    workerRegistry: asFunction((c: { db: DatabaseAdapter }) => new WorkerRegistry(c.db), {
      lifetime: Lifetime.SINGLETON,
    }),

    sessionScheduler: asFunction(
      (c: { app: AppContext; tenantPolicyManager: TenantPolicyManager }) => {
        const scheduler = new SessionScheduler(c.app);
        scheduler.setPolicyManager(c.tenantPolicyManager);
        return scheduler;
      },
      { lifetime: Lifetime.SINGLETON },
    ),
  });
}
