import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { WorkerRegistry, type WorkerNode } from "../hosted/worker-registry.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

describe("WorkerRegistry", async () => {
  it("creates the workers table on construction", async () => {
    const registry = new WorkerRegistry(app.db);
    const workers = await registry.list();
    expect(workers).toEqual([]);
  });

  it("registers a worker and retrieves it", async () => {
    const registry = new WorkerRegistry(app.db);
    await registry.register({
      id: "w-1",
      url: "http://host1:19300",
      capacity: 5,
      compute_name: null,
      tenant_id: null,
      metadata: { region: "us-east-1" },
    });

    const workers = await registry.list();
    expect(workers.length).toBe(1);
    expect(workers[0].id).toBe("w-1");
    expect(workers[0].url).toBe("http://host1:19300");
    expect(workers[0].status).toBe("online");
    expect(workers[0].capacity).toBe(5);
    expect(workers[0].active_sessions).toBe(0);
    expect(workers[0].metadata).toEqual({ region: "us-east-1" });
  });

  it("re-registers an existing worker (upsert)", async () => {
    const registry = new WorkerRegistry(app.db);
    // First registration
    await registry.register({
      id: "w-upsert",
      url: "http://host-old:19300",
      capacity: 3,
      compute_name: null,
      tenant_id: null,
      metadata: {},
    });

    // Re-register with new URL
    await registry.register({
      id: "w-upsert",
      url: "http://host-new:19300",
      capacity: 10,
      compute_name: "gpu-pool",
      tenant_id: null,
      metadata: { updated: true },
    });

    const worker = await registry.get("w-upsert");
    expect(worker).not.toBeNull();
    expect(worker!.url).toBe("http://host-new:19300");
    expect(worker!.capacity).toBe(10);
    expect(worker!.compute_name).toBe("gpu-pool");
    expect(worker!.status).toBe("online");
  });

  it("heartbeat updates last_heartbeat and marks online", async () => {
    const registry = new WorkerRegistry(app.db);
    await registry.register({
      id: "w-hb",
      url: "http://host-hb:19300",
      capacity: 5,
      compute_name: null,
      tenant_id: null,
      metadata: {},
    });

    const before = (await registry.get("w-hb"))!.last_heartbeat;

    // Small delay to ensure time difference
    const hbTime = new Date(Date.now() + 1000).toISOString();
    await registry.heartbeat("w-hb");

    const after = await registry.get("w-hb")!;
    expect(after.status).toBe("online");
    expect(after.last_heartbeat >= before).toBe(true);
  });

  it("deregisters a worker", async () => {
    const registry = new WorkerRegistry(app.db);
    await registry.register({
      id: "w-del",
      url: "http://host-del:19300",
      capacity: 5,
      compute_name: null,
      tenant_id: null,
      metadata: {},
    });

    expect(await registry.get("w-del")).not.toBeNull();
    registry.deregister("w-del");
    expect(await registry.get("w-del")).toBeNull();
  });

  it("lists workers filtered by status", async () => {
    const registry = new WorkerRegistry(app.db);
    await registry.register({
      id: "w-online",
      url: "http://online:19300",
      capacity: 5,
      compute_name: null,
      tenant_id: null,
      metadata: {},
    });

    // Mark it offline manually for testing
    app.db.prepare("UPDATE workers SET status = 'offline' WHERE id = 'w-online'").run();

    const online = await registry.list({ status: "online" });
    const offline = await registry.list({ status: "offline" });
    expect(offline.some((w) => w.id === "w-online")).toBe(true);
    expect(online.some((w) => w.id === "w-online")).toBe(false);
  });

  it("lists workers filtered by tenant", async () => {
    const registry = new WorkerRegistry(app.db);
    await registry.register({
      id: "w-tenant-a",
      url: "http://ta:19300",
      capacity: 5,
      compute_name: null,
      tenant_id: "tenant-a",
      metadata: {},
    });
    await registry.register({
      id: "w-tenant-b",
      url: "http://tb:19300",
      capacity: 5,
      compute_name: null,
      tenant_id: "tenant-b",
      metadata: {},
    });
    await registry.register({
      id: "w-shared",
      url: "http://shared:19300",
      capacity: 5,
      compute_name: null,
      tenant_id: null,
      metadata: {},
    });

    const forA = await registry.list({ tenantId: "tenant-a" });
    // Should include tenant-a workers + shared (null tenant) workers
    expect(forA.some((w) => w.id === "w-tenant-a")).toBe(true);
    expect(forA.some((w) => w.id === "w-shared")).toBe(true);
    expect(forA.some((w) => w.id === "w-tenant-b")).toBe(false);
  });

  it("getAvailable returns only online workers below capacity", async () => {
    const registry = new WorkerRegistry(app.db);
    await registry.register({
      id: "w-avail-1",
      url: "http://avail1:19300",
      capacity: 2,
      compute_name: null,
      tenant_id: null,
      metadata: {},
    });

    // Fill to capacity
    registry.incrementSessions("w-avail-1");
    registry.incrementSessions("w-avail-1");

    const available = registry.getAvailable();
    expect(available.some((w) => w.id === "w-avail-1")).toBe(false);
  });

  it("getAvailable filters by compute_name", async () => {
    const registry = new WorkerRegistry(app.db);
    await registry.register({
      id: "w-gpu-1",
      url: "http://gpu1:19300",
      capacity: 5,
      compute_name: "gpu-cluster",
      tenant_id: null,
      metadata: {},
    });
    await registry.register({
      id: "w-cpu-1",
      url: "http://cpu1:19300",
      capacity: 5,
      compute_name: "cpu-pool",
      tenant_id: null,
      metadata: {},
    });

    const gpuWorkers = registry.getAvailable({ computeName: "gpu-cluster" });
    expect(gpuWorkers.some((w) => w.id === "w-gpu-1")).toBe(true);
    expect(gpuWorkers.some((w) => w.id === "w-cpu-1")).toBe(false);
  });

  it("getLeastLoaded picks the worker with lowest load ratio", async () => {
    const registry = new WorkerRegistry(app.db);

    // Clean all workers from previous tests to get deterministic results
    app.db.prepare("DELETE FROM workers").run();

    await registry.register({
      id: "w-ll-heavy",
      url: "http://heavy:19300",
      capacity: 5,
      compute_name: null,
      tenant_id: null,
      metadata: {},
    });
    await registry.register({
      id: "w-ll-light",
      url: "http://light:19300",
      capacity: 10,
      compute_name: null,
      tenant_id: null,
      metadata: {},
    });

    // Add load to heavy worker
    registry.incrementSessions("w-ll-heavy");
    registry.incrementSessions("w-ll-heavy");
    registry.incrementSessions("w-ll-heavy");
    registry.incrementSessions("w-ll-heavy"); // 4/5 = 80%

    // Add minimal load to light worker
    registry.incrementSessions("w-ll-light"); // 1/10 = 10%

    const best = registry.getLeastLoaded();
    expect(best).not.toBeNull();
    expect(best!.id).toBe("w-ll-light");
  });

  it("incrementSessions and decrementSessions", async () => {
    const registry = new WorkerRegistry(app.db);
    await registry.register({
      id: "w-count",
      url: "http://count:19300",
      capacity: 10,
      compute_name: null,
      tenant_id: null,
      metadata: {},
    });

    expect((await registry.get("w-count"))!.active_sessions).toBe(0);

    registry.incrementSessions("w-count");
    registry.incrementSessions("w-count");
    expect((await registry.get("w-count"))!.active_sessions).toBe(2);

    registry.decrementSessions("w-count");
    expect((await registry.get("w-count"))!.active_sessions).toBe(1);

    // Decrement below zero should clamp to 0
    registry.decrementSessions("w-count");
    registry.decrementSessions("w-count");
    expect((await registry.get("w-count"))!.active_sessions).toBe(0);
  });

  it("pruneStale marks old workers as offline", async () => {
    const registry = new WorkerRegistry(app.db);
    await registry.register({
      id: "w-stale",
      url: "http://stale:19300",
      capacity: 5,
      compute_name: null,
      tenant_id: null,
      metadata: {},
    });

    // Set heartbeat to 2 minutes ago
    const old = new Date(Date.now() - 120_000).toISOString();
    app.db.prepare("UPDATE workers SET last_heartbeat = ? WHERE id = 'w-stale'").run(old);

    const pruned = await registry.pruneStale(90_000); // 90s timeout
    expect(pruned).toBeGreaterThanOrEqual(1);

    const worker = await registry.get("w-stale")!;
    expect(worker.status).toBe("offline");
  });

  it("get returns null for nonexistent worker", async () => {
    const registry = new WorkerRegistry(app.db);
    expect(await registry.get("nonexistent")).toBeNull();
  });
});
