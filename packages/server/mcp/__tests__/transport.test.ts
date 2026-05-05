import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../../../core/app.js";
import { ArkServer } from "../../index.js";
import { registerAllHandlers } from "../../register.js";

let app: AppContext;
let server: ArkServer;
let ws: { stop(): void };
let port: number;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  server = new ArkServer();
  registerAllHandlers(server.router, app);
  server.attachApp(app);
  port = app.config.ports.server;
  ws = server.startWebSocket(port);
});

afterAll(async () => {
  ws?.stop();
  await app?.shutdown();
});

describe("POST /mcp", () => {
  it("returns 200 + initialize result with serverInfo.name=ark-mcp", async () => {
    const resp = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.text();
    expect(body).toContain("serverInfo");
    expect(body).toContain("ark-mcp");
  });

  it("rejects GET /mcp with 405", async () => {
    const resp = await fetch(`http://localhost:${port}/mcp`);
    expect(resp.status).toBe(405);
  });

  it("tools/list returns an array (round-trip shape)", async () => {
    // MCP requires initialize before tools/list can be served on a session,
    // and the Streamable-HTTP transport correlates the two via the
    // Mcp-Session-Id response header. Capture it from the init response and
    // echo it back on the tools/list request.
    const initResp = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }),
    });
    expect(initResp.status).toBe(200);
    const sessionId = initResp.headers.get("mcp-session-id");

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;

    const listResp = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(listResp.status).toBe(200);
    const text = await listResp.text();
    let payload: { id?: number; result?: { tools?: unknown[] } } | null = null;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const json = trimmed.slice("data:".length).trim();
      if (!json.startsWith("{")) continue;
      try {
        const env = JSON.parse(json) as { id?: number; result?: { tools?: unknown[] } };
        if (env.id === 2) {
          payload = env;
          break;
        }
      } catch {
        // not a JSON-RPC envelope on this line; skip
      }
    }
    expect(payload).toBeTruthy();
    expect(Array.isArray(payload?.result?.tools)).toBe(true);

    // Every tool MUST ship a JSON-Schema object with `type: "object"`. Without
    // this, Claude Code's MCP UI silently filters every tool out and shows
    // "no tools" + "SDK auth failed". Regression guard: a Zod-major upgrade
    // can break the converter and re-introduce empty `{}` schemas.
    const tools = payload?.result?.tools as Array<{ name: string; inputSchema: Record<string, unknown> }>;
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.inputSchema, `${tool.name} inputSchema`).toBeTruthy();
      expect(tool.inputSchema.type, `${tool.name} inputSchema.type`).toBe("object");
    }
  });
});
