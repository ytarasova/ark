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

  it("creates a host with defaults", () => {
    const host = createHost({ name: "my-laptop" });
    expect(host.name).toBe("my-laptop");
    expect(host.provider).toBe("local");
    expect(host.status).toBe("stopped");
    expect(host.config).toEqual({});
    expect(host.created_at).toBeTruthy();
    expect(host.updated_at).toBeTruthy();
  });

  it("creates a host with full config", () => {
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
    createHost({ name: "a" });
    createHost({ name: "b" });
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
});
