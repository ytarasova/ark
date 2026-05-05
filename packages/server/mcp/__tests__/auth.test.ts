/**
 * /mcp HTTP route auth gate tests.
 *
 * The `/mcp` route is gated in BOTH local and hosted profiles (#421):
 *
 *   - `requireToken=false`, no arkd.token on disk: grandfather open path
 *     (fresh install before the daemon has booted). Every request passes.
 *   - `requireToken=false`, arkd.token on disk: local profile with the
 *     daemon already booted. Callers MUST present the same bearer `ark
 *     token` prints; no-header / wrong-token return 401, matching token
 *     returns 200. Query-string `?token=` also accepted.
 *   - `requireToken=true`: hosted profile. Caller MUST present a valid
 *     ApiKey bearer; materializeContext falls back to anonymous on invalid
 *     and the /mcp route throws an explicit 401 on anonymous tenant.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
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
    port = app.config.ports.server;
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
    port = app.config.ports.server;
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

describe("/mcp auth -- requireToken=false + arkd.token on disk", () => {
  // Third mode: the process is running in local profile (single-tenant,
  // requireToken=false) but the daemon has booted at least once and written
  // an `arkd.token` to the ark dir. The MCP route must gate on that token
  // so an opportunistic localhost caller (DNS-rebinding browser tab, a
  // second user on the host) cannot reach Tier-1/Tier-2 MCP tools.
  const LOCAL_TOKEN = "local-arkd-test-bearer-XYZ123";
  let app: AppContext;
  let server: ArkServer;
  let ws: { stop(): void };
  let port: number;

  beforeAll(async () => {
    app = await AppContext.forTestAsync();
    // Write arkd.token BEFORE attachAuth so readLocalBearer picks it up.
    mkdirSync(app.config.dirs.ark, { recursive: true });
    writeFileSync(join(app.config.dirs.ark, "arkd.token"), LOCAL_TOKEN, { mode: 0o600 });
    await app.boot();

    server = new ArkServer();
    registerAllHandlers(server.router, app);
    server.attachAuth(app);
    server.attachApp(app);
    port = app.config.ports.server;
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

  it("returns 200 with matching local token", async () => {
    const resp = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: { ...initHeaders, Authorization: `Bearer ${LOCAL_TOKEN}` },
      body: initBody,
    });
    expect(resp.status).toBe(200);
  });

  it("returns 200 with matching token via ?token= query param", async () => {
    const resp = await fetch(`http://localhost:${port}/mcp?token=${encodeURIComponent(LOCAL_TOKEN)}`, {
      method: "POST",
      headers: initHeaders,
      body: initBody,
    });
    expect(resp.status).toBe(200);
  });
});
