import { describe, it, expect, afterEach } from "bun:test";
import { startWebServer } from "../hosted/web.js";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "../app.js";


withTestContext();

/** Helper: send a JSON-RPC request to the web server. */
async function rpc(port: number, method: string, params: Record<string, unknown> = {}, opts?: { token?: string }) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts?.token) headers["Authorization"] = `Bearer ${opts.token}`;
  const resp = await fetch(`http://localhost:${port}/api/rpc`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return resp;
}

async function rpcResult(port: number, method: string, params: Record<string, unknown> = {}, opts?: { token?: string }) {
  const resp = await rpc(port, method, params, opts);
  const data = await resp.json() as Record<string, unknown>;
  return data;
}

describe("web server", () => {
  let server: { stop: () => void; url: string } | null = null;
  afterEach(() => { server?.stop(); server = null; });

  it("starts and serves dashboard HTML", async () => {
    server = startWebServer(getApp(), { port: 18420 });
    const resp = await fetch("http://localhost:18420/");
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain("<title>Ark</title>");
  });

  it("serves session list via RPC", async () => {
    getApp().sessions.create({ summary: "web-test" });
    server = startWebServer(getApp(), { port: 18421 });
    const data = await rpcResult(18421, "session/list", { limit: 200 });
    expect(data.result).toBeDefined();
    const result = data.result as Record<string, unknown>;
    expect(Array.isArray(result.sessions)).toBe(true);
    expect((result.sessions as any[]).some((s) => s.summary === "web-test")).toBe(true);
  });

  it("serves costs via RPC", async () => {
    server = startWebServer(getApp(), { port: 18422 });
    const data = await rpcResult(18422, "costs/read");
    const result = data.result as Record<string, unknown>;
    expect(result).toHaveProperty("total");
    expect(result).toHaveProperty("costs");
  });

  it("returns 404 for unknown routes", async () => {
    server = startWebServer(getApp(), { port: 18423 });
    const resp = await fetch("http://localhost:18423/nope");
    expect(resp.status).toBe(404);
  });

  it("enforces token auth when configured", async () => {
    server = startWebServer(getApp(), { port: 18424, token: "secret123" });
    // No auth should be rejected
    const noAuth = await fetch("http://localhost:18424/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/list", params: {} }),
    });
    expect(noAuth.status).toBe(401);
    // With auth should succeed
    const data = await rpcResult(18424, "session/list", {}, { token: "secret123" });
    expect(data.result).toBeDefined();
  });

  it("returns session detail with events via RPC", async () => {
    const s = getApp().sessions.create({ summary: "detail-test" });
    server = startWebServer(getApp(), { port: 18425 });
    const data = await rpcResult(18425, "session/read", { sessionId: s.id, include: ["events"] });
    const result = data.result as Record<string, unknown>;
    expect((result.session as any).id).toBe(s.id);
    expect(Array.isArray(result.events)).toBe(true);
  });

  it("returns error for missing session", async () => {
    server = startWebServer(getApp(), { port: 18426 });
    const data = await rpcResult(18426, "session/read", { sessionId: "nonexistent" });
    expect(data.error).toBeDefined();
  });

  it("creates a session via RPC", async () => {
    server = startWebServer(getApp(), { port: 18430 });
    const data = await rpcResult(18430, "session/start", { summary: "web-create-test", repo: "." });
    const result = data.result as Record<string, unknown>;
    expect(result.session).toBeDefined();
    expect((result.session as any).summary).toBe("web-create-test");
  });

  it("returns system status via RPC", async () => {
    getApp().sessions.create({ summary: "status-test-1" });
    getApp().sessions.create({ summary: "status-test-2" });
    server = startWebServer(getApp(), { port: 18431 });
    const data = await rpcResult(18431, "status/get");
    const result = data.result as Record<string, unknown>;
    expect(result).toHaveProperty("total");
    expect(result).toHaveProperty("byStatus");
    expect(typeof result.total).toBe("number");
    expect(result.total as number).toBeGreaterThanOrEqual(2);
  });

  it("returns groups via RPC", async () => {
    server = startWebServer(getApp(), { port: 18432 });
    const data = await rpcResult(18432, "group/list");
    const result = data.result as Record<string, unknown>;
    expect(Array.isArray(result.groups)).toBe(true);
  });

  it("handles CORS preflight", async () => {
    server = startWebServer(getApp(), { port: 18433 });
    const resp = await fetch("http://localhost:18433/api/rpc", { method: "OPTIONS" });
    expect(resp.status).toBe(204);
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("rejects write methods in read-only mode", async () => {
    server = startWebServer(getApp(), { port: 18434, readOnly: true });
    const resp = await rpc(18434, "session/start", { summary: "should-fail" });
    expect(resp.status).toBe(403);
    const data = await resp.json() as Record<string, unknown>;
    expect(data.error).toBeDefined();
  });

  // --- RPC endpoint tests ---

  it("session/clone works via RPC", async () => {
    const s = getApp().sessions.create({ summary: "fork-me" });
    server = startWebServer(getApp(), { port: 18535 });
    const data = await rpcResult(18535, "session/clone", { sessionId: s.id, name: "forked-copy" });
    const result = data.result as Record<string, unknown>;
    expect(result.session).toBeDefined();
  });

  it("profile/list returns profiles via RPC", async () => {
    server = startWebServer(getApp(), { port: 18536 });
    const data = await rpcResult(18536, "profile/list");
    const result = data.result as Record<string, unknown>;
    expect(Array.isArray(result.profiles)).toBe(true);
    expect((result.profiles as any[]).some((p) => p.name === "default")).toBe(true);
  });

  it("search/sessions requires query param", async () => {
    server = startWebServer(getApp(), { port: 18538 });
    const data = await rpcResult(18538, "search/sessions", {});
    // Missing required param "query" should return an error
    expect(data.error).toBeDefined();
  });

  it("agent/list returns agents via RPC", async () => {
    server = startWebServer(getApp(), { port: 18539 });
    const data = await rpcResult(18539, "agent/list");
    const result = data.result as Record<string, unknown>;
    expect(Array.isArray(result.agents)).toBe(true);
  });

  it("memory/list returns memories via RPC", async () => {
    server = startWebServer(getApp(), { port: 18540 });
    const data = await rpcResult(18540, "memory/list");
    const result = data.result as Record<string, unknown>;
    expect(Array.isArray(result.memories)).toBe(true);
  });

  it("compute/list returns computes via RPC", async () => {
    server = startWebServer(getApp(), { port: 18541 });
    const data = await rpcResult(18541, "compute/list");
    const result = data.result as Record<string, unknown>;
    expect(Array.isArray(result.targets)).toBe(true);
  });

  it("config/get returns system config via RPC", async () => {
    server = startWebServer(getApp(), { port: 18542 });
    const data = await rpcResult(18542, "config/get");
    const result = data.result as Record<string, unknown>;
    expect(result).toHaveProperty("hotkeys");
    expect(result).toHaveProperty("theme");
    expect(result).toHaveProperty("profile");
  });

  it("session/events returns events via RPC", async () => {
    const s = getApp().sessions.create({ summary: "events-test" });
    server = startWebServer(getApp(), { port: 18543 });
    const data = await rpcResult(18543, "session/events", { sessionId: s.id });
    const result = data.result as Record<string, unknown>;
    expect(Array.isArray(result.events)).toBe(true);
  });

  it("flow/list returns flows via RPC", async () => {
    server = startWebServer(getApp(), { port: 18544 });
    const data = await rpcResult(18544, "flow/list");
    const result = data.result as Record<string, unknown>;
    expect(Array.isArray(result.flows)).toBe(true);
  });

  it("returns method not found for unknown RPC method", async () => {
    server = startWebServer(getApp(), { port: 18545 });
    const data = await rpcResult(18545, "nonexistent/method");
    expect(data.error).toBeDefined();
    expect((data.error as any).code).toBe(-32601);
  });

  it("returns error for invalid JSON-RPC request", async () => {
    server = startWebServer(getApp(), { port: 18546 });
    const resp = await fetch("http://localhost:18546/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ not: "valid" }),
    });
    expect(resp.status).toBe(400);
  });
});
