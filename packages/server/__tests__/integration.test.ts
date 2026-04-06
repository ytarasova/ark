import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestContext, setContext, type TestContext } from "../../core/context.js";
import { ArkClient } from "../../protocol/client.js";
import { ArkServer } from "../index.js";
import { registerAllHandlers } from "../register.js";
import type { Transport } from "../../protocol/transport.js";
import type { JsonRpcMessage } from "../../protocol/types.js";

let ctx: TestContext;
beforeEach(() => { ctx = createTestContext(); setContext(ctx); });
afterEach(() => { ctx.cleanup(); });

function createInMemoryPair(): { client: ArkClient; server: ArkServer } {
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

describe("end-to-end: server + client", () => {
  it("full session lifecycle over protocol", async () => {
    const { client } = createInMemoryPair();
    const info = await client.initialize({ subscribe: ["session/*"] });
    expect(info.server.name).toBe("ark-server");

    // Create
    const session = await client.sessionStart({ summary: "e2e test", repo: ".", flow: "bare" });
    expect(session.id).toMatch(/^s-/);

    // List
    const sessions = await client.sessionList();
    expect(sessions.some((s: any) => s.id === session.id)).toBe(true);

    // Read
    const detail = await client.sessionRead(session.id);
    expect(detail.session.summary).toBe("e2e test");

    // Update
    const updated = await client.sessionUpdate(session.id, { summary: "e2e updated" });
    expect(updated.summary).toBe("e2e updated");

    // Delete
    await client.sessionDelete(session.id);
    client.close();
  });

  it("notification delivery to subscribed client", async () => {
    const { client, server } = createInMemoryPair();
    await client.initialize({ subscribe: ["session/*"] });

    const received: any[] = [];
    client.on("session/created", (data) => received.push(data));

    server.notify("session/created", { session: { id: "s-notify-test" } });
    await Bun.sleep(50);

    expect(received.length).toBe(1);
    expect(received[0].session.id).toBe("s-notify-test");
    client.close();
  });

  it("unsubscribed notifications are not delivered", async () => {
    const { client, server } = createInMemoryPair();
    await client.initialize({ subscribe: ["session/*"] });

    const received: any[] = [];
    client.on("metrics/updated", (data) => received.push(data));

    server.notify("metrics/updated", { snapshot: {} });
    await Bun.sleep(50);

    expect(received.length).toBe(0);
    client.close();
  });

  it("session mutations emit notifications to subscribed clients", async () => {
    const { client } = createInMemoryPair();
    await client.initialize({ subscribe: ["session/*"] });

    const received: any[] = [];
    client.on("session/created", (data) => received.push({ type: "created", data }));
    client.on("session/updated", (data) => received.push({ type: "updated", data }));
    client.on("session/deleted", (data) => received.push({ type: "deleted", data }));

    // Create -> should emit session/created
    const session = await client.sessionStart({ summary: "notify-test", repo: ".", flow: "bare" });
    await Bun.sleep(50);
    expect(received.some(r => r.type === "created")).toBe(true);
    expect(received.find(r => r.type === "created").data.session.id).toBe(session.id);

    // Update -> should emit session/updated
    received.length = 0;
    await client.sessionUpdate(session.id, { summary: "updated" });
    await Bun.sleep(50);
    expect(received.some(r => r.type === "updated")).toBe(true);
    expect(received.find(r => r.type === "updated").data.session.summary).toBe("updated");

    // Delete -> should emit session/deleted
    received.length = 0;
    await client.sessionDelete(session.id);
    await Bun.sleep(50);
    expect(received.some(r => r.type === "deleted")).toBe(true);
    expect(received.find(r => r.type === "deleted").data.sessionId).toBe(session.id);

    client.close();
  });

  it("resource queries work", async () => {
    const { client } = createInMemoryPair();
    await client.initialize();

    const agents = await client.agentList();
    expect(Array.isArray(agents)).toBe(true);

    const flows = await client.flowList();
    expect(Array.isArray(flows)).toBe(true);

    client.close();
  });
});
