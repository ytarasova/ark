import { describe, it, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test";

setDefaultTimeout(10_000);
import { AppContext, setApp, clearApp } from "../../core/app.js";
import { ArkClient } from "../../protocol/client.js";
import { ArkServer } from "../index.js";
import { registerAllHandlers } from "../register.js";
import type { Transport } from "../../protocol/transport.js";
import type { JsonRpcMessage } from "../../protocol/types.js";

let app: AppContext;
beforeAll(async () => {
  app = AppContext.forTest();
  setApp(app);
  await app.boot();
});
afterAll(() => {
  clearApp();
});

function createInMemoryPair(): { client: ArkClient; server: ArkServer } {
  const server = new ArkServer();
  registerAllHandlers(server.router, app);

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

describe("list RPC handlers", () => {
  describe("session/list filters", () => {
    it("filters by group_name", async () => {
      const { client } = createInMemoryPair();
      await client.initialize();

      const s1 = await client.sessionStart({ summary: "group-a", repo: ".", flow: "bare" });
      const s2 = await client.sessionStart({ summary: "group-b", repo: ".", flow: "bare" });
      await client.sessionUpdate(s1.id, { group_name: "alpha" });
      await client.sessionUpdate(s2.id, { group_name: "beta" });

      const filtered = await client.sessionList({ group_name: "alpha" });
      expect(filtered.some((s: any) => s.id === s1.id)).toBe(true);
      expect(filtered.some((s: any) => s.id === s2.id)).toBe(false);

      await client.sessionDelete(s1.id);
      await client.sessionDelete(s2.id);
      client.close();
    });

    it("filters by groupPrefix", async () => {
      const { client } = createInMemoryPair();
      await client.initialize();

      const s1 = await client.sessionStart({ summary: "prefix-1", repo: ".", flow: "bare" });
      const s2 = await client.sessionStart({ summary: "prefix-2", repo: ".", flow: "bare" });
      const s3 = await client.sessionStart({ summary: "prefix-3", repo: ".", flow: "bare" });
      await client.sessionUpdate(s1.id, { group_name: "deploy-v1" });
      await client.sessionUpdate(s2.id, { group_name: "deploy-v2" });
      await client.sessionUpdate(s3.id, { group_name: "review-1" });

      const filtered = await client.sessionList({ groupPrefix: "deploy" });
      expect(filtered.some((s: any) => s.id === s1.id)).toBe(true);
      expect(filtered.some((s: any) => s.id === s2.id)).toBe(true);
      expect(filtered.some((s: any) => s.id === s3.id)).toBe(false);

      await client.sessionDelete(s1.id);
      await client.sessionDelete(s2.id);
      await client.sessionDelete(s3.id);
      client.close();
    });

    it("filters by flow", async () => {
      const { client } = createInMemoryPair();
      await client.initialize();

      const s1 = await client.sessionStart({ summary: "flow-bare", repo: ".", flow: "bare" });
      const s2 = await client.sessionStart({ summary: "flow-default", repo: ".", flow: "default" });

      const filtered = await client.sessionList({ flow: "bare" });
      expect(filtered.some((s: any) => s.id === s1.id)).toBe(true);
      expect(filtered.some((s: any) => s.id === s2.id)).toBe(false);

      await client.sessionDelete(s1.id);
      await client.sessionDelete(s2.id);
      client.close();
    });

    it("filters by parent_id", async () => {
      const { client } = createInMemoryPair();
      await client.initialize();

      const parent = await client.sessionStart({ summary: "parent", repo: ".", flow: "bare" });
      const child = await client.sessionStart({ summary: "child", repo: ".", flow: "bare" });
      app.sessions.update(child.id, { parent_id: parent.id });

      const children = await client.sessionList({ parent_id: parent.id });
      expect(children.some((s: any) => s.id === child.id)).toBe(true);
      expect(children.some((s: any) => s.id === parent.id)).toBe(false);

      await client.sessionDelete(child.id);
      await client.sessionDelete(parent.id);
      client.close();
    });

    it("respects limit parameter", async () => {
      const { client } = createInMemoryPair();
      await client.initialize();

      const s1 = await client.sessionStart({ summary: "limit-1", repo: "limit-test-repo", flow: "bare" });
      const s2 = await client.sessionStart({ summary: "limit-2", repo: "limit-test-repo", flow: "bare" });
      const s3 = await client.sessionStart({ summary: "limit-3", repo: "limit-test-repo", flow: "bare" });

      const limited = await client.sessionList({ repo: "limit-test-repo", limit: 2 });
      expect(limited.length).toBe(2);

      await client.sessionDelete(s1.id);
      await client.sessionDelete(s2.id);
      await client.sessionDelete(s3.id);
      client.close();
    });

    it("combines multiple filters", async () => {
      const { client } = createInMemoryPair();
      await client.initialize();

      const s1 = await client.sessionStart({ summary: "combo-1", repo: "combo/repo-a", flow: "bare" });
      const s2 = await client.sessionStart({ summary: "combo-2", repo: "combo/repo-b", flow: "bare" });
      await client.sessionUpdate(s1.id, { group_name: "combo-group" });
      await client.sessionUpdate(s2.id, { group_name: "combo-group" });

      const filtered = await client.sessionList({ repo: "combo/repo-a", group_name: "combo-group" });
      expect(filtered.some((s: any) => s.id === s1.id)).toBe(true);
      expect(filtered.some((s: any) => s.id === s2.id)).toBe(false);

      await client.sessionDelete(s1.id);
      await client.sessionDelete(s2.id);
      client.close();
    });
  });

  describe("resource list endpoints", () => {
    it("agent/list returns an array of agents", async () => {
      const { client } = createInMemoryPair();
      await client.initialize();

      const agents = await client.agentList();
      expect(Array.isArray(agents)).toBe(true);
      expect(agents.length).toBeGreaterThan(0);
      expect(agents[0]).toHaveProperty("name");

      client.close();
    });

    it("flow/list returns an array of flows", async () => {
      const { client } = createInMemoryPair();
      await client.initialize();

      const flows = await client.flowList();
      expect(Array.isArray(flows)).toBe(true);
      expect(flows.length).toBeGreaterThan(0);
      expect(flows[0]).toHaveProperty("name");

      client.close();
    });

    it("skill/list returns an array of skills", async () => {
      const { client } = createInMemoryPair();
      await client.initialize();

      const skills = await client.skillList();
      expect(Array.isArray(skills)).toBe(true);
      expect(skills.length).toBeGreaterThan(0);
      expect(skills[0]).toHaveProperty("name");

      client.close();
    });

    it("runtime/list returns an array of runtimes", async () => {
      const { client } = createInMemoryPair();
      await client.initialize();

      const runtimes = await client.runtimeList();
      expect(Array.isArray(runtimes)).toBe(true);
      expect(runtimes.length).toBeGreaterThan(0);
      expect(runtimes[0]).toHaveProperty("name");

      client.close();
    });

    it("recipe/list returns an array of recipes", async () => {
      const { client } = createInMemoryPair();
      await client.initialize();

      const recipes = await client.recipeList();
      expect(Array.isArray(recipes)).toBe(true);

      client.close();
    });

    it("compute/list returns an array", async () => {
      const { client } = createInMemoryPair();
      await client.initialize();

      const computes = await client.computeList();
      expect(Array.isArray(computes)).toBe(true);

      client.close();
    });

    it("compute/template/list returns an array", async () => {
      const { client } = createInMemoryPair();
      await client.initialize();

      const result = await client.computeTemplateList();
      expect(result).toHaveProperty("templates");
      expect(Array.isArray(result.templates)).toBe(true);

      client.close();
    });

    it("group/list returns an array", async () => {
      const { client } = createInMemoryPair();
      await client.initialize();

      const groups = await client.groupList();
      expect(Array.isArray(groups)).toBe(true);

      client.close();
    });
  });

  describe("group lifecycle with list", () => {
    it("created group appears in group/list", async () => {
      const { client } = createInMemoryPair();
      await client.initialize();

      await client.groupCreate("test-list-group");
      const groups = await client.groupList();
      expect(groups.some((g: any) => g.name === "test-list-group")).toBe(true);

      await client.groupDelete("test-list-group");
      const after = await client.groupList();
      expect(after.some((g: any) => g.name === "test-list-group")).toBe(false);

      client.close();
    });
  });

  describe("todo/list", () => {
    it("returns todos for a session", async () => {
      const { client } = createInMemoryPair();
      await client.initialize();

      const session = await client.sessionStart({ summary: "todo-test", repo: ".", flow: "bare" });
      const result = await client.todoList(session.id);
      expect(result).toHaveProperty("todos");
      expect(Array.isArray(result.todos)).toBe(true);

      await client.sessionDelete(session.id);
      client.close();
    });
  });
});
