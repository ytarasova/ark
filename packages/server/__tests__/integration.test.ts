import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../../core/app.js";
import { ArkClient } from "../../protocol/client.js";
import { ArkServer } from "../index.js";
import { registerAllHandlers } from "../register.js";
import type { Transport } from "../../protocol/transport.js";
import type { JsonRpcMessage } from "../../protocol/types.js";

let app: AppContext;
beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});
afterAll(async () => {
  await app?.shutdown();
});

function createInMemoryPair(): { client: ArkClient; server: ArkServer } {
  const server = new ArkServer();
  registerAllHandlers(server.router, app);
  server.attachApp(app);

  let clientHandler: (msg: JsonRpcMessage) => void = () => {};
  let serverHandler: (msg: JsonRpcMessage) => void = () => {};

  const clientTransport: Transport = {
    send(msg) {
      setTimeout(() => serverHandler(msg), 0);
    },
    onMessage(h) {
      clientHandler = h;
    },
    close() {},
  };
  const serverTransport: Transport = {
    send(msg) {
      setTimeout(() => clientHandler(msg), 0);
    },
    onMessage(h) {
      serverHandler = h;
    },
    close() {},
  };

  server.addConnection(serverTransport);
  return { client: new ArkClient(clientTransport), server };
}

describe("end-to-end: server + client", async () => {
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
    expect(received.some((r) => r.type === "created")).toBe(true);
    expect(received.find((r) => r.type === "created").data.session.id).toBe(session.id);

    // Update -> should emit session/updated
    received.length = 0;
    await client.sessionUpdate(session.id, { summary: "updated" });
    await Bun.sleep(50);
    expect(received.some((r) => r.type === "updated")).toBe(true);
    expect(received.find((r) => r.type === "updated").data.session.summary).toBe("updated");

    // Delete -> should emit session/deleted
    received.length = 0;
    await client.sessionDelete(session.id);
    await Bun.sleep(50);
    expect(received.some((r) => r.type === "deleted")).toBe(true);
    expect(received.find((r) => r.type === "deleted").data.sessionId).toBe(session.id);

    client.close();
  });

  it("session list filters by status", async () => {
    const { client } = createInMemoryPair();
    await client.initialize();

    // Create two sessions
    const s1 = await client.sessionStart({ summary: "status-test-1", repo: ".", flow: "bare" });
    const s2 = await client.sessionStart({ summary: "status-test-2", repo: ".", flow: "bare" });

    // Mark s1 as completed via update
    await client.sessionUpdate(s1.id, { status: "completed" });

    // List with status=completed should return only s1
    const completed = await client.sessionList({ status: "completed" });
    expect(completed.some((s: any) => s.id === s1.id)).toBe(true);
    expect(completed.some((s: any) => s.id === s2.id)).toBe(false);

    // List with status=ready should return s2 (not s1) -- startSession sets status to "ready"
    const ready = await client.sessionList({ status: "ready" });
    expect(ready.some((s: any) => s.id === s2.id)).toBe(true);
    expect(ready.some((s: any) => s.id === s1.id)).toBe(false);

    // Clean up
    await client.sessionDelete(s1.id);
    await client.sessionDelete(s2.id);
    client.close();
  });

  it("session list without status returns all non-archived sessions", async () => {
    const { client } = createInMemoryPair();
    await client.initialize();

    const s1 = await client.sessionStart({ summary: "all-test-1", repo: ".", flow: "bare" });
    const s2 = await client.sessionStart({ summary: "all-test-2", repo: ".", flow: "bare" });
    // SessionRepository invariant: status="running" requires session_id to be
    // set in the same update delta. The test only cares that s1 is in a
    // non-default state; pass both fields together to satisfy the contract.
    await client.sessionUpdate(s1.id, { status: "running", session_id: `ark-${s1.id}` });

    // List without filter should include both
    const all = await client.sessionList();
    expect(all.some((s: any) => s.id === s1.id)).toBe(true);
    expect(all.some((s: any) => s.id === s2.id)).toBe(true);

    // Clean up
    await client.sessionDelete(s1.id);
    await client.sessionDelete(s2.id);
    client.close();
  });

  it("session list excludes archived by default but includes them when filtered", async () => {
    const { client } = createInMemoryPair();
    await client.initialize();

    const s1 = await client.sessionStart({ summary: "archived-test-active", repo: ".", flow: "bare" });
    const s2 = await client.sessionStart({ summary: "archived-test-old", repo: ".", flow: "bare" });
    await client.sessionUpdate(s2.id, { status: "archived" });

    // Default list should exclude archived
    const all = await client.sessionList();
    expect(all.some((s: any) => s.id === s1.id)).toBe(true);
    expect(all.some((s: any) => s.id === s2.id)).toBe(false);

    // Filtering by archived should return only the archived session
    const archived = await client.sessionList({ status: "archived" });
    expect(archived.some((s: any) => s.id === s2.id)).toBe(true);
    expect(archived.some((s: any) => s.id === s1.id)).toBe(false);

    // Clean up
    await client.sessionDelete(s1.id);
    await client.sessionDelete(s2.id);
    client.close();
  });

  it("session list filters by repo", async () => {
    const { client } = createInMemoryPair();
    await client.initialize();

    const s1 = await client.sessionStart({ summary: "repo-test-1", repo: "my/repo-a", flow: "bare" });
    const s2 = await client.sessionStart({ summary: "repo-test-2", repo: "my/repo-b", flow: "bare" });

    const filtered = await client.sessionList({ repo: "my/repo-a" });
    expect(filtered.some((s: any) => s.id === s1.id)).toBe(true);
    expect(filtered.some((s: any) => s.id === s2.id)).toBe(false);

    // Clean up
    await client.sessionDelete(s1.id);
    await client.sessionDelete(s2.id);
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
