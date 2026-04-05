import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestContext, setContext, type TestContext } from "../../core/context.js";
import { ArkClient } from "../client.js";
import { ArkServer } from "../../server/index.js";
import { registerAllHandlers } from "../../server/register.js";
import type { Transport } from "../transport.js";
import type { JsonRpcMessage } from "../types.js";

let ctx: TestContext;
beforeEach(() => { ctx = createTestContext(); setContext(ctx); });
afterEach(() => { ctx.cleanup(); });

function createPair(): { client: ArkClient; server: ArkServer } {
  const server = new ArkServer();
  registerAllHandlers(server.router);

  let clientHandler: (msg: JsonRpcMessage) => void = () => {};
  let serverHandler: (msg: JsonRpcMessage) => void = () => {};

  const clientTransport: Transport = {
    send(msg) { setTimeout(() => serverHandler(msg), 0); },
    onMessage(h) { clientHandler = h; },
    close() {},
  };
  const serverTransport: Transport = {
    send(msg) { setTimeout(() => clientHandler(msg), 0); },
    onMessage(h) { serverHandler = h; },
    close() {},
  };

  server.addConnection(serverTransport);
  return { client: new ArkClient(clientTransport), server };
}

describe("ArkClient", () => {
  it("initializes and gets server info", async () => {
    const { client } = createPair();
    const info = await client.initialize();
    expect(info.server.name).toBe("ark-server");
    expect(info.server.version).toBeTruthy();
    client.close();
  });

  it("creates and lists sessions", async () => {
    const { client } = createPair();
    await client.initialize();
    const session = await client.sessionStart({ summary: "client-test", repo: ".", flow: "bare" });
    expect(session.id).toBeTruthy();
    expect(session.summary).toBe("client-test");
    const sessions = await client.sessionList();
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.some((s: any) => s.id === session.id)).toBe(true);
    client.close();
  });

  it("reads session detail", async () => {
    const { client } = createPair();
    await client.initialize();
    const session = await client.sessionStart({ summary: "read-test", repo: ".", flow: "bare" });
    const detail = await client.sessionRead(session.id);
    expect(detail.session.id).toBe(session.id);
    expect(detail.session.summary).toBe("read-test");
    client.close();
  });

  it("reads session with events include", async () => {
    const { client } = createPair();
    await client.initialize();
    const session = await client.sessionStart({ summary: "include-test", repo: ".", flow: "bare" });
    const detail = await client.sessionRead(session.id, ["events"]);
    expect(detail.session.id).toBe(session.id);
    expect(detail.events).toBeDefined();
    client.close();
  });

  it("updates session fields", async () => {
    const { client } = createPair();
    await client.initialize();
    const session = await client.sessionStart({ summary: "update-test", repo: ".", flow: "bare" });
    const updated = await client.sessionUpdate(session.id, { summary: "updated-summary" });
    expect(updated.summary).toBe("updated-summary");
    client.close();
  });

  it("deletes and verifies session removal from list", async () => {
    const { client } = createPair();
    await client.initialize();
    const session = await client.sessionStart({ summary: "delete-test", repo: ".", flow: "bare" });
    await client.sessionDelete(session.id);
    // After delete, session should not appear in list (soft-delete)
    const sessions = await client.sessionList();
    const found = sessions.find((s: any) => s.id === session.id);
    // Soft-deleted sessions may still appear with deleted status
    if (found) {
      expect(found.status).toBe("deleted");
    }
    client.close();
  });

  it("receives notifications", async () => {
    const { client, server } = createPair();
    await client.initialize({ subscribe: ["session/*"] });
    const received: any[] = [];
    client.on("session/updated", (data) => received.push(data));
    server.notify("session/updated", { session: { id: "s-test" } });
    await Bun.sleep(50);
    expect(received.length).toBe(1);
    expect(received[0].session.id).toBe("s-test");
    client.close();
  });

  it("supports removing notification listeners with off()", async () => {
    const { client, server } = createPair();
    await client.initialize({ subscribe: ["session/*"] });
    const received: any[] = [];
    const handler = (data: any) => received.push(data);
    client.on("session/updated", handler);
    server.notify("session/updated", { session: { id: "s-1" } });
    await Bun.sleep(50);
    expect(received.length).toBe(1);
    client.off("session/updated", handler);
    server.notify("session/updated", { session: { id: "s-2" } });
    await Bun.sleep(50);
    expect(received.length).toBe(1); // still 1, handler was removed
    client.close();
  });

  it("handles RPC errors gracefully", async () => {
    const { client } = createPair();
    await client.initialize();
    try {
      await client.sessionRead("s-nonexistent");
      expect(true).toBe(false); // should not reach here
    } catch (err: any) {
      expect(err.message).toContain("not found");
      expect(err.code).toBe(-32002);
    }
    client.close();
  });

  it("rejects pending requests on close()", async () => {
    let clientHandler: (msg: JsonRpcMessage) => void = () => {};
    // Create a transport that never responds
    const blackHoleTransport: Transport = {
      send() {},
      onMessage(h) { clientHandler = h; },
      close() {},
    };
    const client = new ArkClient(blackHoleTransport);
    const promise = client.initialize();
    client.close();
    try {
      await promise;
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toBe("Client closed");
    }
  });

  it("lists resources (agents, flows, skills, recipes)", async () => {
    const { client } = createPair();
    await client.initialize();
    const agents = await client.agentList();
    expect(Array.isArray(agents)).toBe(true);
    const flows = await client.flowList();
    expect(Array.isArray(flows)).toBe(true);
    const skills = await client.skillList();
    expect(Array.isArray(skills)).toBe(true);
    const recipes = await client.recipeList();
    expect(Array.isArray(recipes)).toBe(true);
    client.close();
  });

  it("reads config", async () => {
    const { client } = createPair();
    await client.initialize();
    const config = await client.configRead();
    expect(config).toBeDefined();
    client.close();
  });

  it("queries session events and messages", async () => {
    const { client } = createPair();
    await client.initialize();
    const session = await client.sessionStart({ summary: "query-test", repo: ".", flow: "bare" });
    const events = await client.sessionEvents(session.id);
    expect(Array.isArray(events)).toBe(true);
    const messages = await client.sessionMessages(session.id);
    expect(Array.isArray(messages)).toBe(true);
    client.close();
  });

  it("auto-increments request IDs", async () => {
    const sentIds: number[] = [];
    let clientHandler: (msg: JsonRpcMessage) => void = () => {};

    const spyTransport: Transport = {
      send(msg) {
        if ("id" in msg && "method" in msg) sentIds.push(msg.id as number);
      },
      onMessage(h) { clientHandler = h; },
      close() {},
    };
    const client = new ArkClient(spyTransport);
    // Fire off multiple requests (they won't resolve, but we can check IDs)
    client.initialize().catch(() => {});
    client.sessionList().catch(() => {});
    client.agentList().catch(() => {});
    // Give microtasks a chance
    await Bun.sleep(10);
    expect(sentIds).toEqual([1, 2, 3]);
    client.close();
  });
});
