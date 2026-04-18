import { describe, it, expect, afterEach } from "bun:test";
import { startWebServer } from "../hosted/web.js";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "../app.js";
import { allocatePort } from "./helpers/test-env.js";

withTestContext();

async function rpcResult(port: number, method: string, params: Record<string, unknown> = {}) {
  const resp = await fetch(`http://localhost:${port}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return resp.json() as Promise<Record<string, unknown>>;
}

async function startWeb(): Promise<{ stop: () => void; url: string; port: number }> {
  const port = await allocatePort();
  const server = startWebServer(getApp(), { port });
  return { stop: server.stop, url: `http://localhost:${port}`, port };
}

describe("daemon/status RPC handler", () => {
  let server: { stop: () => void; url: string; port: number } | null = null;
  afterEach(() => {
    server?.stop();
    server = null;
  });

  it("returns correct shape with conductor, arkd, and router fields", async () => {
    server = await startWeb();
    const data = await rpcResult(server.port, "daemon/status");
    const result = data.result as Record<string, any>;

    // Top-level keys
    expect(result).toHaveProperty("conductor");
    expect(result).toHaveProperty("arkd");
    expect(result).toHaveProperty("router");

    // Conductor shape
    expect(typeof result.conductor.online).toBe("boolean");
    expect(typeof result.conductor.url).toBe("string");
    expect(result.conductor.url).toContain("http");

    // ArkD shape
    expect(typeof result.arkd.online).toBe("boolean");
    expect(typeof result.arkd.url).toBe("string");
    expect(result.arkd.url).toContain("http");

    // Router shape
    expect(typeof result.router.online).toBe("boolean");
  });

  it("reports arkd offline when nothing is listening on the arkd port", async () => {
    // Allocate an ephemeral port, then let it close -- guaranteed nothing listening there
    const deadPort = await allocatePort();
    const origUrl = process.env.ARK_ARKD_URL;
    process.env.ARK_ARKD_URL = `http://localhost:${deadPort}`;
    try {
      server = await startWeb();
      const data = await rpcResult(server.port, "daemon/status");
      const result = data.result as Record<string, any>;

      // ArkD should be offline (no daemon on the allocated port)
      expect(result.arkd.online).toBe(false);
    } finally {
      if (origUrl !== undefined) process.env.ARK_ARKD_URL = origUrl;
      else delete process.env.ARK_ARKD_URL;
    }
  });

  it("includes proper URLs from config/env", async () => {
    server = await startWeb();
    const data = await rpcResult(server.port, "daemon/status");
    const result = data.result as Record<string, any>;

    // URLs should be real HTTP URLs
    expect(result.conductor.url).toMatch(/^https?:\/\//);
    expect(result.arkd.url).toMatch(/^https?:\/\//);
  });
});
