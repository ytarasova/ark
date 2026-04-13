/**
 * Tests for daemon health probe.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { checkDaemonHealth } from "../health.js";

describe("checkDaemonHealth", () => {
  let stopServer: (() => void) | null = null;

  afterEach(() => {
    if (stopServer) { stopServer(); stopServer = null; }
  });

  it("returns true for a healthy WS server", async () => {
    // Start a minimal WS server that responds to initialize
    const server = Bun.serve({
      port: 0, // random free port
      hostname: "127.0.0.1",
      fetch(req, server) {
        if (server.upgrade(req)) return;
        return new Response("ok");
      },
      websocket: {
        message(ws, data) {
          try {
            const msg = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data as unknown as ArrayBuffer));
            if (msg.method === "initialize") {
              ws.send(JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                result: { server: { name: "test", version: "1.0" } },
              }));
            }
          } catch { /* ignore */ }
        },
        open() {},
        close() {},
      },
    });
    stopServer = () => server.stop();

    const healthy = await checkDaemonHealth(`ws://127.0.0.1:${server.port}`);
    expect(healthy).toBe(true);
  });

  it("returns false when nothing is listening", async () => {
    const healthy = await checkDaemonHealth("ws://127.0.0.1:59999", 500);
    expect(healthy).toBe(false);
  });

  it("returns false for invalid URL", async () => {
    const healthy = await checkDaemonHealth("ws://[invalid", 500);
    expect(healthy).toBe(false);
  });

  it("returns false when server doesn't respond to initialize (timeout)", async () => {
    // Server that accepts WS but never responds
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, server) {
        if (server.upgrade(req)) return;
        return new Response("ok");
      },
      websocket: {
        message() { /* intentionally do nothing */ },
        open() {},
        close() {},
      },
    });
    stopServer = () => server.stop();

    const healthy = await checkDaemonHealth(`ws://127.0.0.1:${server.port}`, 500);
    expect(healthy).toBe(false);
  });
});
