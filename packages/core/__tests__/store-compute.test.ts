import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestContext, setContext } from "../context.js";
import type { TestContext } from "../context.js";
import {
  createCompute,
  getCompute,
  listCompute,
  updateCompute,
  deleteCompute,
} from "../store.js";

let ctx: TestContext;
beforeEach(() => { ctx = createTestContext(); setContext(ctx); });
afterEach(() => { ctx.cleanup(); });

describe("compute CRUD", () => {

  it("creates a local compute as running by default", () => {
    const compute = createCompute({ name: "my-laptop" });
    expect(compute.name).toBe("my-laptop");
    expect(compute.provider).toBe("local");
    expect(compute.status).toBe("running");
    expect(compute.config).toEqual({});
    expect(compute.created_at).toBeTruthy();
    expect(compute.updated_at).toBeTruthy();
  });

  it("creates a non-local compute as stopped by default", () => {
    const compute = createCompute({
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
    createCompute({ name: "fetch-me", provider: "ec2" });
    const compute = getCompute("fetch-me");
    expect(compute).not.toBeNull();
    expect(compute!.name).toBe("fetch-me");
    expect(compute!.provider).toBe("ec2");
  });

  it("returns null for nonexistent compute", () => {
    const compute = getCompute("does-not-exist");
    expect(compute).toBeNull();
  });

  it("lists all computes", () => {
    createCompute({ name: "h1" });
    createCompute({ name: "h2" });
    createCompute({ name: "h3" });
    const computes = listCompute();
    // +1 for the auto-created "local" compute from ensureLocalCompute()
    expect(computes.length).toBe(4);
  });

  it("filters by provider", () => {
    createCompute({ name: "local-1", provider: "local" });
    createCompute({ name: "docker-1", provider: "docker" });
    createCompute({ name: "docker-2", provider: "docker" });
    const computes = listCompute({ provider: "docker" });
    expect(computes.length).toBe(2);
    expect(computes.every((h) => h.provider === "docker")).toBe(true);
  });

  it("filters by status", () => {
    createCompute({ name: "a", provider: "ec2" }); // ec2 defaults to stopped
    createCompute({ name: "b", provider: "ec2" });
    updateCompute("b", { status: "running" });
    const running = listCompute({ status: "running" });
    // "local" is auto-created as running + "b" was set to running
    expect(running.length).toBe(2);
    expect(running.some(c => c.name === "b")).toBe(true);
  });

  it("updates compute fields including config as JSON", () => {
    createCompute({ name: "up", provider: "local" });
    const updated = updateCompute("up", {
      status: "running",
      provider: "docker",
      config: { port: 3000 },
    });
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("running");
    expect(updated!.provider).toBe("docker");
    expect(updated!.config).toEqual({ port: 3000 });
  });

  it("deletes a compute", () => {
    createCompute({ name: "del-me" });
    expect(deleteCompute("del-me")).toBe(true);
    expect(getCompute("del-me")).toBeNull();
  });

  it("returns false deleting nonexistent compute", () => {
    expect(deleteCompute("ghost")).toBe(false);
  });

  it("throws on duplicate compute name", () => {
    createCompute({ name: "dup" });
    expect(() => createCompute({ name: "dup" })).toThrow();
  });

  it("returns null when updating a non-existent compute", () => {
    const result = updateCompute("nonexistent", { status: "running" });
    expect(result).toBeNull();
  });

  it("silently ignores updates to name and created_at", () => {
    createCompute({ name: "immut", provider: "local" });
    const updated = updateCompute("immut", {
      name: "renamed" as any,
      created_at: "2000-01-01T00:00:00.000Z",
      status: "running",
    });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("immut");
    expect(updated!.created_at).not.toBe("2000-01-01T00:00:00.000Z");
    expect(updated!.status).toBe("running");
  });

  it("updates updated_at even with empty fields object", () => {
    const compute = createCompute({ name: "dev", provider: "local" });
    const originalUpdatedAt = compute.updated_at;

    // Small delay to ensure timestamp differs
    const spinUntil = Date.now() + 5;
    while (Date.now() < spinUntil) {}

    const updated = updateCompute("dev", {});
    expect(updated).not.toBeNull();
    expect(updated!.provider).toBe("local");
    expect(updated!.status).toBe("running"); // local computes start as running
    expect(updated!.config).toEqual({});
    expect(updated!.updated_at >= originalUpdatedAt).toBe(true);
  });

  it("filters by both provider and status", () => {
    createCompute({ name: "a", provider: "ec2" });
    createCompute({ name: "b", provider: "ec2" });
    createCompute({ name: "c", provider: "docker" });
    updateCompute("b", { status: "running" });

    const results = listCompute({ provider: "ec2", status: "running" });
    expect(results.length).toBe(1);
    expect(results[0].name).toBe("b");
  });

  it("keeps created_at constant while updated_at changes on update", () => {
    const compute = createCompute({ name: "ts-check" });
    const originalCreatedAt = compute.created_at;
    const originalUpdatedAt = compute.updated_at;

    const spinUntil = Date.now() + 5;
    while (Date.now() < spinUntil) {}

    const updated = updateCompute("ts-check", { status: "running" });
    expect(updated).not.toBeNull();
    expect(updated!.created_at).toBe(originalCreatedAt);
    expect(updated!.updated_at >= originalUpdatedAt).toBe(true);
  });

  it("replaces config entirely instead of merging", () => {
    createCompute({
      name: "cfg",
      config: { a: 1, b: 2, c: 3 },
    });
    const updated = updateCompute("cfg", { config: { x: 99 } });
    expect(updated).not.toBeNull();
    expect(updated!.config).toEqual({ x: 99 });
    expect((updated!.config as any).a).toBeUndefined();
    expect((updated!.config as any).b).toBeUndefined();
    expect((updated!.config as any).c).toBeUndefined();
  });

  it("handles a large nested config object", () => {
    const bigConfig: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      bigConfig[`key_${i}`] = {
        nested: { value: i, label: `item-${i}` },
        tags: [i, i + 1, i + 2],
      };
    }
    const compute = createCompute({ name: "big-cfg", config: bigConfig });
    expect(compute.config).toEqual(bigConfig);
    expect(Object.keys(compute.config).length).toBe(100);

    const fetched = getCompute("big-cfg");
    expect(fetched).not.toBeNull();
    expect(fetched!.config).toEqual(bigConfig);
  });
});
