import { describe, it, expect } from "bun:test";
import { getApp } from "../app.js";
import { withTestContext } from "./test-helpers.js";

withTestContext();

describe("compute CRUD", () => {
  it("rejects creating a second local compute (singleton)", () => {
    // "local" is auto-seeded -- creating another with provider=local must throw
    expect(() => getApp().computes.create({ name: "my-laptop" })).toThrow(/singleton/);
    expect(() => getApp().computes.create({ name: "my-laptop", provider: "local" })).toThrow(/singleton/);
  });

  it("creates a non-local compute as stopped by default", () => {
    const compute = getApp().computes.create({
      name: "docker-1",
      provider: "docker",
      config: { image: "ubuntu:22.04", memory: "4g" },
    });
    expect(compute.name).toBe("docker-1");
    expect(compute.provider).toBe("docker");
    expect(compute.status).toBe("stopped");
    expect(compute.config).toEqual({ image: "ubuntu:22.04", memory: "4g" });
  });

  it("retrieves a compute by name", () => {
    getApp().computes.create({ name: "fetch-me", provider: "ec2" });
    const compute = getApp().computes.get("fetch-me");
    expect(compute).not.toBeNull();
    expect(compute!.name).toBe("fetch-me");
    expect(compute!.provider).toBe("ec2");
  });

  it("returns null for nonexistent compute", () => {
    const compute = getApp().computes.get("does-not-exist");
    expect(compute).toBeNull();
  });

  it("lists all computes", () => {
    getApp().computes.create({ name: "h1", provider: "docker" });
    getApp().computes.create({ name: "h2", provider: "docker" });
    getApp().computes.create({ name: "h3", provider: "docker" });
    const computes = getApp().computes.list();
    // +1 for the auto-created "local" compute from seedLocalCompute()
    expect(computes.length).toBe(4);
  });

  it("filters by provider", () => {
    getApp().computes.create({ name: "docker-1", provider: "docker" });
    getApp().computes.create({ name: "docker-2", provider: "docker" });
    getApp().computes.create({ name: "ec2-1", provider: "ec2" });
    const computes = getApp().computes.list({ provider: "docker" });
    expect(computes.length).toBe(2);
    expect(computes.every((h) => h.provider === "docker")).toBe(true);
  });

  it("filters by status", () => {
    getApp().computes.create({ name: "a", provider: "ec2" }); // ec2 defaults to stopped
    getApp().computes.create({ name: "b", provider: "ec2" });
    getApp().computes.update("b", { status: "running" });
    const running = getApp().computes.list({ status: "running" });
    // "local" is auto-created as running + "b" was set to running
    expect(running.length).toBe(2);
    expect(running.some((c) => c.name === "b")).toBe(true);
  });

  it("updates compute fields including config as JSON", () => {
    getApp().computes.create({ name: "up", provider: "docker" });
    const updated = getApp().computes.update("up", {
      status: "running",
      config: { port: 3000 },
    });
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("running");
    expect(updated!.config).toEqual({ port: 3000 });
  });

  it("deletes a compute", () => {
    getApp().computes.create({ name: "del-me", provider: "docker" });
    expect(getApp().computes.delete("del-me")).toBe(true);
    expect(getApp().computes.get("del-me")).toBeNull();
  });

  it("returns false deleting nonexistent compute", () => {
    expect(getApp().computes.delete("ghost")).toBe(false);
  });

  it("throws on duplicate compute name", () => {
    getApp().computes.create({ name: "dup", provider: "docker" });
    expect(() => getApp().computes.create({ name: "dup", provider: "docker" })).toThrow();
  });

  it("returns null when updating a non-existent compute", () => {
    const result = getApp().computes.update("nonexistent", { status: "running" });
    expect(result).toBeNull();
  });

  it("silently ignores updates to name and created_at", () => {
    getApp().computes.create({ name: "immut", provider: "docker" });
    const updated = getApp().computes.update("immut", {
      name: "renamed" as unknown,
      created_at: "2000-01-01T00:00:00.000Z",
      status: "running",
    });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("immut");
    expect(updated!.created_at).not.toBe("2000-01-01T00:00:00.000Z");
    expect(updated!.status).toBe("running");
  });

  it("updates updated_at even with empty fields object", () => {
    const compute = getApp().computes.create({ name: "dev", provider: "docker" });
    const originalUpdatedAt = compute.updated_at;

    // Small delay to ensure timestamp differs
    const spinUntil = Date.now() + 5;
    while (Date.now() < spinUntil) {
      /* busy-wait for timestamp to differ */
    }

    const updated = getApp().computes.update("dev", {});
    expect(updated).not.toBeNull();
    expect(updated!.provider).toBe("docker");
    expect(updated!.status).toBe("stopped"); // non-local computes start as stopped
    expect(updated!.config).toEqual({});
    expect(updated!.updated_at >= originalUpdatedAt).toBe(true);
  });

  it("filters by both provider and status", () => {
    getApp().computes.create({ name: "a", provider: "ec2" });
    getApp().computes.create({ name: "b", provider: "ec2" });
    getApp().computes.create({ name: "c", provider: "docker" });
    getApp().computes.update("b", { status: "running" });

    const results = getApp().computes.list({ provider: "ec2", status: "running" });
    expect(results.length).toBe(1);
    expect(results[0].name).toBe("b");
  });

  it("keeps created_at constant while updated_at changes on update", () => {
    const compute = getApp().computes.create({ name: "ts-check", provider: "docker" });
    const originalCreatedAt = compute.created_at;
    const originalUpdatedAt = compute.updated_at;

    const spinUntil = Date.now() + 5;
    while (Date.now() < spinUntil) {
      /* busy-wait for timestamp to differ */
    }

    const updated = getApp().computes.update("ts-check", { status: "running" });
    expect(updated).not.toBeNull();
    expect(updated!.created_at).toBe(originalCreatedAt);
    expect(updated!.updated_at >= originalUpdatedAt).toBe(true);
  });

  it("replaces config entirely instead of merging", () => {
    getApp().computes.create({
      name: "cfg",
      provider: "docker",
      config: { a: 1, b: 2, c: 3 },
    });
    const updated = getApp().computes.update("cfg", { config: { x: 99 } });
    expect(updated).not.toBeNull();
    expect(updated!.config).toEqual({ x: 99 });
    expect(updated!.config.a).toBeUndefined();
    expect(updated!.config.b).toBeUndefined();
    expect(updated!.config.c).toBeUndefined();
  });

  it("handles a large nested config object", () => {
    const bigConfig: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      bigConfig[`key_${i}`] = {
        nested: { value: i, label: `item-${i}` },
        tags: [i, i + 1, i + 2],
      };
    }
    const compute = getApp().computes.create({ name: "big-cfg", provider: "docker", config: bigConfig });
    expect(compute.config).toEqual(bigConfig);
    expect(Object.keys(compute.config).length).toBe(100);

    const fetched = getApp().computes.get("big-cfg");
    expect(fetched).not.toBeNull();
    expect(fetched!.config).toEqual(bigConfig);
  });
});
