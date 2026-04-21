import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { ComputePoolManager } from "../compute/pool.js";

let app: AppContext;
beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});
afterAll(async () => {
  await app?.shutdown();
});

describe("ComputePoolManager", async () => {
  it("creates a pool and retrieves it", async () => {
    const manager = new ComputePoolManager(app);
    const pool = await manager.createPool({
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

    const retrieved = await manager.getPool("test-pool");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe("test-pool");
    expect(retrieved!.config.size).toBe("m");
    expect(retrieved!.config.region).toBe("us-east-1");
  });

  it("returns null for nonexistent pool", async () => {
    const manager = new ComputePoolManager(app);
    const pool = await manager.getPool("nonexistent");
    expect(pool).toBeNull();
  });

  it("lists pools with utilization", async () => {
    const manager = new ComputePoolManager(app);
    // Create another pool
    await manager.createPool({
      name: "test-pool-2",
      provider: "docker",
      min: 0,
      max: 5,
      config: { image: "ubuntu:22.04" },
    });

    const pools = await manager.listPools();
    expect(pools.length).toBeGreaterThanOrEqual(2);

    const dockerPool = pools.find((p) => p.name === "test-pool-2");
    expect(dockerPool).toBeDefined();
    expect(dockerPool!.provider).toBe("docker");
    expect(dockerPool!.active).toBe(0);
    expect(dockerPool!.available).toBe(0);
  });

  it("deletes a pool", async () => {
    const manager = new ComputePoolManager(app);
    await manager.createPool({
      name: "to-delete",
      provider: "local",
      min: 0,
      max: 1,
      config: {},
    });
    expect(await manager.getPool("to-delete")).not.toBeNull();

    const deleted = await manager.deletePool("to-delete");
    expect(deleted).toBe(true);
    expect(await manager.getPool("to-delete")).toBeNull();
  });

  it("delete returns false for nonexistent pool", async () => {
    const manager = new ComputePoolManager(app);
    const deleted = await manager.deletePool("nonexistent");
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

  it("releaseCompute is a no-op for nonexistent pool", async () => {
    const manager = new ComputePoolManager(app);
    // Should not throw
    await manager.releaseCompute("nonexistent", "some-compute");
  });
});
