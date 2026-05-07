/**
 * /mcp HTTP route auth gate tests.
 *
 * `materializeContext` returns `anonymousContext()` (it does NOT throw) when
 * `requireToken=true` but no valid bearer token is supplied. The /terminal/
 * route gets away with this because every request carries a session id with
 * its own per-resource ownership gate. The /mcp route has no such gate -- a
 * silent fall-through to "anonymous" tenant would let agent_create and
 * secrets_list write to a phantom tenant.
 *
 * These tests prove the explicit 401 in `index.ts` is wired up:
 *   - requireToken=false: no header succeeds (200)
 *   - requireToken=true:
 *       - no header        -> 401
 *       - wrong token      -> 401
 *       - valid bearer     -> 200
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../../../core/app.js";
import { ArkServer } from "../../index.js";
import { registerAllHandlers } from "../../register.js";

const initBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  },
});

const initHeaders = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

describe("/mcp auth -- requireToken=false", () => {
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
    port = app.config.ports.conductor;
    ws = server.startWebSocket(port);
  });
  afterAll(async () => {
    ws?.stop();
    await app?.shutdown();
  });

  it("accepts request with no Authorization header", async () => {
    const resp = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: initHeaders,
      body: initBody,
    });
    expect(resp.status).toBe(200);
  });
});

describe("/mcp auth -- requireToken=true", () => {
  let app: AppContext;
  let server: ArkServer;
  let ws: { stop(): void };
  let port: number;
  let validToken: string;

  beforeAll(async () => {
    // Follow the terminal-ws-tenant-gate.test.ts pattern: build the test
    // AppContext, then flip requireToken on the resolved config so the
    // server's attachAuth wires the gated path.
    app = await AppContext.forTestAsync();
    (app.config.authSection as { requireToken: boolean }).requireToken = true;
    await app.boot();

    // ApiKeyManager.create(tenantId, name, role) -- returns { key, id }.
    const created = await app.apiKeys.create("default", "test-mcp", "admin");
    validToken = created.key;

    server = new ArkServer();
    registerAllHandlers(server.router, app);
    server.attachAuth(app);
    server.attachApp(app);
    port = app.config.ports.conductor;
    ws = server.startWebSocket(port);
  });
  afterAll(async () => {
    ws?.stop();
    await app?.shutdown();
  });

  it("returns 401 without Authorization header", async () => {
    const resp = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: initHeaders,
      body: initBody,
    });
    expect(resp.status).toBe(401);
  });

  it("returns 401 with wrong token", async () => {
    const resp = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: { ...initHeaders, Authorization: "Bearer wrong-token-XXXXX" },
      body: initBody,
    });
    expect(resp.status).toBe(401);
  });

  it("returns 200 with valid token", async () => {
    const resp = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: { ...initHeaders, Authorization: `Bearer ${validToken}` },
      body: initBody,
    });
    expect(resp.status).toBe(200);
  });
});
