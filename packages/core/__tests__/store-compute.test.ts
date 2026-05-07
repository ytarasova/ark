import { describe, it, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";
import { legacyProviderLabel as providerOf } from "./_util/legacy-provider-label.js";

withTestContext();

describe("compute CRUD", () => {
  it("rejects creating a second local compute (singleton)", async () => {
    // "local" is auto-seeded -- creating another with provider=local must throw
    await expect(getApp().computeService.create({ name: "my-laptop" })).rejects.toThrow(/singleton/);
    await expect(
      getApp().computeService.create({ name: "my-laptop", compute: "local", isolation: "direct" }),
    ).rejects.toThrow(/singleton/);
  });

  it("creates an ec2 compute as stopped by default", async () => {
    const compute = await getApp().computeService.create({
      name: "ec2-1",
      compute: "ec2",
      isolation: "direct",
      config: { region: "us-east-1" },
    });
    expect(compute.name).toBe("ec2-1");
    expect(providerOf(compute)).toBe("ec2");
    expect(compute.status).toBe("stopped");
    expect(compute.config).toEqual({ region: "us-east-1" });
  });

  it("retrieves a compute by name", async () => {
    await getApp().computeService.create({ name: "fetch-me", compute: "ec2", isolation: "direct" });
    const compute = await getApp().computes.get("fetch-me");
    expect(compute).not.toBeNull();
    expect(compute!.name).toBe("fetch-me");
    expect(providerOf(compute!)).toBe("ec2");
  });

  it("returns null for nonexistent compute", async () => {
    const compute = await getApp().computes.get("does-not-exist");
    expect(compute).toBeNull();
  });

  it("lists all computes", async () => {
    await getApp().computeService.create({ name: "h1", compute: "local", isolation: "docker" });
    await getApp().computeService.create({ name: "h2", compute: "local", isolation: "docker" });
    await getApp().computeService.create({ name: "h3", compute: "local", isolation: "docker" });
    const computes = await getApp().computes.list();
    // +1 for the auto-created "local" compute from seedLocalCompute()
    expect(computes.length).toBe(4);
  });

  it("filters by provider", async () => {
    await getApp().computeService.create({ name: "docker-1", compute: "local", isolation: "docker" });
    await getApp().computeService.create({ name: "docker-2", compute: "local", isolation: "docker" });
    await getApp().computeService.create({ name: "ec2-1", compute: "ec2", isolation: "direct" });
    const computes = await getApp().computes.list({ compute_kind: "local", isolation_kind: "docker" });
    expect(computes.length).toBe(2);
    expect(computes.every((h) => providerOf(h) === "docker")).toBe(true);
  });

  it("filters by status", async () => {
    await getApp().computeService.create({ name: "a", compute: "ec2", isolation: "direct" }); // ec2 defaults to stopped
    await getApp().computeService.create({ name: "b", compute: "ec2", isolation: "direct" });
    await getApp().computes.update("b", { session_id: `ark-s-${"b"}`, status: "running" });
    const running = await getApp().computes.list({ status: "running" });
    // "local" is auto-created as running + "b" was set to running
    expect(running.length).toBe(2);
    expect(running.some((c) => c.name === "b")).toBe(true);
  });

  it("updates compute fields including config as JSON", async () => {
    await getApp().computeService.create({ name: "up", compute: "local", isolation: "docker" });
    const updated = await getApp().computes.update("up", {
      session_id: `ark-s-${"up"}`,
      status: "running",
      config: { port: 3000 },
    });
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("running");
    expect(updated!.config).toEqual({ port: 3000 });
  });

  it("deletes a compute", async () => {
    await getApp().computeService.create({ name: "del-me", compute: "local", isolation: "docker" });
    expect(await getApp().computes.delete("del-me")).toBe(true);
    expect(await getApp().computes.get("del-me")).toBeNull();
  });

  it("returns false deleting nonexistent compute", async () => {
    expect(await getApp().computes.delete("ghost")).toBe(false);
  });

  it("throws on duplicate compute name", async () => {
    await getApp().computeService.create({ name: "dup", compute: "local", isolation: "docker" });
    await expect(
      getApp().computeService.create({ name: "dup", compute: "local", isolation: "docker" }),
    ).rejects.toThrow();
  });

  it("returns null when updating a non-existent compute", async () => {
    const result = await getApp().computes.update("nonexistent", {
      session_id: `ark-s-${"nonexistent"}`,
      status: "running",
    });
    expect(result).toBeNull();
  });

  it("silently ignores updates to name and created_at", async () => {
    await getApp().computeService.create({ name: "immut", compute: "local", isolation: "docker" });
    const updated = await getApp().computes.update("immut", {
      session_id: `ark-s-${"immut"}`,
      name: "renamed" as unknown,
      created_at: "2000-01-01T00:00:00.000Z",
      status: "running",
    });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("immut");
    expect(updated!.created_at).not.toBe("2000-01-01T00:00:00.000Z");
    expect(updated!.status).toBe("running");
  });

  it("updates updated_at even with empty fields object", async () => {
    const compute = await getApp().computeService.create({ name: "dev", compute: "local", isolation: "docker" });
    const originalUpdatedAt = compute.updated_at;

    // Small delay to ensure timestamp differs
    const spinUntil = Date.now() + 5;
    while (Date.now() < spinUntil) {
      /* busy-wait for timestamp to differ */
    }

    const updated = await getApp().computes.update("dev", {});
    expect(updated).not.toBeNull();
    expect(providerOf(updated!)).toBe("docker");
    // After Task 5: capabilities live on Compute. local+docker inherits
    // LocalCompute.initialStatus="running" (the legacy "docker provider
    // = stopped" semantics is gone).
    expect(updated!.status).toBe("running");
    expect(updated!.config).toEqual({});
    expect(updated!.updated_at >= originalUpdatedAt).toBe(true);
  });

  it("filters by both provider and status", async () => {
    await getApp().computeService.create({ name: "a", compute: "ec2", isolation: "direct" });
    await getApp().computeService.create({ name: "b", compute: "ec2", isolation: "direct" });
    await getApp().computeService.create({ name: "c", compute: "local", isolation: "docker" });
    await getApp().computes.update("b", { session_id: `ark-s-${"b"}`, status: "running" });

    const results = await getApp().computes.list({ compute_kind: "ec2", isolation_kind: "direct", status: "running" });
    expect(results.length).toBe(1);
    expect(results[0].name).toBe("b");
  });

  it("keeps created_at constant while updated_at changes on update", async () => {
    const compute = await getApp().computeService.create({ name: "ts-check", compute: "local", isolation: "docker" });
    const originalCreatedAt = compute.created_at;
    const originalUpdatedAt = compute.updated_at;

    const spinUntil = Date.now() + 5;
    while (Date.now() < spinUntil) {
      /* busy-wait for timestamp to differ */
    }

    const updated = await getApp().computes.update("ts-check", {
      session_id: `ark-s-${"ts-check"}`,
      status: "running",
    });
    expect(updated).not.toBeNull();
    expect(updated!.created_at).toBe(originalCreatedAt);
    expect(updated!.updated_at >= originalUpdatedAt).toBe(true);
  });

  it("replaces config entirely instead of merging", async () => {
    await getApp().computeService.create({
      name: "cfg",
      compute: "local",
      isolation: "docker",
      config: { a: 1, b: 2, c: 3 },
    });
    const updated = await getApp().computes.update("cfg", { config: { x: 99 } });
    expect(updated).not.toBeNull();
    expect(updated!.config).toEqual({ x: 99 });
    expect(updated!.config.a).toBeUndefined();
    expect(updated!.config.b).toBeUndefined();
    expect(updated!.config.c).toBeUndefined();
  });

  it("handles a large nested config object", async () => {
    const bigConfig: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      bigConfig[`key_${i}`] = {
        nested: { value: i, label: `item-${i}` },
        tags: [i, i + 1, i + 2],
      };
    }
    const compute = await getApp().computeService.create({
      name: "big-cfg",
      compute: "local",
      isolation: "docker",
      config: bigConfig,
    });
    expect(compute.config).toEqual(bigConfig);
    expect(Object.keys(compute.config).length).toBe(100);

    const fetched = await getApp().computes.get("big-cfg");
    expect(fetched).not.toBeNull();
    expect(fetched!.config).toEqual(bigConfig);
  });
});
