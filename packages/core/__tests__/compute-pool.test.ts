import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";
import { ComputePoolManager } from "../compute/pool.js";

let app: AppContext;
beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});
afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

describe("ComputePoolManager", () => {
  it("creates a pool and retrieves it", () => {
    const manager = new ComputePoolManager(app);
    const pool = manager.createPool({
      name: "test-pool",
      provider: "ec2",
      min: 2,
      max: 10,
      config: { size: "m", region: "us-east-1" },
    });
    expect(pool.name).toBe("test-pool");
    expect(pool.provider).toBe("ec2");
    expect(pool.min).toBe(2);
    expect(pool.max).toBe(10);

    const retrieved = manager.getPool("test-pool");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe("test-pool");
    expect(retrieved!.config.size).toBe("m");
    expect(retrieved!.config.region).toBe("us-east-1");
  });

  it("returns null for nonexistent pool", () => {
    const manager = new ComputePoolManager(app);
    const pool = manager.getPool("nonexistent");
    expect(pool).toBeNull();
  });

  it("lists pools with utilization", () => {
    const manager = new ComputePoolManager(app);
    // Create another pool
    manager.createPool({
      name: "test-pool-2",
      provider: "docker",
      min: 0,
      max: 5,
      config: { image: "ubuntu:22.04" },
    });

    const pools = manager.listPools();
    expect(pools.length).toBeGreaterThanOrEqual(2);

    const dockerPool = pools.find((p) => p.name === "test-pool-2");
    expect(dockerPool).toBeDefined();
    expect(dockerPool!.provider).toBe("docker");
    expect(dockerPool!.active).toBe(0);
    expect(dockerPool!.available).toBe(0);
  });

  it("deletes a pool", () => {
    const manager = new ComputePoolManager(app);
    manager.createPool({
      name: "to-delete",
      provider: "local",
      min: 0,
      max: 1,
      config: {},
    });
    expect(manager.getPool("to-delete")).not.toBeNull();

    const deleted = manager.deletePool("to-delete");
    expect(deleted).toBe(true);
    expect(manager.getPool("to-delete")).toBeNull();
  });

  it("delete returns false for nonexistent pool", () => {
    const manager = new ComputePoolManager(app);
    const deleted = manager.deletePool("nonexistent");
    expect(deleted).toBe(false);
  });

  it("requestCompute throws for nonexistent pool", async () => {
    const manager = new ComputePoolManager(app);
    try {
      await manager.requestCompute("no-such-pool");
      expect(true).toBe(false); // should not reach
    } catch (e: any) {
      expect(e.message).toContain("not found");
    }
  });

  it("releaseCompute is a no-op for nonexistent pool", () => {
    const manager = new ComputePoolManager(app);
    // Should not throw
    manager.releaseCompute("nonexistent", "some-compute");
  });
});
