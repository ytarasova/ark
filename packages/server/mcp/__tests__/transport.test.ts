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
});
