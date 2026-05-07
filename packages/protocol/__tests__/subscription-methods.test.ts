/**
 * Tests for the subscription helpers added in Phase C:
 *   - sessionTreeStream  (session/tree-update notifications)
 *   - terminalSubscribe  (terminal/frame notifications)
 *   - logSubscribe       (log/chunk notifications)
 *   - Notification dispatch fires all registered on() handlers.
 *   - unsubscribe() is idempotent.
 */

import { describe, it, expect } from "bun:test";
import { ArkClient } from "../client.js";
import type { Transport } from "../transport.js";
import type { JsonRpcMessage } from "../types.js";

/**
 * Minimal in-process transport pair. Returns a client whose outbound
 * messages are silently dropped and whose inbound message handler can be
 * triggered via `pushToClient`.
 */
function createStubPair(): {
  client: ArkClient;
  pushToClient: (msg: JsonRpcMessage) => void;
  sentMessages: JsonRpcMessage[];
} {
  let clientHandler: (msg: JsonRpcMessage) => void = () => {};
  const sentMessages: JsonRpcMessage[] = [];

  const clientTransport: Transport = {
    send(msg) {
      sentMessages.push(msg);
    },
    onMessage(h) {
      clientHandler = h;
    },
    close() {},
  };

  const client = new ArkClient(clientTransport);
  return {
    client,
    pushToClient: (msg) => clientHandler(msg),
    sentMessages,
  };
}

/** Push a JSON-RPC notification to the client's inbound handler. */
function makeNotification(method: string, params: Record<string, unknown>): JsonRpcMessage {
  return { jsonrpc: "2.0", method, params } as JsonRpcMessage;
}

/** Push a JSON-RPC success response (resolves a pending rpcCall). */
function makeResponse(id: number, result: unknown): JsonRpcMessage {
  return { jsonrpc: "2.0", id, result } as JsonRpcMessage;
}

// ── Notification dispatch ─────────────────────────────────────────────────────

describe("ArkClient notification dispatch", () => {
  it("fires all handlers registered for a method", () => {
    const { client, pushToClient } = createStubPair();
    const received1: unknown[] = [];
    const received2: unknown[] = [];
    client.on("test/event", (d) => received1.push(d));
    client.on("test/event", (d) => received2.push(d));

    pushToClient(makeNotification("test/event", { value: 42 }));

    expect(received1).toEqual([{ value: 42 }]);
    expect(received2).toEqual([{ value: 42 }]);
    client.close();
  });

  it("does not fire handlers for a different method", () => {
    const { client, pushToClient } = createStubPair();
    const received: unknown[] = [];
    client.on("other/event", (d) => received.push(d));

    pushToClient(makeNotification("test/event", { value: 1 }));

    expect(received).toHaveLength(0);
    client.close();
  });

  it("stops firing after off() removes the handler", () => {
    const { client, pushToClient } = createStubPair();
    const received: unknown[] = [];
    const handler = (d: unknown) => received.push(d);
    client.on("test/event", handler);
    pushToClient(makeNotification("test/event", { value: 1 }));
    client.off("test/event", handler);
    pushToClient(makeNotification("test/event", { value: 2 }));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ value: 1 });
    client.close();
  });
});

// ── sessionTreeStream ─────────────────────────────────────────────────────────

describe("sessionTreeStream", () => {
  it("returns initial tree and calls onUpdate for matching sessionId", async () => {
    const { client, pushToClient, sentMessages } = createStubPair();

    // Respond to the RPC call after a tick.
    const rpcCall = new Promise<void>((resolve) => {
      // Wait for the rpc to be sent, then respond.
      setTimeout(() => {
        const req = sentMessages.find(
          (m): m is { jsonrpc: "2.0"; id: number; method: string; params: unknown } =>
            "method" in m && (m as any).method === "session/tree-stream",
        );
        if (!req) throw new Error("session/tree-stream not sent");
        pushToClient(makeResponse((req as any).id, { tree: { id: "root", children: [] } }));
        resolve();
      }, 0);
    });

    const updates: unknown[] = [];
    const { tree, unsubscribe } = await client.sessionTreeStream("root", (root) => updates.push(root));
    await rpcCall;

    expect(tree).toEqual({ id: "root", children: [] });

    // A matching notification should call onUpdate.
    pushToClient(makeNotification("session/tree-update", { sessionId: "root", root: { id: "root", children: [1] } }));
    expect(updates).toHaveLength(1);

    // A notification for a different session should not.
    pushToClient(makeNotification("session/tree-update", { sessionId: "other", root: {} }));
    expect(updates).toHaveLength(1);

    unsubscribe();
    // After unsubscribe, new notifications should not fire onUpdate.
    pushToClient(makeNotification("session/tree-update", { sessionId: "root", root: { id: "root", children: [2] } }));
    expect(updates).toHaveLength(1);

    client.close();
  });

  it("unsubscribe() is idempotent", async () => {
    const { client, pushToClient, sentMessages } = createStubPair();

    setTimeout(() => {
      const req = sentMessages.find((m) => "method" in m && (m as any).method === "session/tree-stream");
      if (req) pushToClient(makeResponse((req as any).id, { tree: null }));
    }, 0);

    const { unsubscribe } = await client.sessionTreeStream("s1", () => {});

    // Calling unsubscribe multiple times must not throw.
    expect(() => {
      unsubscribe();
      unsubscribe();
      unsubscribe();
    }).not.toThrow();

    client.close();
  });
});

// ── logSubscribe ──────────────────────────────────────────────────────────────

describe("logSubscribe", () => {
  it("returns initial content and decodes log/chunk notifications", async () => {
    const { client, pushToClient, sentMessages } = createStubPair();

    setTimeout(() => {
      const req = sentMessages.find((m) => "method" in m && (m as any).method === "log/subscribe");
      if (req) pushToClient(makeResponse((req as any).id, { initial: "hello", size: 5, exists: true }));
    }, 0);

    const chunks: Buffer[] = [];
    const { initial, unsubscribe } = await client.logSubscribe("sess1", "stdio", (b) => chunks.push(b));

    expect(initial).toBe("hello");

    const encoded = Buffer.from("world").toString("base64");
    pushToClient(makeNotification("log/chunk", { sessionId: "sess1", file: "stdio", bytes: encoded }));

    expect(chunks).toHaveLength(1);
    expect(chunks[0].toString()).toBe("world");

    // Wrong file -- should not trigger.
    pushToClient(
      makeNotification("log/chunk", {
        sessionId: "sess1",
        file: "transcript",
        bytes: Buffer.from("x").toString("base64"),
      }),
    );
    expect(chunks).toHaveLength(1);

    unsubscribe();
    pushToClient(makeNotification("log/chunk", { sessionId: "sess1", file: "stdio", bytes: encoded }));
    expect(chunks).toHaveLength(1);

    client.close();
  });
});
