import { describe, it, expect, afterEach } from "bun:test";
import { startWebServer } from "../hosted/web.js";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "../app.js";
import { allocatePort } from "./helpers/test-env.js";

withTestContext();

type WebServerHandle = { stop: () => void; url: string; port: number };

/**
 * Start the web server on an ephemeral port. Returns a handle where `.url`
 * is the bare origin (`http://localhost:PORT`) -- no query-string token
 * appended -- so tests can compose `${handle.url}/api/...` paths safely.
 */
async function startWeb(opts?: Omit<Parameters<typeof startWebServer>[1], "port">): Promise<WebServerHandle> {
  const port = await allocatePort();
  const server = startWebServer(getApp(), { port, ...(opts ?? {}) });
  return { stop: server.stop, url: `http://localhost:${port}`, port };
}

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

async function rpcResult(
  port: number,
  method: string,
  params: Record<string, unknown> = {},
  opts?: { token?: string },
) {
  const resp = await rpc(port, method, params, opts);
  const data = (await resp.json()) as Record<string, unknown>;
  return data;
}

describe("web server", () => {
  let server: WebServerHandle | null = null;
  afterEach(() => {
    server?.stop();
    server = null;
  });

  it("starts and serves dashboard HTML", async () => {
    const { existsSync } = await import("fs");
    const { join } = await import("path");
    const distIndex = join(import.meta.dir, "../../../web/dist/index.html");
    if (!existsSync(distIndex)) {
      console.log("Skipping: packages/web/dist not built");
      return;
    }
    server = await startWeb();
    const resp = await fetch(`${server!.url}/`);
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain("<title>Ark</title>");
  });

  it("serves session list via RPC", async () => {
    getApp().sessions.create({ summary: "web-test" });
    server = await startWeb();
    const data = await rpcResult(server!.port, "session/list", { limit: 200 });
    expect(data.result).toBeDefined();
    const result = data.result as Record<string, unknown>;
    expect(Array.isArray(result.sessions)).toBe(true);
    expect((result.sessions as any[]).some((s) => s.summary === "web-test")).toBe(true);
  });

  it("serves costs via RPC", async () => {
    server = await startWeb();
    const data = await rpcResult(server!.port, "costs/read");
    const result = data.result as Record<string, unknown>;
    expect(result).toHaveProperty("total");
    expect(result).toHaveProperty("costs");
  });

  it("SPA fallback returns index.html for unknown routes", async () => {
    server = await startWeb();
    const resp = await fetch(`${server!.url}/nope`);
    // SPA fallback: any non-API, non-static route serves index.html (200)
    // so client-side routing can handle it. This is standard SPA behavior.
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain("root");
  });

  it("/api/health returns 200 with version + uptime", async () => {
    server = await startWeb();
    const resp = await fetch(`${server!.url}/api/health`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean; version: string; uptime: number };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
    expect(typeof body.uptime).toBe("number");
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it("/api/health works in read-only mode (no auth required)", async () => {
    server = await startWeb({ readOnly: true });
    const resp = await fetch(`${server!.url}/api/health`);
    expect(resp.status).toBe(200);
  });

  it("/api/health works even when token auth is enabled", async () => {
    // Health is intentionally unauthenticated so the desktop app can probe
    // it before the user has supplied a token.
    server = await startWeb({ token: "secret" });
    const resp = await fetch(`${server!.url}/api/health`);
    expect(resp.status).toBe(200);
  });

  it("enforces token auth when configured", async () => {
    server = await startWeb({ token: "secret123" });
    // No auth should be rejected
    const noAuth = await fetch(`${server!.url}/api/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/list", params: {} }),
    });
    expect(noAuth.status).toBe(401);
    // With auth should succeed
    const data = await rpcResult(server!.port, "session/list", {}, { token: "secret123" });
    expect(data.result).toBeDefined();
  });

  it("returns session detail with events via RPC", async () => {
    const s = getApp().sessions.create({ summary: "detail-test" });
    server = await startWeb();
    const data = await rpcResult(server!.port, "session/read", { sessionId: s.id, include: ["events"] });
    const result = data.result as Record<string, unknown>;
    expect((result.session as any).id).toBe(s.id);
    expect(Array.isArray(result.events)).toBe(true);
  });

  it("returns error for missing session", async () => {
    server = await startWeb();
    const data = await rpcResult(server!.port, "session/read", { sessionId: "nonexistent" });
    expect(data.error).toBeDefined();
  });

  it("creates a session via RPC", async () => {
    server = await startWeb();
    const data = await rpcResult(server!.port, "session/start", { summary: "web-create-test", repo: "." });
    const result = data.result as Record<string, unknown>;
    expect(result.session).toBeDefined();
    expect((result.session as any).summary).toBe("web-create-test");
  });

  it("returns system status via RPC", async () => {
    getApp().sessions.create({ summary: "status-test-1" });
    getApp().sessions.create({ summary: "status-test-2" });
    server = await startWeb();
    const data = await rpcResult(server!.port, "status/get");
    const result = data.result as Record<string, unknown>;
    expect(result).toHaveProperty("total");
    expect(result).toHaveProperty("byStatus");
    expect(typeof result.total).toBe("number");
    expect(result.total as number).toBeGreaterThanOrEqual(2);
  });

  it("returns groups via RPC", async () => {
    server = await startWeb();
    const data = await rpcResult(server!.port, "group/list");
    const result = data.result as Record<string, unknown>;
    expect(Array.isArray(result.groups)).toBe(true);
  });

  it("handles CORS preflight", async () => {
    server = await startWeb();
    const resp = await fetch(`${server!.url}/api/rpc`, { method: "OPTIONS" });
    expect(resp.status).toBe(204);
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("rejects write methods in read-only mode", async () => {
    server = await startWeb({ readOnly: true });
    const resp = await rpc(server!.port, "session/start", { summary: "should-fail" });
    expect(resp.status).toBe(403);
    const data = (await resp.json()) as Record<string, unknown>;
    expect(data.error).toBeDefined();
  });

  // --- RPC endpoint tests ---

  it("session/clone works via RPC", async () => {
    const s = getApp().sessions.create({ summary: "fork-me" });
    server = await startWeb();
    const data = await rpcResult(server!.port, "session/clone", { sessionId: s.id, name: "forked-copy" });
    const result = data.result as Record<string, unknown>;
    expect(result.session).toBeDefined();
  });

  it("profile/list returns profiles via RPC", async () => {
    server = await startWeb();
    const data = await rpcResult(server!.port, "profile/list");
    const result = data.result as Record<string, unknown>;
    expect(Array.isArray(result.profiles)).toBe(true);
    expect((result.profiles as any[]).some((p) => p.name === "default")).toBe(true);
  });

  it("search/sessions requires query param", async () => {
    server = await startWeb();
    const data = await rpcResult(server!.port, "search/sessions", {});
    // Missing required param "query" should return an error
    expect(data.error).toBeDefined();
  });

  it("agent/list returns agents via RPC", async () => {
    server = await startWeb();
    const data = await rpcResult(server!.port, "agent/list");
    const result = data.result as Record<string, unknown>;
    expect(Array.isArray(result.agents)).toBe(true);
  });

  it("memory/list returns memories via RPC", async () => {
    server = await startWeb();
    const data = await rpcResult(server!.port, "memory/list");
    const result = data.result as Record<string, unknown>;
    expect(Array.isArray(result.memories)).toBe(true);
  });

  it("compute/list returns computes via RPC", async () => {
    server = await startWeb();
    const data = await rpcResult(server!.port, "compute/list");
    const result = data.result as Record<string, unknown>;
    expect(Array.isArray(result.targets)).toBe(true);
  });

  it("config/get returns system config via RPC", async () => {
    server = await startWeb();
    const data = await rpcResult(server!.port, "config/get");
    const result = data.result as Record<string, unknown>;
    expect(result).toHaveProperty("hotkeys");
    expect(result).toHaveProperty("theme");
    expect(result).toHaveProperty("profile");
  });

  it("session/events returns events via RPC", async () => {
    const s = getApp().sessions.create({ summary: "events-test" });
    server = await startWeb();
    const data = await rpcResult(server!.port, "session/events", { sessionId: s.id });
    const result = data.result as Record<string, unknown>;
    expect(Array.isArray(result.events)).toBe(true);
  });

  it("flow/list returns flows via RPC", async () => {
    server = await startWeb();
    const data = await rpcResult(server!.port, "flow/list");
    const result = data.result as Record<string, unknown>;
    expect(Array.isArray(result.flows)).toBe(true);
  });

  it("returns method not found for unknown RPC method", async () => {
    server = await startWeb();
    const data = await rpcResult(server!.port, "nonexistent/method");
    expect(data.error).toBeDefined();
    expect((data.error as any).code).toBe(-32601);
  });

  it("returns error for invalid JSON-RPC request", async () => {
    server = await startWeb();
    const resp = await fetch(`${server!.url}/api/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ not: "valid" }),
    });
    expect(resp.status).toBe(400);
  });

  it("daemon/status returns conductor and arkd health", async () => {
    server = await startWeb();
    const data = await rpcResult(server!.port, "daemon/status");
    const result = data.result as Record<string, any>;
    // Verify response shape
    expect(result).toHaveProperty("conductor");
    expect(result).toHaveProperty("arkd");
    expect(result).toHaveProperty("router");
    expect(typeof result.conductor.online).toBe("boolean");
    expect(typeof result.conductor.url).toBe("string");
    expect(result.conductor.url.length).toBeGreaterThan(0);
    expect(typeof result.arkd.online).toBe("boolean");
    expect(typeof result.arkd.url).toBe("string");
    expect(result.arkd.url.length).toBeGreaterThan(0);
    expect(typeof result.router.online).toBe("boolean");
  });

  // --- Terminal WebSocket endpoint tests ---

  it("terminal endpoint returns 400 without session param", async () => {
    server = await startWeb();
    const resp = await fetch(`${server!.url}/api/terminal`);
    expect(resp.status).toBe(400);
  });

  it("terminal endpoint returns 404 for nonexistent session", async () => {
    server = await startWeb();
    const resp = await fetch(`${server!.url}/api/terminal?session=s-nonexistent`);
    expect(resp.status).toBe(404);
  });

  it("terminal endpoint is blocked in read-only mode", async () => {
    const s = getApp().sessions.create({ summary: "terminal-readonly-test" });
    server = await startWeb({ readOnly: true });
    const resp = await fetch(`${server!.url}/api/terminal?session=${s.id}`);
    expect(resp.status).toBe(403);
  });

  it("terminal WebSocket upgrade works for valid session", async () => {
    const s = getApp().sessions.create({ summary: "terminal-ws-test" });
    server = await startWeb();
    // Attempt WebSocket connection -- the tmux session won't exist,
    // so the bridge will send an error and close, but upgrade should succeed
    const ws = new WebSocket(`${server!.url.replace("http://", "ws://")}/api/terminal?session=${s.id}`);
    const messages: string[] = [];
    await new Promise<void>((resolve) => {
      ws.onmessage = (e) => {
        messages.push(typeof e.data === "string" ? e.data : "binary");
      };
      ws.onclose = () => resolve();
      ws.onerror = () => resolve();
      // Timeout after 2s in case nothing happens
      setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* timeout cleanup */
        }
        resolve();
      }, 2000);
    });
    // Should have received either a connected or error message
    expect(messages.length).toBeGreaterThanOrEqual(1);
    const firstMsg = JSON.parse(messages[0]);
    // Since there's no real tmux session, we expect either "connected" (tmux exists) or "error"
    expect(["connected", "error"]).toContain(firstMsg.type);
  });
});
