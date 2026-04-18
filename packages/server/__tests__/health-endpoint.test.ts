/**
 * Tests for the /health JSON endpoint on the ArkServer WebSocket server.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../../core/app.js";
import { ArkServer } from "../index.js";
import { registerAllHandlers } from "../register.js";
import { allocatePort } from "../../core/__tests__/helpers/test-env.js";

let app: AppContext;
let server: ArkServer;
let ws: { stop(): void };
let port: number;

beforeAll(async () => {
  app = AppContext.forTest();
  setApp(app);
  await app.boot();

  server = new ArkServer();
  registerAllHandlers(server.router, app);

  // Allocate an ephemeral port so parallel test files don't collide
  port = await allocatePort();
  ws = server.startWebSocket(port);
});

afterAll(async () => {
  ws?.stop();
  await app?.shutdown();
  clearApp();
});

describe("ArkServer health endpoint", () => {
  it("GET /health returns JSON with status, pid, and uptime", async () => {
    const resp = await fetch(`http://localhost:${port}/health`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("application/json");

    const data = (await resp.json()) as { status: string; pid: number; uptime: number };
    expect(data.status).toBe("ok");
    expect(data.pid).toBe(process.pid);
    expect(typeof data.uptime).toBe("number");
    expect(data.uptime).toBeGreaterThan(0);
  });

  it("GET / returns plain text fallback", async () => {
    const resp = await fetch(`http://localhost:${port}/`);
    expect(resp.status).toBe(200);
    const text = await resp.text();
    expect(text).toContain("Ark Server");
  });

  it("WebSocket upgrade still works on same port", async () => {
    const wsClient = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve, reject) => {
      wsClient.onopen = () => resolve();
      wsClient.onerror = () => reject(new Error("WebSocket connection failed"));
    });
    wsClient.close();
  });
});
