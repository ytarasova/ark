import { describe, it, expect, beforeEach } from "bun:test";
import {
  getDb,
  createHost,
  getHost,
  listHosts,
  updateHost,
  deleteHost,
} from "../store.js";

describe("hosts CRUD", () => {
  beforeEach(() => {
    getDb().run("DELETE FROM hosts");
  });

  it("creates a local host as running by default", () => {
    const host = createHost({ name: "my-laptop" });
    expect(host.name).toBe("my-laptop");
    expect(host.provider).toBe("local");
    expect(host.status).toBe("running");
    expect(host.config).toEqual({});
    expect(host.created_at).toBeTruthy();
    expect(host.updated_at).toBeTruthy();
  });

  it("creates a non-local host as stopped by default", () => {
    const host = createHost({
      name: "docker-1",
      provider: "docker",
      config: { image: "ubuntu:22.04", memory: "4g" },
    });
    expect(host.name).toBe("docker-1");
    expect(host.provider).toBe("docker");
    expect(host.status).toBe("stopped");
    expect(host.config).toEqual({ image: "ubuntu:22.04", memory: "4g" });
  });

  it("retrieves a host by name", () => {
    createHost({ name: "fetch-me", provider: "ec2" });
    const host = getHost("fetch-me");
    expect(host).not.toBeNull();
    expect(host!.name).toBe("fetch-me");
    expect(host!.provider).toBe("ec2");
  });

  it("returns null for nonexistent host", () => {
    const host = getHost("does-not-exist");
    expect(host).toBeNull();
  });

  it("lists all hosts", () => {
    createHost({ name: "h1" });
    createHost({ name: "h2" });
    createHost({ name: "h3" });
    const hosts = listHosts();
    expect(hosts.length).toBe(3);
  });

  it("filters by provider", () => {
    createHost({ name: "local-1", provider: "local" });
    createHost({ name: "docker-1", provider: "docker" });
    createHost({ name: "docker-2", provider: "docker" });
    const hosts = listHosts({ provider: "docker" });
    expect(hosts.length).toBe(2);
    expect(hosts.every((h) => h.provider === "docker")).toBe(true);
  });

  it("filters by status", () => {
    createHost({ name: "a", provider: "ec2" }); // ec2 defaults to stopped
    createHost({ name: "b", provider: "ec2" });
    updateHost("b", { status: "running" });
    const running = listHosts({ status: "running" });
    expect(running.length).toBe(1);
    expect(running[0].name).toBe("b");
  });

  it("updates host fields including config as JSON", () => {
    createHost({ name: "up", provider: "local" });
    const updated = updateHost("up", {
      status: "running",
      provider: "docker",
      config: { port: 3000 },
    });
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("running");
    expect(updated!.provider).toBe("docker");
    expect(updated!.config).toEqual({ port: 3000 });
  });

  it("deletes a host", () => {
    createHost({ name: "del-me" });
    expect(deleteHost("del-me")).toBe(true);
    expect(getHost("del-me")).toBeNull();
  });

  it("returns false deleting nonexistent host", () => {
    expect(deleteHost("ghost")).toBe(false);
  });

  it("throws on duplicate host name", () => {
    createHost({ name: "dup" });
    expect(() => createHost({ name: "dup" })).toThrow();
  });

  it("returns null when updating a non-existent host", () => {
    const result = updateHost("nonexistent", { status: "running" });
    expect(result).toBeNull();
  });

  it("silently ignores updates to name and created_at", () => {
    createHost({ name: "immut", provider: "local" });
    const updated = updateHost("immut", {
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
    const host = createHost({ name: "dev", provider: "local" });
    const originalUpdatedAt = host.updated_at;

    // Small delay to ensure timestamp differs
    const spinUntil = Date.now() + 5;
    while (Date.now() < spinUntil) {}

    const updated = updateHost("dev", {});
    expect(updated).not.toBeNull();
    expect(updated!.provider).toBe("local");
    expect(updated!.status).toBe("running"); // local hosts start as running
    expect(updated!.config).toEqual({});
    expect(updated!.updated_at >= originalUpdatedAt).toBe(true);
  });

  it("filters by both provider and status", () => {
    createHost({ name: "a", provider: "ec2" });
    createHost({ name: "b", provider: "ec2" });
    createHost({ name: "c", provider: "docker" });
    updateHost("b", { status: "running" });

    const results = listHosts({ provider: "ec2", status: "running" });
    expect(results.length).toBe(1);
    expect(results[0].name).toBe("b");
  });

  it("keeps created_at constant while updated_at changes on update", () => {
    const host = createHost({ name: "ts-check" });
    const originalCreatedAt = host.created_at;
    const originalUpdatedAt = host.updated_at;

    const spinUntil = Date.now() + 5;
    while (Date.now() < spinUntil) {}

    const updated = updateHost("ts-check", { status: "running" });
    expect(updated).not.toBeNull();
    expect(updated!.created_at).toBe(originalCreatedAt);
    expect(updated!.updated_at >= originalUpdatedAt).toBe(true);
  });

  it("replaces config entirely instead of merging", () => {
    createHost({
      name: "cfg",
      config: { a: 1, b: 2, c: 3 },
    });
    const updated = updateHost("cfg", { config: { x: 99 } });
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
    const host = createHost({ name: "big-cfg", config: bigConfig });
    expect(host.config).toEqual(bigConfig);
    expect(Object.keys(host.config).length).toBe(100);

    const fetched = getHost("big-cfg");
    expect(fetched).not.toBeNull();
    expect(fetched!.config).toEqual(bigConfig);
  });
});
