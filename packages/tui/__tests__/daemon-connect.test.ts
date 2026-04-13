/**
 * Integration test: daemon boot + ArkClient WebSocket connect.
 *
 * Starts a real ArkServer (backed by AppContext.forTest()), connects via
 * WebSocket transport, and verifies basic RPC operations work.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../../core/app.js";
import { ArkServer } from "../../server/index.js";
import { registerAllHandlers } from "../../server/register.js";
import { ArkClient } from "../../protocol/client.js";
import { createWebSocketTransport } from "../../protocol/transport.js";

let app: AppContext;
let server: ArkServer;
let ws: { stop(): void };
const PORT = 19488;

beforeAll(async () => {
  app = AppContext.forTest();
  setApp(app);
  await app.boot();

  server = new ArkServer();
  registerAllHandlers(server.router, app);
  ws = server.startWebSocket(PORT);
});

afterAll(async () => {
  ws?.stop();
  await app?.shutdown();
  clearApp();
});

describe("daemon connect", () => {
  it("connects to server via WebSocket and lists sessions", async () => {
    const { transport, ready } = createWebSocketTransport(`ws://localhost:${PORT}`, {
      reconnect: true,
    });
    await ready;

    const client = new ArkClient(transport);
    const info = await client.initialize({ subscribe: ["**"] });
    expect(info.server.name).toBe("ark-server");

    const sessions = await client.sessionList();
    expect(Array.isArray(sessions)).toBe(true);

    client.close();
  });

  it("health endpoint is reachable", async () => {
    const resp = await fetch(`http://localhost:${PORT}/health`);
    expect(resp.status).toBe(200);
    const data = await resp.json() as { status: string };
    expect(data.status).toBe("ok");
  });

  it("multiple clients can connect simultaneously", async () => {
    const clients: ArkClient[] = [];

    for (let i = 0; i < 3; i++) {
      const { transport, ready } = createWebSocketTransport(`ws://localhost:${PORT}`);
      await ready;
      const client = new ArkClient(transport);
      await client.initialize({ subscribe: ["**"] });
      clients.push(client);
    }

    // All clients should be able to list sessions
    for (const client of clients) {
      const sessions = await client.sessionList();
      expect(Array.isArray(sessions)).toBe(true);
    }

    for (const client of clients) client.close();
  });

  it("client can create a session and read it back", async () => {
    const { transport, ready } = createWebSocketTransport(`ws://localhost:${PORT}`);
    await ready;

    const client = new ArkClient(transport);
    await client.initialize({ subscribe: ["**"] });

    // Create a session
    const session = await client.sessionStart({ summary: "round-trip test", repo: "/tmp", flow: "bare" });
    expect(session.id).toMatch(/^s-/);

    // Read it back
    const result = await client.sessionRead(session.id);
    expect(result.session.summary).toBe("round-trip test");

    client.close();
  });
});
