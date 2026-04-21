/**
 * Tests that ArkClient.close() properly rejects all pending promises.
 */

import { describe, it, expect } from "bun:test";
import { ArkClient } from "../client.js";
import type { Transport } from "../transport.js";
import type { JsonRpcMessage } from "../types.js";

function createBlackHoleTransport(): Transport {
  return {
    send() {},
    onMessage() {},
    close() {},
  };
}

describe("ArkClient.close()", async () => {
  it("rejects pending promises with 'ArkClient closed' error", async () => {
    const client = new ArkClient(createBlackHoleTransport());
    const pending = client.initialize().catch((err) => err);
    client.close();
    const err = await pending;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("ArkClient closed");
  });

  it("rejects multiple pending promises", async () => {
    const client = new ArkClient(createBlackHoleTransport());
    const p1 = client.initialize().catch((err) => err);
    const p2 = client.sessionList().catch((err) => err);
    const p3 = client.agentList().catch((err) => err);
    client.close();
    const [e1, e2, e3] = await Promise.all([p1, p2, p3]);
    expect(e1.message).toBe("ArkClient closed");
    expect(e2.message).toBe("ArkClient closed");
    expect(e3.message).toBe("ArkClient closed");
  });

  it("does not throw when no pending requests exist", () => {
    const client = new ArkClient(createBlackHoleTransport());
    // Should not throw
    expect(() => client.close()).not.toThrow();
  });

  it("no unhandled promise rejections after close", async () => {
    const client = new ArkClient(createBlackHoleTransport());
    // Attach .catch() handlers before close to prevent unhandled rejection
    const promises = [client.initialize().catch((err) => err), client.sessionList().catch((err) => err)];
    client.close();
    const results = await Promise.all(promises);
    for (const r of results) {
      expect(r).toBeInstanceOf(Error);
      expect(r.message).toBe("ArkClient closed");
    }
  });

  it("clears listeners on close", async () => {
    const client = new ArkClient(createBlackHoleTransport());
    const received: any[] = [];
    client.on("test/event", (data) => received.push(data));
    client.initialize().catch(() => {});
    client.close();
    // After close, listeners are cleared -- we just verify no crash
    expect(received.length).toBe(0);
  });
});
