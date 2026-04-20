import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { WorkerRegistry } from "../hosted/worker-registry.js";
import { SessionScheduler } from "../hosted/scheduler.js";
import { mockSession } from "./test-helpers.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();

  // Initialize worker registry and scheduler (normally done by hosted.ts)
  const registry = new WorkerRegistry(app.db);
  app.setWorkerRegistry(registry);
  const scheduler = new SessionScheduler(app);
  app.setScheduler(scheduler);
});

afterAll(async () => {
  await app?.shutdown();
});

describe("SessionScheduler", () => {
  it("throws when no workers are available", async () => {
    const scheduler = new SessionScheduler(app);
    const session = mockSession({ id: "s-no-worker" });

    await expect(scheduler.schedule(session)).rejects.toThrow("No workers available");
  });

  it("schedules to the least loaded worker", async () => {
    const registry = app.workerRegistry;
    const scheduler = new SessionScheduler(app);

    // Register two workers
    registry.register({
      id: "w-sched-1",
      url: "http://sched1:19300",
      capacity: 5,
      compute_name: null,
      tenant_id: null,
      metadata: {},
    });
    registry.register({
      id: "w-sched-2",
      url: "http://sched2:19300",
      capacity: 5,
      compute_name: null,
      tenant_id: null,
      metadata: {},
    });

    // Load up worker 1
    registry.incrementSessions("w-sched-1");
    registry.incrementSessions("w-sched-1");
    registry.incrementSessions("w-sched-1");

    const session = mockSession({ id: "s-sched-test" });
    const worker = await scheduler.schedule(session);

    // Should pick worker 2 (less loaded)
    expect(worker.id).toBe("w-sched-2");
  });

  it("schedules to a compute-specific worker when session has compute_name", async () => {
    const registry = app.workerRegistry;
    const scheduler = new SessionScheduler(app);

    registry.register({
      id: "w-gpu",
      url: "http://gpu:19300",
      capacity: 5,
      compute_name: "gpu-cluster",
      tenant_id: null,
      metadata: {},
    });
    registry.register({
      id: "w-general",
      url: "http://general:19300",
      capacity: 5,
      compute_name: "general",
      tenant_id: null,
      metadata: {},
    });

    const session = mockSession({
      id: "s-gpu-task",
      compute_name: "gpu-cluster",
    });

    const worker = await scheduler.schedule(session);
    expect(worker.id).toBe("w-gpu");
  });

  it("falls back to any available when compute-specific workers are full", async () => {
    const registry = app.workerRegistry;
    const scheduler = new SessionScheduler(app);

    registry.register({
      id: "w-specific-full",
      url: "http://specific:19300",
      capacity: 1,
      compute_name: "tiny",
      tenant_id: null,
      metadata: {},
    });
    registry.register({
      id: "w-fallback",
      url: "http://fallback:19300",
      capacity: 10,
      compute_name: null,
      tenant_id: null,
      metadata: {},
    });

    // Fill the specific worker
    registry.incrementSessions("w-specific-full");

    const session = mockSession({
      id: "s-fallback-test",
      compute_name: "tiny",
    });

    const worker = await scheduler.schedule(session);
    // Should fall back to any available worker
    expect(worker).toBeTruthy();
    expect(worker.active_sessions < worker.capacity).toBe(true);
  });

  it("is accessible via app.scheduler", () => {
    expect(() => app.scheduler).not.toThrow();
    expect(app.scheduler).toBeInstanceOf(SessionScheduler);
  });

  it("app.workerRegistry is accessible", () => {
    expect(() => app.workerRegistry).not.toThrow();
    expect(app.workerRegistry).toBeInstanceOf(WorkerRegistry);
  });
});

describe("AppContext hosted mode guards", () => {
  it("throws when accessing workerRegistry without initialization", async () => {
    const bareApp = await AppContext.forTestAsync();
    await bareApp.boot();

    expect(() => bareApp.workerRegistry).toThrow("hosted mode only");
    expect(() => bareApp.scheduler).toThrow("hosted mode only");

    await bareApp.shutdown();
  });
});
