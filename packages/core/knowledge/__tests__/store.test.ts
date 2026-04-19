import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../../app.js";
import type { KnowledgeStore } from "../store.js";

let app: AppContext;
let store: KnowledgeStore;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
  store = app.knowledge;
});

afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

describe("KnowledgeStore", () => {
  // --- Node CRUD ---

  describe("addNode / getNode", () => {
    it("creates a node with auto-generated id", () => {
      const id = store.addNode({ type: "file", label: "src/app.ts", content: "main entry point" });
      expect(id).toStartWith("file:");
      const node = store.getNode(id);
      expect(node).not.toBeNull();
      expect(node!.type).toBe("file");
      expect(node!.label).toBe("src/app.ts");
      expect(node!.content).toBe("main entry point");
      expect(node!.tenant_id).toBe("default");
      expect(node!.metadata).toEqual({});
    });

    it("creates a node with explicit id", () => {
      const id = store.addNode({ id: "file:custom-id", type: "file", label: "custom.ts" });
      expect(id).toBe("file:custom-id");
      const node = store.getNode(id);
      expect(node).not.toBeNull();
      expect(node!.label).toBe("custom.ts");
    });

    it("stores metadata", () => {
      const id = store.addNode({
        type: "symbol",
        label: "MyClass",
        metadata: { language: "typescript", exported: true },
      });
      const node = store.getNode(id);
      expect(node!.metadata).toEqual({ language: "typescript", exported: true });
    });

    it("returns null for non-existent node", () => {
      expect(store.getNode("nonexistent")).toBeNull();
    });

    it("upserts when addNode is called with an existing id", () => {
      store.addNode({ id: "file:upsert-test", type: "file", label: "original.ts", content: "v1" });
      const v1 = store.getNode("file:upsert-test");
      expect(v1!.label).toBe("original.ts");

      // Second addNode with the same id should replace, not throw
      store.addNode({ id: "file:upsert-test", type: "file", label: "updated.ts", content: "v2" });
      const v2 = store.getNode("file:upsert-test");
      expect(v2!.label).toBe("updated.ts");
      expect(v2!.content).toBe("v2");
    });
  });

  describe("updateNode", () => {
    it("updates label", () => {
      const id = store.addNode({ type: "file", label: "old-label" });
      store.updateNode(id, { label: "new-label" });
      const node = store.getNode(id);
      expect(node!.label).toBe("new-label");
    });

    it("updates content", () => {
      const id = store.addNode({ type: "memory", label: "mem1", content: "original" });
      store.updateNode(id, { content: "updated content" });
      const node = store.getNode(id);
      expect(node!.content).toBe("updated content");
    });

    it("updates metadata", () => {
      const id = store.addNode({ type: "learning", label: "l1", metadata: { a: 1 } });
      store.updateNode(id, { metadata: { a: 2, b: 3 } });
      const node = store.getNode(id);
      expect(node!.metadata).toEqual({ a: 2, b: 3 });
    });

    it("updates updated_at timestamp", () => {
      const id = store.addNode({ type: "file", label: "ts-test" });
      const before = store.getNode(id)!.updated_at;
      // Small delay to ensure timestamp differs
      store.updateNode(id, { label: "ts-test-updated" });
      const after = store.getNode(id)!.updated_at;
      expect(after >= before).toBe(true);
    });

    it("does nothing when no fields provided", () => {
      const id = store.addNode({ type: "file", label: "no-change" });
      const before = store.getNode(id);
      store.updateNode(id, {});
      const after = store.getNode(id);
      expect(after!.label).toBe(before!.label);
    });
  });

  describe("removeNode", () => {
    it("removes a node", () => {
      const id = store.addNode({ type: "file", label: "to-remove" });
      expect(store.getNode(id)).not.toBeNull();
      store.removeNode(id);
      expect(store.getNode(id)).toBeNull();
    });

    it("cascades removal to edges", () => {
      const a = store.addNode({ type: "file", label: "file-a" });
      const b = store.addNode({ type: "file", label: "file-b" });
      store.addEdge(a, b, "imports");
      expect(store.getEdges(a).length).toBe(1);
      store.removeNode(a);
      expect(store.getEdges(b).length).toBe(0);
    });
  });

  describe("listNodes", () => {
    it("lists all nodes", () => {
      // Clear first to get deterministic counts
      store.clear();
      store.addNode({ type: "file", label: "f1" });
      store.addNode({ type: "symbol", label: "s1" });
      store.addNode({ type: "file", label: "f2" });
      const all = store.listNodes();
      expect(all.length).toBe(3);
    });

    it("filters by type", () => {
      store.clear();
      store.addNode({ type: "file", label: "f1" });
      store.addNode({ type: "symbol", label: "s1" });
      store.addNode({ type: "file", label: "f2" });
      const files = store.listNodes({ type: "file" });
      expect(files.length).toBe(2);
      expect(files.every((n) => n.type === "file")).toBe(true);
    });

    it("respects limit", () => {
      store.clear();
      store.addNode({ type: "file", label: "f1" });
      store.addNode({ type: "file", label: "f2" });
      store.addNode({ type: "file", label: "f3" });
      const limited = store.listNodes({ limit: 2 });
      expect(limited.length).toBe(2);
    });
  });

  // --- Edge CRUD ---

  describe("addEdge / getEdges", () => {
    it("creates an edge between two nodes", () => {
      store.clear();
      const a = store.addNode({ type: "file", label: "a.ts" });
      const b = store.addNode({ type: "file", label: "b.ts" });
      store.addEdge(a, b, "imports");
      const edges = store.getEdges(a);
      expect(edges.length).toBe(1);
      expect(edges[0].source_id).toBe(a);
      expect(edges[0].target_id).toBe(b);
      expect(edges[0].relation).toBe("imports");
      expect(edges[0].weight).toBe(1.0);
    });

    it("supports custom weight", () => {
      store.clear();
      const a = store.addNode({ type: "file", label: "a.ts" });
      const b = store.addNode({ type: "file", label: "b.ts" });
      store.addEdge(a, b, "co_changes", 0.85);
      const edges = store.getEdges(a);
      expect(edges[0].weight).toBeCloseTo(0.85);
    });

    it("supports edge metadata", () => {
      store.clear();
      const a = store.addNode({ type: "file", label: "a.ts" });
      const b = store.addNode({ type: "session", label: "s-1" });
      store.addEdge(a, b, "modified_by", 1.0, { commit: "abc123" });
      const edges = store.getEdges(a);
      expect(edges[0].metadata).toEqual({ commit: "abc123" });
    });

    it("filters by direction (out)", () => {
      store.clear();
      const a = store.addNode({ type: "file", label: "a.ts" });
      const b = store.addNode({ type: "file", label: "b.ts" });
      const c = store.addNode({ type: "file", label: "c.ts" });
      store.addEdge(a, b, "imports");
      store.addEdge(c, a, "imports");
      const outEdges = store.getEdges(a, { direction: "out" });
      expect(outEdges.length).toBe(1);
      expect(outEdges[0].target_id).toBe(b);
    });

    it("filters by direction (in)", () => {
      store.clear();
      const a = store.addNode({ type: "file", label: "a.ts" });
      const b = store.addNode({ type: "file", label: "b.ts" });
      const c = store.addNode({ type: "file", label: "c.ts" });
      store.addEdge(a, b, "imports");
      store.addEdge(c, a, "imports");
      const inEdges = store.getEdges(a, { direction: "in" });
      expect(inEdges.length).toBe(1);
      expect(inEdges[0].source_id).toBe(c);
    });

    it("filters by relation", () => {
      store.clear();
      const a = store.addNode({ type: "file", label: "a.ts" });
      const b = store.addNode({ type: "file", label: "b.ts" });
      const c = store.addNode({ type: "session", label: "s-1" });
      store.addEdge(a, b, "imports");
      store.addEdge(a, c, "modified_by");
      const importEdges = store.getEdges(a, { relation: "imports" });
      expect(importEdges.length).toBe(1);
      expect(importEdges[0].target_id).toBe(b);
    });
  });

  describe("removeEdge", () => {
    it("removes an edge by relation", () => {
      store.clear();
      const a = store.addNode({ type: "file", label: "a.ts" });
      const b = store.addNode({ type: "file", label: "b.ts" });
      store.addEdge(a, b, "imports");
      store.addEdge(a, b, "co_changes");
      store.removeEdge(a, b, "imports");
      const edges = store.getEdges(a);
      expect(edges.length).toBe(1);
      expect(edges[0].relation).toBe("co_changes");
    });

    it("removes all edges between two nodes when no relation specified", () => {
      store.clear();
      const a = store.addNode({ type: "file", label: "a.ts" });
      const b = store.addNode({ type: "file", label: "b.ts" });
      store.addEdge(a, b, "imports");
      store.addEdge(a, b, "co_changes");
      store.removeEdge(a, b);
      const edges = store.getEdges(a);
      expect(edges.length).toBe(0);
    });
  });

  // --- Traversal ---

  describe("neighbors", () => {
    it("finds 1-hop neighbors", () => {
      store.clear();
      const a = store.addNode({ type: "file", label: "a.ts" });
      const b = store.addNode({ type: "file", label: "b.ts" });
      const c = store.addNode({ type: "file", label: "c.ts" });
      store.addEdge(a, b, "imports");
      store.addEdge(a, c, "imports");
      const neighbors = store.neighbors(a, { maxDepth: 1 });
      expect(neighbors.length).toBe(2);
      const labels = neighbors.map((n) => n.label).sort();
      expect(labels).toEqual(["b.ts", "c.ts"]);
    });

    it("finds 2-hop neighbors", () => {
      store.clear();
      const a = store.addNode({ type: "file", label: "a.ts" });
      const b = store.addNode({ type: "file", label: "b.ts" });
      const c = store.addNode({ type: "file", label: "c.ts" });
      store.addEdge(a, b, "imports");
      store.addEdge(b, c, "imports");
      const neighbors = store.neighbors(a, { maxDepth: 2 });
      expect(neighbors.length).toBe(2);
      const labels = neighbors.map((n) => n.label).sort();
      expect(labels).toEqual(["b.ts", "c.ts"]);
    });

    it("does not include the starting node", () => {
      store.clear();
      const a = store.addNode({ type: "file", label: "a.ts" });
      const b = store.addNode({ type: "file", label: "b.ts" });
      store.addEdge(a, b, "imports");
      store.addEdge(b, a, "imports"); // cycle back
      const neighbors = store.neighbors(a, { maxDepth: 2 });
      expect(neighbors.length).toBe(1);
      expect(neighbors[0].label).toBe("b.ts");
    });

    it("filters by type", () => {
      store.clear();
      const a = store.addNode({ type: "file", label: "a.ts" });
      const b = store.addNode({ type: "file", label: "b.ts" });
      const s = store.addNode({ type: "session", label: "s-1" });
      store.addEdge(a, b, "imports");
      store.addEdge(a, s, "modified_by");
      const fileNeighbors = store.neighbors(a, { maxDepth: 1, types: ["file"] });
      expect(fileNeighbors.length).toBe(1);
      expect(fileNeighbors[0].label).toBe("b.ts");
    });

    it("filters by relation", () => {
      store.clear();
      const a = store.addNode({ type: "file", label: "a.ts" });
      const b = store.addNode({ type: "file", label: "b.ts" });
      const c = store.addNode({ type: "file", label: "c.ts" });
      store.addEdge(a, b, "imports");
      store.addEdge(a, c, "co_changes");
      const importNeighbors = store.neighbors(a, { maxDepth: 1, relation: "imports" });
      expect(importNeighbors.length).toBe(1);
      expect(importNeighbors[0].label).toBe("b.ts");
    });

    it("defaults to maxDepth 2", () => {
      store.clear();
      const a = store.addNode({ type: "file", label: "a.ts" });
      const b = store.addNode({ type: "file", label: "b.ts" });
      const c = store.addNode({ type: "file", label: "c.ts" });
      const d = store.addNode({ type: "file", label: "d.ts" });
      store.addEdge(a, b, "imports");
      store.addEdge(b, c, "imports");
      store.addEdge(c, d, "imports");
      // Default maxDepth is 2, so d (3 hops) should not be included
      const neighbors = store.neighbors(a);
      expect(neighbors.length).toBe(2);
      const labels = neighbors.map((n) => n.label).sort();
      expect(labels).toEqual(["b.ts", "c.ts"]);
    });
  });

  // --- Search ---

  describe("search", () => {
    it("finds nodes by single word", () => {
      store.clear();
      store.addNode({ type: "file", label: "database.ts", content: "SQLite connection pool" });
      store.addNode({ type: "file", label: "app.ts", content: "main entry point" });
      const results = store.search("database");
      expect(results.length).toBe(1);
      expect(results[0].label).toBe("database.ts");
      expect(results[0].score).toBeGreaterThan(0);
    });

    it("finds nodes by multiple words", () => {
      store.clear();
      store.addNode({ type: "file", label: "database.ts", content: "SQLite connection pool" });
      store.addNode({ type: "learning", label: "connection tips", content: "how to manage connections" });
      const results = store.search("connection pool");
      expect(results.length).toBe(2);
      // The first result should have a higher score (matches both words)
      expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    });

    it("filters by type", () => {
      store.clear();
      store.addNode({ type: "file", label: "auth.ts", content: "authentication module" });
      store.addNode({ type: "learning", label: "auth patterns", content: "authentication best practices" });
      const results = store.search("auth", { types: ["learning"] });
      expect(results.length).toBe(1);
      expect(results[0].type).toBe("learning");
    });

    it("respects limit", () => {
      store.clear();
      store.addNode({ type: "file", label: "a-test", content: "test content" });
      store.addNode({ type: "file", label: "b-test", content: "test content" });
      store.addNode({ type: "file", label: "c-test", content: "test content" });
      const results = store.search("test", { limit: 2 });
      expect(results.length).toBe(2);
    });

    it("returns empty for short queries", () => {
      const results = store.search("a");
      expect(results.length).toBe(0);
    });

    it("returns empty for empty query", () => {
      const results = store.search("");
      expect(results.length).toBe(0);
    });

    it("is case-insensitive", () => {
      store.clear();
      store.addNode({ type: "file", label: "Database.ts", content: "SQLITE Connection" });
      const results = store.search("sqlite");
      expect(results.length).toBe(1);
    });
  });

  // --- Bulk operations ---

  describe("clear", () => {
    it("clears all nodes and edges", () => {
      store.clear();
      const a = store.addNode({ type: "file", label: "a.ts" });
      const b = store.addNode({ type: "file", label: "b.ts" });
      store.addEdge(a, b, "imports");
      expect(store.nodeCount()).toBe(2);
      expect(store.edgeCount()).toBe(1);
      store.clear();
      expect(store.nodeCount()).toBe(0);
      expect(store.edgeCount()).toBe(0);
    });

    it("clears only nodes of a specific type", () => {
      store.clear();
      store.addNode({ type: "file", label: "f1" });
      store.addNode({ type: "symbol", label: "s1" });
      store.addNode({ type: "file", label: "f2" });
      store.clear({ type: "file" });
      expect(store.nodeCount()).toBe(1);
      expect(store.nodeCount("symbol")).toBe(1);
      expect(store.nodeCount("file")).toBe(0);
    });
  });

  describe("nodeCount / edgeCount", () => {
    it("counts all nodes", () => {
      store.clear();
      store.addNode({ type: "file", label: "f1" });
      store.addNode({ type: "symbol", label: "s1" });
      expect(store.nodeCount()).toBe(2);
    });

    it("counts nodes by type", () => {
      store.clear();
      store.addNode({ type: "file", label: "f1" });
      store.addNode({ type: "file", label: "f2" });
      store.addNode({ type: "symbol", label: "s1" });
      expect(store.nodeCount("file")).toBe(2);
      expect(store.nodeCount("symbol")).toBe(1);
    });

    it("counts all edges", () => {
      store.clear();
      const a = store.addNode({ type: "file", label: "a.ts" });
      const b = store.addNode({ type: "file", label: "b.ts" });
      const c = store.addNode({ type: "file", label: "c.ts" });
      store.addEdge(a, b, "imports");
      store.addEdge(a, c, "co_changes");
      expect(store.edgeCount()).toBe(2);
    });

    it("counts edges by relation", () => {
      store.clear();
      const a = store.addNode({ type: "file", label: "a.ts" });
      const b = store.addNode({ type: "file", label: "b.ts" });
      const c = store.addNode({ type: "file", label: "c.ts" });
      store.addEdge(a, b, "imports");
      store.addEdge(a, c, "imports");
      store.addEdge(b, c, "co_changes");
      expect(store.edgeCount("imports")).toBe(2);
      expect(store.edgeCount("co_changes")).toBe(1);
    });
  });

  // --- Tenant isolation ---

  describe("tenant isolation", () => {
    it("tenants do not see each other's nodes", () => {
      store.clear();
      // Create a second store with a different tenant
      const store2 = new (store.constructor as any)(app.db);
      store2.setTenant("tenant-b");

      store.addNode({ id: "file:shared-label", type: "file", label: "shared.ts" });
      store2.addNode({ id: "file:tenant-b-only", type: "file", label: "private.ts" });

      // Default tenant sees only its own node
      expect(store.nodeCount()).toBe(1);
      expect(store.getNode("file:shared-label")).not.toBeNull();
      expect(store.getNode("file:tenant-b-only")).toBeNull();

      // Tenant B sees only its own node
      expect(store2.nodeCount()).toBe(1);
      expect(store2.getNode("file:tenant-b-only")).not.toBeNull();
      expect(store2.getNode("file:shared-label")).toBeNull();

      // Cleanup tenant-b data
      store2.clear();
    });

    it("tenants do not see each other's edges", () => {
      store.clear();
      const store2 = new (store.constructor as any)(app.db);
      store2.setTenant("tenant-c");

      const a = store.addNode({ type: "file", label: "a.ts" });
      const b = store.addNode({ type: "file", label: "b.ts" });
      store.addEdge(a, b, "imports");

      const c = store2.addNode({ type: "file", label: "c.ts" });
      const d = store2.addNode({ type: "file", label: "d.ts" });
      store2.addEdge(c, d, "depends_on");

      expect(store.edgeCount()).toBe(1);
      expect(store2.edgeCount()).toBe(1);
      expect(store.edgeCount("depends_on")).toBe(0);
      expect(store2.edgeCount("imports")).toBe(0);

      // Cleanup
      store2.clear();
    });

    it("search is tenant-scoped", () => {
      store.clear();
      const store2 = new (store.constructor as any)(app.db);
      store2.setTenant("tenant-d");

      store.addNode({ type: "file", label: "visible.ts", content: "this is visible" });
      store2.addNode({ type: "file", label: "hidden.ts", content: "this is hidden" });

      const defaultResults = store.search("visible");
      expect(defaultResults.length).toBe(1);
      const defaultHidden = store.search("hidden");
      expect(defaultHidden.length).toBe(0);

      const tenantResults = store2.search("hidden");
      expect(tenantResults.length).toBe(1);
      const tenantVisible = store2.search("visible");
      expect(tenantVisible.length).toBe(0);

      // Cleanup
      store2.clear();
    });

    it("forTenant on AppContext creates scoped KnowledgeStore", async () => {
      store.clear();
      const scoped = app.forTenant("tenant-e");

      store.addNode({ id: "file:default-node", type: "file", label: "default-only.ts" });
      scoped.knowledge.addNode({ id: "file:tenant-e-node", type: "file", label: "tenant-e-only.ts" });

      expect(store.getNode("file:default-node")).not.toBeNull();
      expect(store.getNode("file:tenant-e-node")).toBeNull();
      expect(scoped.knowledge.getNode("file:tenant-e-node")).not.toBeNull();
      expect(scoped.knowledge.getNode("file:default-node")).toBeNull();

      // Cleanup
      scoped.knowledge.clear();
    });
  });
});
