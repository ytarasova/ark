import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext, setApp, clearApp } from "../../app.js";
import type { KnowledgeStore } from "../store.js";
import type { ExecFn } from "../indexer.js";
import { indexCodebase, indexCoChanges, indexSessionCompletion, isAxonInstalled } from "../indexer.js";

let app: AppContext;
let store: KnowledgeStore;

beforeAll(async () => {
  app = AppContext.forTest();
  await app.boot();
  setApp(app);
  store = app.knowledge;
});

afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

beforeEach(() => {
  store.clear();
});

describe("isAxonInstalled", () => {
  it("returns true when exec succeeds", () => {
    const fakeExec: ExecFn = () => "axon 1.0.0";
    expect(isAxonInstalled(fakeExec)).toBe(true);
  });

  it("returns false when exec throws", () => {
    const fakeExec: ExecFn = () => { throw new Error("not found"); };
    expect(isAxonInstalled(fakeExec)).toBe(false);
  });
});

describe("indexCodebase", () => {
  it("parses mock Axon JSON output into nodes and edges", async () => {
    const mockAxonOutput = JSON.stringify({
      nodes: [
        { type: "file", path: "src/app.ts", language: "typescript", lines: 100, summary: "main entry" },
        { type: "file", path: "src/db.ts", language: "typescript", lines: 50 },
        { type: "function", name: "boot", file: "src/app.ts", line_start: 10, line_end: 30, exported: true, docstring: "Boot the app" },
        { type: "class", name: "Database", file: "src/db.ts", line_start: 5, line_end: 45, exported: true },
      ],
      edges: [
        { source: "src/app.ts", target: "src/db.ts", source_type: "file", target_type: "file", type: "imports", weight: 1.0 },
      ],
    });

    const fakeExec: ExecFn = (cmd: string) => {
      if (cmd === "axon") return mockAxonOutput;
      if (cmd === "git") return ""; // empty git log
      return "";
    };

    const result = await indexCodebase("/fake/repo", store, { exec: fakeExec });

    expect(result.files).toBe(2);
    expect(result.symbols).toBe(2);
    expect(result.edges).toBeGreaterThanOrEqual(1); // at least the axon edge

    // Verify file nodes
    const appNode = store.getNode("file:src/app.ts");
    expect(appNode).not.toBeNull();
    expect(appNode!.type).toBe("file");
    expect(appNode!.label).toBe("src/app.ts");
    expect(appNode!.content).toBe("main entry");
    expect(appNode!.metadata.language).toBe("typescript");

    // Verify symbol nodes
    const bootNode = store.getNode("symbol:src/app.ts::boot");
    expect(bootNode).not.toBeNull();
    expect(bootNode!.type).toBe("symbol");
    expect(bootNode!.label).toBe("boot");
    expect(bootNode!.content).toBe("Boot the app");
    expect(bootNode!.metadata.kind).toBe("function");
    expect(bootNode!.metadata.exported).toBe(true);

    // Verify edges
    const edges = store.getEdges("file:src/app.ts", { relation: "imports" });
    expect(edges.length).toBe(1);
    expect(edges[0].target_id).toBe("file:src/db.ts");
  });

  it("full re-index clears existing file and symbol nodes", async () => {
    // Pre-populate
    store.addNode({ id: "file:old.ts", type: "file", label: "old.ts" });
    store.addNode({ id: "symbol:old.ts::foo", type: "symbol", label: "foo" });
    store.addNode({ id: "memory:keep-me", type: "memory", label: "should not be cleared" });

    const fakeExec: ExecFn = (cmd: string) => {
      if (cmd === "axon") return JSON.stringify({ nodes: [], edges: [] });
      if (cmd === "git") return "";
      return "";
    };

    await indexCodebase("/fake/repo", store, { exec: fakeExec });

    // Old file and symbol nodes should be gone
    expect(store.getNode("file:old.ts")).toBeNull();
    expect(store.getNode("symbol:old.ts::foo")).toBeNull();
    // Memory node should survive
    expect(store.getNode("memory:keep-me")).not.toBeNull();
  });

  it("incremental indexing removes only changed file nodes", async () => {
    // Pre-populate
    store.addNode({ id: "file:keep.ts", type: "file", label: "keep.ts" });
    store.addNode({ id: "file:changed.ts", type: "file", label: "changed.ts" });
    store.addNode({ id: "symbol:changed.ts::bar", type: "symbol", label: "bar", metadata: { file: "changed.ts" } });
    store.addNode({ id: "symbol:keep.ts::baz", type: "symbol", label: "baz", metadata: { file: "keep.ts" } });

    const mockAxonOutput = JSON.stringify({
      nodes: [
        { type: "file", path: "changed.ts", language: "typescript", lines: 20 },
        { type: "function", name: "barNew", file: "changed.ts", line_start: 1, line_end: 10 },
      ],
      edges: [],
    });

    const fakeExec: ExecFn = (cmd: string) => {
      if (cmd === "axon") return mockAxonOutput;
      if (cmd === "git") return "";
      return "";
    };

    await indexCodebase("/fake/repo", store, { incremental: true, changedFiles: ["changed.ts"], exec: fakeExec });

    // keep.ts should still be there
    expect(store.getNode("file:keep.ts")).not.toBeNull();
    expect(store.getNode("symbol:keep.ts::baz")).not.toBeNull();
    // changed.ts should be re-indexed with new data
    expect(store.getNode("file:changed.ts")).not.toBeNull();
    expect(store.getNode("symbol:changed.ts::bar")).toBeNull(); // old symbol gone
    expect(store.getNode("symbol:changed.ts::barNew")).not.toBeNull(); // new symbol present
  });

  it("throws descriptive error when Axon is not found", async () => {
    const fakeExec: ExecFn = (cmd: string) => {
      if (cmd === "axon") {
        const err = new Error("spawn axon ENOENT") as any;
        err.code = "ENOENT";
        throw err;
      }
      return "";
    };

    await expect(indexCodebase("/fake/repo", store, { exec: fakeExec })).rejects.toThrow("Axon is required");
  });
});

describe("indexCoChanges", () => {
  it("creates co_changes edges from git log", () => {
    // Ensure file nodes exist for the edges
    store.addNode({ id: "file:src/a.ts", type: "file", label: "src/a.ts" });
    store.addNode({ id: "file:src/b.ts", type: "file", label: "src/b.ts" });

    // Mock git log output: 4 commits where a.ts and b.ts appear together in 3
    const gitLog = [
      "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111",
      "src/a.ts",
      "src/b.ts",
      "",
      "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222",
      "src/a.ts",
      "src/b.ts",
      "",
      "cccc3333cccc3333cccc3333cccc3333cccc3333",
      "src/a.ts",
      "src/b.ts",
      "",
      "dddd4444dddd4444dddd4444dddd4444dddd4444",
      "src/c.ts",
      "",
    ].join("\n");

    const fakeExec: ExecFn = () => gitLog;

    const count = indexCoChanges("/fake/repo", store, { exec: fakeExec });
    expect(count).toBeGreaterThanOrEqual(1);

    // Check the co_changes edge exists
    const edges = store.getEdges("file:src/a.ts", { relation: "co_changes" });
    expect(edges.length).toBeGreaterThanOrEqual(1);
    const coEdge = edges.find(e =>
      (e.source_id === "file:src/a.ts" && e.target_id === "file:src/b.ts") ||
      (e.source_id === "file:src/b.ts" && e.target_id === "file:src/a.ts")
    );
    expect(coEdge).not.toBeUndefined();
    expect(coEdge!.weight).toBeGreaterThan(0);
  });

  it("does not create edges for files changing together fewer than 3 times", () => {
    const gitLog = [
      "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111",
      "src/x.ts",
      "src/y.ts",
      "",
      "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222",
      "src/x.ts",
      "src/y.ts",
      "",
      "cccc3333cccc3333cccc3333cccc3333cccc3333",
      "src/z.ts",
      "",
    ].join("\n");

    const fakeExec: ExecFn = () => gitLog;
    const count = indexCoChanges("/fake/repo", store, { exec: fakeExec });
    expect(count).toBe(0); // only 2 co-occurrences, threshold is 3
  });

  it("handles git log failure gracefully", () => {
    const fakeExec: ExecFn = () => { throw new Error("not a git repo"); };
    const count = indexCoChanges("/not/a/repo", store, { exec: fakeExec });
    expect(count).toBe(0);
  });
});

describe("indexSessionCompletion", () => {
  it("creates session node and modified_by edges", () => {
    store.addNode({ id: "file:src/main.ts", type: "file", label: "src/main.ts" });
    store.addNode({ id: "file:src/utils.ts", type: "file", label: "src/utils.ts" });

    indexSessionCompletion(store, "s-123", "Fix login bug", "success", ["src/main.ts", "src/utils.ts"]);

    const sessionNode = store.getNode("session:s-123");
    expect(sessionNode).not.toBeNull();
    expect(sessionNode!.type).toBe("session");
    expect(sessionNode!.label).toBe("Fix login bug");
    expect(sessionNode!.metadata.outcome).toBe("success");
    expect(sessionNode!.metadata.files_changed).toEqual(["src/main.ts", "src/utils.ts"]);

    // Check modified_by edges
    const mainEdges = store.getEdges("file:src/main.ts", { relation: "modified_by", direction: "out" });
    expect(mainEdges.length).toBe(1);
    expect(mainEdges[0].target_id).toBe("session:s-123");

    const utilEdges = store.getEdges("file:src/utils.ts", { relation: "modified_by", direction: "out" });
    expect(utilEdges.length).toBe(1);
    expect(utilEdges[0].target_id).toBe("session:s-123");
  });

  it("updates existing session node", () => {
    store.addNode({
      id: "session:s-456",
      type: "session",
      label: "Initial summary",
      content: "old content",
      metadata: { outcome: "running" },
    });

    indexSessionCompletion(store, "s-456", "Updated summary", "success", ["src/app.ts"]);

    const node = store.getNode("session:s-456");
    expect(node).not.toBeNull();
    expect(node!.metadata.outcome).toBe("success");
    expect(node!.metadata.files_changed).toEqual(["src/app.ts"]);
    // Label should stay as original since we update metadata only
    expect(node!.label).toBe("Initial summary");
  });

  it("handles empty changed files list", () => {
    indexSessionCompletion(store, "s-789", "No file changes", "success", []);

    const node = store.getNode("session:s-789");
    expect(node).not.toBeNull();
    expect(node!.metadata.files_changed).toEqual([]);

    // No modified_by edges
    const edges = store.getEdges("session:s-789", { relation: "modified_by" });
    expect(edges.length).toBe(0);
  });
});
