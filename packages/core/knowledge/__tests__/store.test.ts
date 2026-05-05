import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../../app.js";
import type { KnowledgeStore } from "../store.js";

let app: AppContext;
let store: KnowledgeStore;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  store = app.knowledge;
});

afterAll(async () => {
  await app?.shutdown();
});

describe("KnowledgeStore", async () => {
  // --- Node CRUD ---

  describe("addNode / getNode", async () => {
    it("creates a node with auto-generated id", async () => {
      const id = await store.addNode({ type: "file", label: "src/app.ts", content: "main entry point" });
      expect(id).toStartWith("file:");
      const node = await store.getNode(id);
      expect(node).not.toBeNull();
      expect(node!.type).toBe("file");
      expect(node!.label).toBe("src/app.ts");
      expect(node!.content).toBe("main entry point");
      expect(node!.tenant_id).toBe("default");
      expect(node!.metadata).toEqual({});
    });

    it("creates a node with explicit id", async () => {
      const id = await store.addNode({ id: "file:custom-id", type: "file", label: "custom.ts" });
      expect(id).toBe("file:custom-id");
      const node = await store.getNode(id);
      expect(node).not.toBeNull();
      expect(node!.label).toBe("custom.ts");
    });

    it("stores metadata", async () => {
      const id = await store.addNode({
        type: "symbol",
        label: "MyClass",
        metadata: { language: "typescript", exported: true },
      });
      const node = await store.getNode(id);
      expect(node!.metadata).toEqual({ language: "typescript", exported: true });
    });

    it("returns null for non-existent node", async () => {
      expect(await store.getNode("nonexistent")).toBeNull();
    });

    it("upserts when addNode is called with an existing id", async () => {
      await store.addNode({ id: "file:upsert-test", type: "file", label: "original.ts", content: "v1" });
      const v1 = await store.getNode("file:upsert-test");
      expect(v1!.label).toBe("original.ts");

      // Second addNode with the same id should replace, not throw
      await store.addNode({ id: "file:upsert-test", type: "file", label: "updated.ts", content: "v2" });
      const v2 = await store.getNode("file:upsert-test");
      expect(v2!.label).toBe("updated.ts");
      expect(v2!.content).toBe("v2");
    });
  });

  describe("updateNode", async () => {
    it("updates label", async () => {
      const id = await store.addNode({ type: "file", label: "old-label" });
      await store.updateNode(id, { label: "new-label" });
      const node = await store.getNode(id);
      expect(node!.label).toBe("new-label");
    });

    it("updates content", async () => {
      const id = await store.addNode({ type: "memory", label: "mem1", content: "original" });
      await store.updateNode(id, { content: "updated content" });
      const node = await store.getNode(id);
      expect(node!.content).toBe("updated content");
    });

    it("updates metadata", async () => {
      const id = await store.addNode({ type: "learning", label: "l1", metadata: { a: 1 } });
      await store.updateNode(id, { metadata: { a: 2, b: 3 } });
      const node = await store.getNode(id);
      expect(node!.metadata).toEqual({ a: 2, b: 3 });
    });

    it("updates updated_at timestamp", async () => {
      const id = await store.addNode({ type: "file", label: "ts-test" });
      const before = (await store.getNode(id))!.updated_at;
      // Small delay to ensure timestamp differs
      await store.updateNode(id, { label: "ts-test-updated" });
      const after = (await store.getNode(id))!.updated_at;
      expect(after >= before).toBe(true);
    });

    it("does nothing when no fields provided", async () => {
      const id = await store.addNode({ type: "file", label: "no-change" });
      const before = await store.getNode(id);
      await store.updateNode(id, {});
      const after = await store.getNode(id);
      expect(after!.label).toBe(before!.label);
    });
  });

  describe("removeNode", async () => {
    it("removes a node", async () => {
      const id = await store.addNode({ type: "file", label: "to-remove" });
      expect(await store.getNode(id)).not.toBeNull();
      await store.removeNode(id);
      expect(await store.getNode(id)).toBeNull();
    });

    it("cascades removal to edges", async () => {
      const a = await store.addNode({ type: "file", label: "file-a" });
      const b = await store.addNode({ type: "file", label: "file-b" });
      await store.addEdge(a, b, "imports");
      expect((await store.getEdges(a)).length).toBe(1);
      await store.removeNode(a);
      expect((await store.getEdges(b)).length).toBe(0);
    });
  });

  describe("listNodes", async () => {
    it("lists all nodes", async () => {
      // Clear first to get deterministic counts
      await store.clear();
      await store.addNode({ type: "file", label: "f1" });
      await store.addNode({ type: "symbol", label: "s1" });
      await store.addNode({ type: "file", label: "f2" });
      const all = await store.listNodes();
      expect(all.length).toBe(3);
    });

    it("filters by type", async () => {
      await store.clear();
      await store.addNode({ type: "file", label: "f1" });
      await store.addNode({ type: "symbol", label: "s1" });
      await store.addNode({ type: "file", label: "f2" });
      const files = await store.listNodes({ type: "file" });
      expect(files.length).toBe(2);
      expect(files.every((n) => n.type === "file")).toBe(true);
    });

    it("respects limit", async () => {
      await store.clear();
      await store.addNode({ type: "file", label: "f1" });
      await store.addNode({ type: "file", label: "f2" });
      await store.addNode({ type: "file", label: "f3" });
      const limited = await store.listNodes({ limit: 2 });
      expect(limited.length).toBe(2);
    });
  });

  // --- Edge CRUD ---

  describe("addEdge / getEdges", async () => {
    it("creates an edge between two nodes", async () => {
      await store.clear();
      const a = await store.addNode({ type: "file", label: "a.ts" });
      const b = await store.addNode({ type: "file", label: "b.ts" });
      await store.addEdge(a, b, "imports");
      const edges = await store.getEdges(a);
      expect(edges.length).toBe(1);
      expect(edges[0].source_id).toBe(a);
      expect(edges[0].target_id).toBe(b);
      expect(edges[0].relation).toBe("imports");
      expect(edges[0].weight).toBe(1.0);
    });

    it("supports custom weight", async () => {
      await store.clear();
      const a = await store.addNode({ type: "file", label: "a.ts" });
      const b = await store.addNode({ type: "file", label: "b.ts" });
      await store.addEdge(a, b, "co_changes", 0.85);
      const edges = await store.getEdges(a);
      expect(edges[0].weight).toBeCloseTo(0.85);
    });

    it("supports edge metadata", async () => {
      await store.clear();
      const a = await store.addNode({ type: "file", label: "a.ts" });
      const b = await store.addNode({ type: "session", label: "s-1" });
      await store.addEdge(a, b, "modified_by", 1.0, { commit: "abc123" });
      const edges = await store.getEdges(a);
      expect(edges[0].metadata).toEqual({ commit: "abc123" });
    });

    it("filters by direction (out)", async () => {
      await store.clear();
      const a = await store.addNode({ type: "file", label: "a.ts" });
      const b = await store.addNode({ type: "file", label: "b.ts" });
      const c = await store.addNode({ type: "file", label: "c.ts" });
      await store.addEdge(a, b, "imports");
      await store.addEdge(c, a, "imports");
      const outEdges = await store.getEdges(a, { direction: "out" });
      expect(outEdges.length).toBe(1);
      expect(outEdges[0].target_id).toBe(b);
    });

    it("filters by direction (in)", async () => {
      await store.clear();
      const a = await store.addNode({ type: "file", label: "a.ts" });
      const b = await store.addNode({ type: "file", label: "b.ts" });
      const c = await store.addNode({ type: "file", label: "c.ts" });
      await store.addEdge(a, b, "imports");
      await store.addEdge(c, a, "imports");
      const inEdges = await store.getEdges(a, { direction: "in" });
      expect(inEdges.length).toBe(1);
      expect(inEdges[0].source_id).toBe(c);
    });

    it("filters by relation", async () => {
      await store.clear();
      const a = await store.addNode({ type: "file", label: "a.ts" });
      const b = await store.addNode({ type: "file", label: "b.ts" });
      const c = await store.addNode({ type: "session", label: "s-1" });
      await store.addEdge(a, b, "imports");
      await store.addEdge(a, c, "modified_by");
      const importEdges = await store.getEdges(a, { relation: "imports" });
      expect(importEdges.length).toBe(1);
      expect(importEdges[0].target_id).toBe(b);
    });
  });

  describe("removeEdge", async () => {
    it("removes an edge by relation", async () => {
      await store.clear();
      const a = await store.addNode({ type: "file", label: "a.ts" });
      const b = await store.addNode({ type: "file", label: "b.ts" });
      await store.addEdge(a, b, "imports");
      await store.addEdge(a, b, "co_changes");
      await store.removeEdge(a, b, "imports");
      const edges = await store.getEdges(a);
      expect(edges.length).toBe(1);
      expect(edges[0].relation).toBe("co_changes");
    });

    it("removes all edges between two nodes when no relation specified", async () => {
      await store.clear();
      const a = await store.addNode({ type: "file", label: "a.ts" });
      const b = await store.addNode({ type: "file", label: "b.ts" });
      await store.addEdge(a, b, "imports");
      await store.addEdge(a, b, "co_changes");
      await store.removeEdge(a, b);
      const edges = await store.getEdges(a);
      expect(edges.length).toBe(0);
    });
  });

  // --- Traversal ---

  describe("neighbors", async () => {
    it("finds 1-hop neighbors", async () => {
      await store.clear();
      const a = await store.addNode({ type: "file", label: "a.ts" });
      const b = await store.addNode({ type: "file", label: "b.ts" });
      const c = await store.addNode({ type: "file", label: "c.ts" });
      await store.addEdge(a, b, "imports");
      await store.addEdge(a, c, "imports");
      const neighbors = await store.neighbors(a, { maxDepth: 1 });
      expect(neighbors.length).toBe(2);
      const labels = neighbors.map((n) => n.label).sort();
      expect(labels).toEqual(["b.ts", "c.ts"]);
    });

    it("finds 2-hop neighbors", async () => {
      await store.clear();
      const a = await store.addNode({ type: "file", label: "a.ts" });
      const b = await store.addNode({ type: "file", label: "b.ts" });
      const c = await store.addNode({ type: "file", label: "c.ts" });
      await store.addEdge(a, b, "imports");
      await store.addEdge(b, c, "imports");
      const neighbors = await store.neighbors(a, { maxDepth: 2 });
      expect(neighbors.length).toBe(2);
      const labels = neighbors.map((n) => n.label).sort();
      expect(labels).toEqual(["b.ts", "c.ts"]);
    });

    it("does not include the starting node", async () => {
      await store.clear();
      const a = await store.addNode({ type: "file", label: "a.ts" });
      const b = await store.addNode({ type: "file", label: "b.ts" });
      await store.addEdge(a, b, "imports");
      await store.addEdge(b, a, "imports"); // cycle back
      const neighbors = await store.neighbors(a, { maxDepth: 2 });
      expect(neighbors.length).toBe(1);
      expect(neighbors[0].label).toBe("b.ts");
    });

    it("filters by type", async () => {
      await store.clear();
      const a = await store.addNode({ type: "file", label: "a.ts" });
      const b = await store.addNode({ type: "file", label: "b.ts" });
      const s = await store.addNode({ type: "session", label: "s-1" });
      await store.addEdge(a, b, "imports");
      await store.addEdge(a, s, "modified_by");
      const fileNeighbors = await store.neighbors(a, { maxDepth: 1, types: ["file"] });
      expect(fileNeighbors.length).toBe(1);
      expect(fileNeighbors[0].label).toBe("b.ts");
    });

    it("filters by relation", async () => {
      await store.clear();
      const a = await store.addNode({ type: "file", label: "a.ts" });
      const b = await store.addNode({ type: "file", label: "b.ts" });
      const c = await store.addNode({ type: "file", label: "c.ts" });
      await store.addEdge(a, b, "imports");
      await store.addEdge(a, c, "co_changes");
      const importNeighbors = await store.neighbors(a, { maxDepth: 1, relation: "imports" });
      expect(importNeighbors.length).toBe(1);
      expect(importNeighbors[0].label).toBe("b.ts");
    });

    it("defaults to maxDepth 2", async () => {
      await store.clear();
      const a = await store.addNode({ type: "file", label: "a.ts" });
      const b = await store.addNode({ type: "file", label: "b.ts" });
      const c = await store.addNode({ type: "file", label: "c.ts" });
      const d = await store.addNode({ type: "file", label: "d.ts" });
      await store.addEdge(a, b, "imports");
      await store.addEdge(b, c, "imports");
      await store.addEdge(c, d, "imports");
      // Default maxDepth is 2, so d (3 hops) should not be included
      const neighbors = await store.neighbors(a);
      expect(neighbors.length).toBe(2);
      const labels = neighbors.map((n) => n.label).sort();
      expect(labels).toEqual(["b.ts", "c.ts"]);
    });
  });

  // --- Search ---

  describe("search", async () => {
    it("finds nodes by single word", async () => {
      await store.clear();
      await store.addNode({ type: "file", label: "database.ts", content: "SQLite connection pool" });
      await store.addNode({ type: "file", label: "app.ts", content: "main entry point" });
      const results = await store.search("database");
      expect(results.length).toBe(1);
      expect(results[0].label).toBe("database.ts");
      expect(results[0].score).toBeGreaterThan(0);
    });

    it("finds nodes by multiple words", async () => {
      await store.clear();
      await store.addNode({ type: "file", label: "database.ts", content: "SQLite connection pool" });
      await store.addNode({ type: "learning", label: "connection tips", content: "how to manage connections" });
      const results = await store.search("connection pool");
      expect(results.length).toBe(2);
      // The first result should have a higher score (matches both words)
      expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    });

    it("filters by type", async () => {
      await store.clear();
      await store.addNode({ type: "file", label: "auth.ts", content: "authentication module" });
      await store.addNode({ type: "learning", label: "auth patterns", content: "authentication best practices" });
      const results = await store.search("auth", { types: ["learning"] });
      expect(results.length).toBe(1);
      expect(results[0].type).toBe("learning");
    });

    it("respects limit", async () => {
      await store.clear();
      await store.addNode({ type: "file", label: "a-test", content: "test content" });
      await store.addNode({ type: "file", label: "b-test", content: "test content" });
      await store.addNode({ type: "file", label: "c-test", content: "test content" });
      const results = await store.search("test", { limit: 2 });
      expect(results.length).toBe(2);
    });

    it("returns empty for short queries", async () => {
      const results = await store.search("a");
      expect(results.length).toBe(0);
    });

    it("returns empty for empty query", async () => {
      const results = await store.search("");
      expect(results.length).toBe(0);
    });

    it("is case-insensitive", async () => {
      await store.clear();
      await store.addNode({ type: "file", label: "Database.ts", content: "SQLITE Connection" });
      const results = await store.search("sqlite");
      expect(results.length).toBe(1);
    });
  });

  // --- Bulk operations ---

  describe("clear", async () => {
    it("clears all nodes and edges", async () => {
      await store.clear();
      const a = await store.addNode({ type: "file", label: "a.ts" });
      const b = await store.addNode({ type: "file", label: "b.ts" });
      await store.addEdge(a, b, "imports");
      expect(await store.nodeCount()).toBe(2);
      expect(await store.edgeCount()).toBe(1);
      await store.clear();
      expect(await store.nodeCount()).toBe(0);
      expect(await store.edgeCount()).toBe(0);
    });

    it("clears only nodes of a specific type", async () => {
      await store.clear();
      await store.addNode({ type: "file", label: "f1" });
      await store.addNode({ type: "symbol", label: "s1" });
      await store.addNode({ type: "file", label: "f2" });
      await store.clear({ type: "file" });
      expect(await store.nodeCount()).toBe(1);
      expect(await store.nodeCount("symbol")).toBe(1);
      expect(await store.nodeCount("file")).toBe(0);
    });
  });

  describe("nodeCount / edgeCount", async () => {
    it("counts all nodes", async () => {
      await store.clear();
      await store.addNode({ type: "file", label: "f1" });
      await store.addNode({ type: "symbol", label: "s1" });
      expect(await store.nodeCount()).toBe(2);
    });

    it("counts nodes by type", async () => {
      await store.clear();
      await store.addNode({ type: "file", label: "f1" });
      await store.addNode({ type: "file", label: "f2" });
      await store.addNode({ type: "symbol", label: "s1" });
      expect(await store.nodeCount("file")).toBe(2);
      expect(await store.nodeCount("symbol")).toBe(1);
    });

    it("counts all edges", async () => {
      await store.clear();
      const a = await store.addNode({ type: "file", label: "a.ts" });
      const b = await store.addNode({ type: "file", label: "b.ts" });
      const c = await store.addNode({ type: "file", label: "c.ts" });
      await store.addEdge(a, b, "imports");
      await store.addEdge(a, c, "co_changes");
      expect(await store.edgeCount()).toBe(2);
    });

    it("counts edges by relation", async () => {
      await store.clear();
      const a = await store.addNode({ type: "file", label: "a.ts" });
      const b = await store.addNode({ type: "file", label: "b.ts" });
      const c = await store.addNode({ type: "file", label: "c.ts" });
      await store.addEdge(a, b, "imports");
      await store.addEdge(a, c, "imports");
      await store.addEdge(b, c, "co_changes");
      expect(await store.edgeCount("imports")).toBe(2);
      expect(await store.edgeCount("co_changes")).toBe(1);
    });
  });

  // --- Tenant isolation ---

  describe("tenant isolation", async () => {
    it("tenants do not see each other's nodes", async () => {
      await store.clear();
      // Create a second store with a different tenant
      const store2 = new (store.constructor as any)(app.db);
      store2.setTenant("tenant-b");

      await store.addNode({ id: "file:shared-label", type: "file", label: "shared.ts" });
      await store2.addNode({ id: "file:tenant-b-only", type: "file", label: "private.ts" });

      // Default tenant sees only its own node
      expect(await store.nodeCount()).toBe(1);
      expect(await store.getNode("file:shared-label")).not.toBeNull();
      expect(await store.getNode("file:tenant-b-only")).toBeNull();

      // Tenant B sees only its own node
      expect(await store2.nodeCount()).toBe(1);
      expect(await store2.getNode("file:tenant-b-only")).not.toBeNull();
      expect(await store2.getNode("file:shared-label")).toBeNull();

      // Cleanup tenant-b data
      await store2.clear();
    });

    it("tenants do not see each other's edges", async () => {
      await store.clear();
      const store2 = new (store.constructor as any)(app.db);
      store2.setTenant("tenant-c");

      const a = await store.addNode({ type: "file", label: "a.ts" });
      const b = await store.addNode({ type: "file", label: "b.ts" });
      await store.addEdge(a, b, "imports");

      const c = await store2.addNode({ type: "file", label: "c.ts" });
      const d = await store2.addNode({ type: "file", label: "d.ts" });
      await store2.addEdge(c, d, "depends_on");

      expect(await store.edgeCount()).toBe(1);
      expect(await store2.edgeCount()).toBe(1);
      expect(await store.edgeCount("depends_on")).toBe(0);
      expect(await store2.edgeCount("imports")).toBe(0);

      // Cleanup
      await store2.clear();
    });

    it("search is tenant-scoped", async () => {
      await store.clear();
      const store2 = new (store.constructor as any)(app.db);
      store2.setTenant("tenant-d");

      await store.addNode({ type: "file", label: "visible.ts", content: "this is visible" });
      await store2.addNode({ type: "file", label: "hidden.ts", content: "this is hidden" });

      const defaultResults = await store.search("visible");
      expect(defaultResults.length).toBe(1);
      const defaultHidden = await store.search("hidden");
      expect(defaultHidden.length).toBe(0);

      const tenantResults = await store2.search("hidden");
      expect(tenantResults.length).toBe(1);
      const tenantVisible = await store2.search("visible");
      expect(tenantVisible.length).toBe(0);

      // Cleanup
      await store2.clear();
    });

    it("forTenant on AppContext creates scoped KnowledgeStore", async () => {
      await store.clear();
      const scoped = app.forTenant("tenant-e");

      await store.addNode({ id: "file:default-node", type: "file", label: "default-only.ts" });
      await scoped.knowledge.addNode({ id: "file:tenant-e-node", type: "file", label: "tenant-e-only.ts" });

      expect(await store.getNode("file:default-node")).not.toBeNull();
      expect(await store.getNode("file:tenant-e-node")).toBeNull();
      expect(await scoped.knowledge.getNode("file:tenant-e-node")).not.toBeNull();
      expect(await scoped.knowledge.getNode("file:default-node")).toBeNull();

      // Cleanup
      await scoped.knowledge.clear();
    });
  });

  // #480: eval-flagged session nodes share `type: "session"` with
  // production sessions but should NOT surface in production search /
  // listNodes results. They polluted every dispatched agent prompt
  // (`Related Past Sessions` block was almost entirely eval rows).
  describe("eval-node default exclusion", async () => {
    it("listNodes excludes eval-flagged sessions by default", async () => {
      await store.clear();
      await store.addNode({ id: "session:s-prod-1", type: "session", label: "Production work" });
      await store.addNode({
        id: "eval:s-eval-1",
        type: "session",
        label: "Eval: plan-then-implement iteration 0",
        metadata: { eval: true },
      });

      const results = await store.listNodes({ type: "session" });
      const ids = results.map((n) => n.id);
      expect(ids).toContain("session:s-prod-1");
      expect(ids).not.toContain("eval:s-eval-1");
    });

    it("listNodes returns eval nodes when includeEvals is true", async () => {
      await store.clear();
      await store.addNode({
        id: "eval:s-eval-2",
        type: "session",
        label: "Eval: foo",
        metadata: { eval: true },
      });

      const results = await store.listNodes({ type: "session", includeEvals: true });
      expect(results.map((n) => n.id)).toContain("eval:s-eval-2");
    });

    it("search excludes eval-flagged sessions by default", async () => {
      await store.clear();
      await store.addNode({
        id: "session:s-prod-2",
        type: "session",
        label: "plan-then-implement real work",
      });
      await store.addNode({
        id: "eval:s-eval-3",
        type: "session",
        label: "Eval: plan-then-implement iteration 0",
        metadata: { eval: true },
      });

      const results = await store.search("plan-then-implement");
      const ids = results.map((n) => n.id);
      expect(ids).toContain("session:s-prod-2");
      expect(ids).not.toContain("eval:s-eval-3");
    });

    it("search returns eval nodes when includeEvals is true", async () => {
      await store.clear();
      await store.addNode({
        id: "eval:s-eval-4",
        type: "session",
        label: "Eval: prod query target",
        metadata: { eval: true },
      });

      const results = await store.search("prod query target", { includeEvals: true });
      expect(results.map((n) => n.id)).toContain("eval:s-eval-4");
    });
  });
});
