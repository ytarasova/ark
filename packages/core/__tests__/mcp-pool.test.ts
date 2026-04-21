import { describe, it, expect, afterEach } from "bun:test";
import { McpPool, getMcpPool, destroyMcpPool, discoverPoolSockets } from "../mcp-pool.js";

describe("McpPool", async () => {
  afterEach(() => destroyMcpPool());

  it("constructs without error", () => {
    const pool = new McpPool("/tmp/ark-mcp-pool-test");
    expect(pool).toBeDefined();
  });

  it("register adds an MCP server definition", () => {
    const pool = new McpPool("/tmp/ark-mcp-pool-test");
    pool.register({ name: "test", command: "echo", args: ["hello"] });
    const status = pool.getStatus();
    expect(status.length).toBe(1);
    expect(status[0].name).toBe("test");
    expect(status[0].status).toBe("stopped");
  });

  it("register is idempotent", () => {
    const pool = new McpPool("/tmp/ark-mcp-pool-test");
    pool.register({ name: "dup", command: "echo", args: [] });
    pool.register({ name: "dup", command: "echo", args: [] });
    expect(pool.getStatus().length).toBe(1);
  });

  it("getSocketPath returns null for unstarted proxy", () => {
    const pool = new McpPool("/tmp/ark-mcp-pool-test");
    pool.register({ name: "test", command: "echo", args: [] });
    expect(pool.getSocketPath("test")).toBeNull();
  });

  it("isRunning returns false for stopped proxy", () => {
    const pool = new McpPool("/tmp/ark-mcp-pool-test");
    pool.register({ name: "test", command: "echo", args: [] });
    expect(pool.isRunning("test")).toBe(false);
  });

  it("getProxyConfig returns null for non-running proxy", () => {
    const pool = new McpPool("/tmp/ark-mcp-pool-test");
    pool.register({ name: "test", command: "echo", args: [] });
    expect(pool.getProxyConfig("test")).toBeNull();
  });

  it("start throws for unregistered MCP", async () => {
    const pool = new McpPool("/tmp/ark-mcp-pool-test");
    expect(pool.start("nonexistent")).rejects.toThrow("not registered");
  });

  it("stopAll clears all proxies", () => {
    const pool = new McpPool("/tmp/ark-mcp-pool-test");
    pool.register({ name: "a", command: "echo", args: [] });
    pool.register({ name: "b", command: "echo", args: [] });
    pool.stopAll();
    expect(pool.getStatus()).toEqual([]);
  });

  it("singleton getMcpPool returns same instance", () => {
    const p1 = getMcpPool("/tmp/ark-mcp-pool-test");
    const p2 = getMcpPool("/tmp/ark-mcp-pool-test");
    expect(p1).toBe(p2);
  });

  it("destroyMcpPool clears singleton", () => {
    const p1 = getMcpPool("/tmp/ark-mcp-pool-test");
    destroyMcpPool();
    const p2 = getMcpPool("/tmp/ark-mcp-pool-test");
    expect(p1).not.toBe(p2);
  });

  it("discoverPoolSockets returns array", () => {
    const sockets = discoverPoolSockets("/tmp/ark-mcp-pool-test");
    expect(Array.isArray(sockets)).toBe(true);
  });

  it("start and connect with real echo process", async () => {
    const pool = new McpPool("/tmp/ark-mcp-pool-test");
    pool.register({ name: "pool-test", command: "cat", args: [] });

    const socketPath = await pool.start("pool-test");
    expect(socketPath).toContain("ark-mcp-pool-test.sock");
    expect(pool.isRunning("pool-test")).toBe(true);
    expect(pool.getSocketPath("pool-test")).toBe(socketPath);

    const config = pool.getProxyConfig("pool-test");
    expect(config).not.toBeNull();
    expect(config!.command).toBe("ark");
    expect(config!.args).toContain(socketPath);

    pool.stopAll();
    expect(pool.isRunning("pool-test")).toBe(false);
  });

  it("health monitor can be started and stopped", () => {
    const pool = new McpPool("/tmp/ark-mcp-pool-test");
    pool.startHealthMonitor(10000);
    pool.stopAll(); // should also clear the health interval
  });
});
