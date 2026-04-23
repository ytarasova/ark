/**
 * Regression tests for `registerHosted(container)`.
 *
 * Verifies that hosted-mode coordination services (WorkerRegistry,
 * TenantPolicyManager, SessionScheduler) are wired through the DI
 * container rather than bolted on via deleted `setXxx` methods, and
 * that test doubles installed via `container.register({ X: asValue(...) })`
 * intercept downstream resolution.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { asValue } from "awilix";
import { AppContext } from "../app.js";
import { WorkerRegistry } from "../hosted/worker-registry.js";
import { SessionScheduler } from "../hosted/scheduler.js";
import { TenantPolicyManager } from "../auth/index.js";

let app: AppContext | null = null;

afterEach(async () => {
  if (app) {
    await app.shutdown();
    app = null;
  }
});

describe("registerHosted (DI-1)", async () => {
  it("local mode: workerRegistry + scheduler are NOT auto-registered", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();

    // No factory for the hosted-only pair -- resolve throws, accessor
    // wraps into "hosted mode only".
    expect(() => app!.workerRegistry).toThrow("hosted mode only");
    expect(() => app!.scheduler).toThrow("hosted mode only");
  });

  it("local mode: tenantPolicyManager IS registered (shared local + hosted)", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();

    // TenantPolicyManager is registered unconditionally so the local CLI
    // + handlers can set / read policies against the SQLite DB.
    expect(app.tenantPolicyManager).not.toBeNull();
    expect(app.tenantPolicyManager).toBeInstanceOf(TenantPolicyManager);
  });

  it("local mode: test doubles via asValue override are resolvable", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();

    const registry = new WorkerRegistry(app.db);
    app.container.register({ workerRegistry: asValue(registry) });

    // Accessor now resolves the doubled value -- identity check confirms
    // the container actually hands back the same instance.
    expect(app.workerRegistry).toBe(registry);
  });

  it("local mode: policy manager double is resolvable and accessor returns it", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();

    const pm = new TenantPolicyManager(app.db);
    app.container.register({ tenantPolicyManager: asValue(pm) });

    expect(app.tenantPolicyManager).toBe(pm);
    expect(app.tenantPolicyManager).toBeInstanceOf(TenantPolicyManager);
  });

  it("local mode: scheduler double is resolvable and accessor returns it", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();

    const scheduler = new SessionScheduler(app);
    app.container.register({ sessionScheduler: asValue(scheduler) });

    expect(app.scheduler).toBe(scheduler);
    expect(app.scheduler).toBeInstanceOf(SessionScheduler);
  });
});
