import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { asValue } from "awilix";
import { AppContext } from "../app.js";
import { WorkerRegistry } from "../hosted/worker-registry.js";
import { SessionScheduler } from "../hosted/scheduler.js";
import { TenantPolicyManager } from "../auth/index.js";
import { mockSession } from "./test-helpers.js";

let app: AppContext;
let registry: WorkerRegistry;
let pm: TenantPolicyManager;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();

  // Hosted services are only auto-registered in hosted mode. Tests run
  // against a local SQLite profile, so register test doubles directly on
  // the container (see packages/core/di/hosted.ts for production wiring).
  registry = new WorkerRegistry(app.db);
  app.container.register({ workerRegistry: asValue(registry) });

  pm = new TenantPolicyManager(app.db);
  app.container.register({ tenantPolicyManager: asValue(pm) });

  const scheduler = new SessionScheduler(app);
  scheduler.setPolicyManager(pm);
  app.container.register({ sessionScheduler: asValue(scheduler) });
});

afterAll(async () => {
  await app?.shutdown();
});

describe("SessionScheduler with tenant policies", async () => {
  it("rejects dispatch when provider is not allowed for tenant", async () => {
    // Set up a policy that only allows k8s
    await pm.setPolicy({
      tenant_id: "strict-tenant",
      allowed_providers: ["k8s"],
      default_provider: "k8s",
      max_concurrent_sessions: 10,
      max_cost_per_day_usd: null,
      compute_pools: [],
    });

    // Create a compute record with ec2 provider
    await app.computeService.create({
      name: "ec2-box",
      compute: "ec2",
      isolation: "direct" as any,
      config: {},
    });

    // Register a worker for that compute
    await registry.register({
      id: "w-ec2-policy",
      url: "http://ec2:19300",
      capacity: 5,
      compute_name: "ec2-box",
      tenant_id: null,
      metadata: {},
    });

    // Session requests the ec2 compute
    const session = mockSession({
      id: "s-ec2-rejected",
      compute_name: "ec2-box",
    });

    const scheduler = new SessionScheduler(app);
    scheduler.setPolicyManager(pm);

    (await expect(scheduler.schedule(session, "strict-tenant"))).rejects.toThrow(
      'Provider "ec2" not allowed for tenant "strict-tenant"',
    );
  });

  it("uses default provider from tenant policy", async () => {
    await pm.setPolicy({
      tenant_id: "default-prov-tenant",
      allowed_providers: ["k8s", "ec2"],
      default_provider: "k8s",
      max_concurrent_sessions: 10,
      max_cost_per_day_usd: null,
      compute_pools: [],
    });

    // Register a k8s worker
    await registry.register({
      id: "w-k8s-default",
      url: "http://k8s:19300",
      capacity: 5,
      compute_name: "k8s",
      tenant_id: null,
      metadata: {},
    });

    // Session without a specific compute -- should use tenant's default provider
    const session = mockSession({ id: "s-default-prov" });

    const scheduler = new SessionScheduler(app);
    scheduler.setPolicyManager(pm);

    const worker = await scheduler.schedule(session, "default-prov-tenant");
    expect(worker.id).toBe("w-k8s-default");
  });

  it("allows dispatch when provider is in allowed list", async () => {
    await pm.setPolicy({
      tenant_id: "multi-prov-tenant",
      allowed_providers: ["k8s", "ec2", "docker"],
      default_provider: "ec2",
      max_concurrent_sessions: 10,
      max_cost_per_day_usd: null,
      compute_pools: [],
    });

    // Register an ec2 worker
    await registry.register({
      id: "w-ec2-allowed",
      url: "http://ec2-ok:19300",
      capacity: 5,
      compute_name: "ec2",
      tenant_id: null,
      metadata: {},
    });

    const session = mockSession({ id: "s-ec2-allowed" });

    const scheduler = new SessionScheduler(app);
    scheduler.setPolicyManager(pm);

    const worker = await scheduler.schedule(session, "multi-prov-tenant");
    expect(worker).toBeTruthy();
    expect(worker.id).toBe("w-ec2-allowed");
  });

  it("allows all providers when allowed_providers is empty", async () => {
    await pm.setPolicy({
      tenant_id: "open-tenant",
      allowed_providers: [],
      default_provider: "k8s",
      max_concurrent_sessions: 10,
      max_cost_per_day_usd: null,
      compute_pools: [],
    });

    // Clean workers and add a fresh one
    app.db.prepare("DELETE FROM workers WHERE id = 'w-any-provider'").run();
    await registry.register({
      id: "w-any-provider",
      url: "http://any:19300",
      capacity: 5,
      compute_name: "k8s",
      tenant_id: null,
      metadata: {},
    });

    const session = mockSession({ id: "s-open" });

    const scheduler = new SessionScheduler(app);
    scheduler.setPolicyManager(pm);

    const worker = await scheduler.schedule(session, "open-tenant");
    expect(worker).toBeTruthy();
  });

  it("works without policy manager (backward compat)", async () => {
    // Clean workers
    app.db.prepare("DELETE FROM workers").run();

    await registry.register({
      id: "w-no-policy",
      url: "http://nopol:19300",
      capacity: 5,
      compute_name: null,
      tenant_id: null,
      metadata: {},
    });

    const session = mockSession({ id: "s-no-policy" });

    // Scheduler without policy manager
    const scheduler = new SessionScheduler(app);

    const worker = await scheduler.schedule(session, "any-tenant");
    expect(worker).toBeTruthy();
    expect(worker.id).toBe("w-no-policy");
  });

  it("scheduler is accessible via app.scheduler with policy manager wired", () => {
    expect(() => app.scheduler).not.toThrow();
    expect(app.scheduler).toBeInstanceOf(SessionScheduler);
  });

  it("tenant policy manager is accessible via app.tenantPolicyManager", () => {
    expect(app.tenantPolicyManager).not.toBeNull();
    expect(app.tenantPolicyManager).toBeInstanceOf(TenantPolicyManager);
  });
});
