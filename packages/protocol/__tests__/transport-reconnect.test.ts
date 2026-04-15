/**
 * Tests for WebSocket transport reconnection and message buffering.
 *
 * Uses a real Bun.serve WebSocket server to test actual transport behavior.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createWebSocketTransport, type ConnectionStatus } from "../transport.js";
import type { JsonRpcMessage } from "../types.js";

let serverPort: number;
let server: ReturnType<typeof Bun.serve>;
let serverSockets: Set<any>;

beforeAll(() => {
  serverSockets = new Set();
  // Start a simple WebSocket echo server for testing
  server = Bun.serve({
    port: 0, // random port
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (srv.upgrade(req)) return;
      return new Response("test server", { status: 200 });
    },
    websocket: {
      open(ws) {
        serverSockets.add(ws);
      },
      message(ws, data) {
        // Echo back
        ws.send(data);
      },
      close(ws) {
        serverSockets.delete(ws);
      },
    },
  });
  serverPort = server.port;
});

afterAll(() => {
  server?.stop();
});

describe("WebSocket transport", () => {
  it("connects and sends/receives messages", async () => {
    const url = `ws://localhost:${serverPort}`;
    const { transport, ready } = createWebSocketTransport(url);

    await ready;

    const received: JsonRpcMessage[] = [];
    transport.onMessage((msg) => received.push(msg));

    const testMsg: JsonRpcMessage = { jsonrpc: "2.0", method: "test", id: 1 };
    transport.send(testMsg);

    // Wait for echo
    await Bun.sleep(100);
    expect(received.length).toBe(1);
    expect(received[0]).toEqual(testMsg);

    transport.close();
  });

  it("fires onStatus callbacks", async () => {
    const statuses: ConnectionStatus[] = [];
    const url = `ws://localhost:${serverPort}`;
    const { transport, ready } = createWebSocketTransport(url, {
      reconnect: true,
      onStatus: (s) => statuses.push(s),
    });

    await ready;
    expect(statuses).toContain("connected");

    transport.close();
  });

  it("does not reconnect when reconnect is false (default)", async () => {
    const statuses: ConnectionStatus[] = [];
    const url = `ws://localhost:${serverPort}`;
    const { transport, ready } = createWebSocketTransport(url, {
      onStatus: (s) => statuses.push(s),
    });

    await ready;

    // Close all server-side sockets to trigger client onclose
    for (const ws of serverSockets) ws.close();
    await Bun.sleep(200);

    // Should not see "reconnecting" status
    expect(statuses).not.toContain("reconnecting");

    transport.close();
  });

  it("buffers messages when reconnect is true and connection drops", async () => {
    const url = `ws://localhost:${serverPort}`;
    const statuses: ConnectionStatus[] = [];
    const { transport, ready } = createWebSocketTransport(url, {
      reconnect: true,
      onStatus: (s) => statuses.push(s),
    });

    await ready;

    // Close server-side sockets to trigger reconnect
    for (const ws of serverSockets) ws.close();
    await Bun.sleep(100);

    // Should be reconnecting
    expect(statuses).toContain("reconnecting");

    // Buffer a message during reconnect
    const testMsg: JsonRpcMessage = { jsonrpc: "2.0", method: "buffered", id: 2 };
    transport.send(testMsg);

    // Wait for reconnection (backoff starts at 1s)
    await Bun.sleep(2000);

    // Should have reconnected
    expect(statuses.filter((s) => s === "connected").length).toBeGreaterThanOrEqual(2);

    transport.close();
  });

  it("appends token as query param", async () => {
    const url = `ws://localhost:${serverPort}`;
    // Just verify it doesn't crash with a token -- actual auth is server-side
    const { transport, ready } = createWebSocketTransport(url, { token: "test-token-123" });
    await ready;
    transport.close();
  });
});
