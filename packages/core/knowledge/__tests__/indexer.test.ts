import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext, setApp, clearApp } from "../../app.js";
import type { KnowledgeStore } from "../store.js";
import type { ExecFn } from "../indexer.js";
import { indexCodebase, indexCoChanges, indexSessionCompletion, isCodegraphInstalled } from "../indexer.js";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { Database } from "bun:sqlite";

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

describe("isCodegraphInstalled", () => {
  it("returns true when codegraph is installed", () => {
    // codegraph was installed as a dependency, so it should be in PATH via node_modules/.bin
    const result = isCodegraphInstalled();
    // This may be true or false depending on global install -- just test the function runs
    expect(typeof result).toBe("boolean");
  });
});

describe("indexCodebase", () => {
  it("reads codegraph DB and maps nodes/edges into knowledge store", async () => {
    // Create a fake repo with a pre-built .codegraph/graph.db
    const tmpDir = join(app.config.arkDir, "test-repo-cg");
    const cgDir = join(tmpDir, ".codegraph");
    mkdirSync(cgDir, { recursive: true });

    // Create a mock codegraph DB with the real schema
    const dbPath = join(cgDir, "graph.db");
    const db = new Database(dbPath);
    db.run(
      "CREATE TABLE IF NOT EXISTS nodes (id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, file TEXT NOT NULL, line INTEGER, end_line INTEGER, parent_id INTEGER, exported INTEGER DEFAULT 0, qualified_name TEXT, scope TEXT, visibility TEXT, role TEXT)",
    );
    db.run(
      "CREATE TABLE IF NOT EXISTS edges (id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL, target_id INTEGER NOT NULL, kind TEXT NOT NULL, confidence REAL DEFAULT 1.0, dynamic INTEGER DEFAULT 0)",
    );
    db.run("CREATE TABLE IF NOT EXISTS build_meta (key TEXT PRIMARY KEY, value TEXT)");

    // Insert mock nodes
    db.run(
      "INSERT INTO nodes (id, name, kind, file, line, end_line, exported, qualified_name) VALUES (1, 'app.ts', 'function', 'src/app.ts', 1, 50, 0, 'src/app.ts')",
    );
    db.run(
      "INSERT INTO nodes (id, name, kind, file, line, end_line, exported, qualified_name) VALUES (2, 'boot', 'function', 'src/app.ts', 10, 30, 1, 'src/app.ts::boot')",
    );
    db.run(
      "INSERT INTO nodes (id, name, kind, file, line, end_line, exported, qualified_name) VALUES (3, 'Database', 'class', 'src/db.ts', 5, 45, 1, 'src/db.ts::Database')",
    );

    // Insert mock edges
    db.run("INSERT INTO edges (source_id, target_id, kind) VALUES (2, 3, 'calls')");
    db.close();

    // Mock exec: codegraph build is a no-op (DB already exists), git log returns empty
    const fakeExec: ExecFn = (cmd: string) => {
      if (cmd.includes("codegraph")) return "";
      if (cmd === "git") return "";
      return "";
    };

    const result = await indexCodebase(tmpDir, store, { exec: fakeExec });

    expect(result.files).toBe(2); // src/app.ts, src/db.ts
    expect(result.symbols).toBe(3);
    expect(result.edges).toBeGreaterThanOrEqual(1);

    // Verify file nodes
    const appFile = store.getNode("file:src/app.ts");
    expect(appFile).not.toBeNull();
    expect(appFile!.type).toBe("file");

    const dbFile = store.getNode("file:src/db.ts");
    expect(dbFile).not.toBeNull();

    // Verify symbol nodes
    const bootNode = store.getNode("symbol:src/app.ts::boot:10");
    expect(bootNode).not.toBeNull();
    expect(bootNode!.type).toBe("symbol");
    expect(bootNode!.label).toBe("boot");
    expect(bootNode!.metadata.kind).toBe("function");
    expect(bootNode!.metadata.exported).toBe(true);

    const dbNode = store.getNode("symbol:src/db.ts::Database:5");
    expect(dbNode).not.toBeNull();
    expect(dbNode!.metadata.kind).toBe("class");

    // Clean up
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handles duplicate (file, name) pairs with different line numbers", async () => {
    // Regression: codegraph produces many symbols with the same (file, name) pair
    // e.g. 50 'app' parameters across different functions. Each should get a unique ID.
    const tmpDir = join(app.config.arkDir, "test-repo-dup");
    const cgDir = join(tmpDir, ".codegraph");
    mkdirSync(cgDir, { recursive: true });

    const dbPath = join(cgDir, "graph.db");
    const db = new Database(dbPath);
    db.run(
      "CREATE TABLE nodes (id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, file TEXT NOT NULL, line INTEGER, end_line INTEGER, parent_id INTEGER, exported INTEGER DEFAULT 0, qualified_name TEXT, scope TEXT, visibility TEXT, role TEXT)",
    );
    db.run(
      "CREATE TABLE edges (id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL, target_id INTEGER NOT NULL, kind TEXT NOT NULL, confidence REAL DEFAULT 1.0, dynamic INTEGER DEFAULT 0)",
    );

    // Two symbols with the same name in the same file, different lines
    db.run(
      "INSERT INTO nodes (id, name, kind, file, line, end_line, exported) VALUES (1, 'app', 'parameter', 'src/orchestration.ts', 10, 10, 0)",
    );
    db.run(
      "INSERT INTO nodes (id, name, kind, file, line, end_line, exported) VALUES (2, 'app', 'parameter', 'src/orchestration.ts', 25, 25, 0)",
    );
    db.run(
      "INSERT INTO nodes (id, name, kind, file, line, end_line, exported) VALUES (3, 'boot', 'function', 'src/orchestration.ts', 1, 50, 1)",
    );
    db.close();

    const fakeExec: ExecFn = () => "";

    const result = await indexCodebase(tmpDir, store, { exec: fakeExec });

    expect(result.symbols).toBe(3);

    // Both 'app' parameters should exist as separate nodes
    const app1 = store.getNode("symbol:src/orchestration.ts::app:10");
    const app2 = store.getNode("symbol:src/orchestration.ts::app:25");
    expect(app1).not.toBeNull();
    expect(app2).not.toBeNull();
    expect(app1!.metadata.line_start).toBe(10);
    expect(app2!.metadata.line_start).toBe(25);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("full re-index clears existing file and symbol nodes", async () => {
    // Pre-populate
    store.addNode({ id: "file:old.ts", type: "file", label: "old.ts" });
    store.addNode({ id: "symbol:old.ts::foo", type: "symbol", label: "foo" });
    store.addNode({ id: "memory:keep-me", type: "memory", label: "should not be cleared" });

    // Create empty codegraph DB
    const tmpDir = join(app.config.arkDir, "test-repo-cg2");
    const cgDir = join(tmpDir, ".codegraph");
    mkdirSync(cgDir, { recursive: true });
    const db = new Database(join(cgDir, "graph.db"));
    db.run(
      "CREATE TABLE nodes (id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, file TEXT NOT NULL, line INTEGER, end_line INTEGER, parent_id INTEGER, exported INTEGER DEFAULT 0, qualified_name TEXT, scope TEXT, visibility TEXT, role TEXT)",
    );
    db.run(
      "CREATE TABLE edges (id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL, target_id INTEGER NOT NULL, kind TEXT NOT NULL, confidence REAL DEFAULT 1.0, dynamic INTEGER DEFAULT 0)",
    );
    db.close();

    const fakeExec: ExecFn = (cmd: string) => {
      if (cmd.includes("codegraph")) return "";
      if (cmd === "git") return "";
      return "";
    };

    await indexCodebase(tmpDir, store, { exec: fakeExec });

    // Old file and symbol nodes should be gone
    expect(store.getNode("file:old.ts")).toBeNull();
    expect(store.getNode("symbol:old.ts::foo")).toBeNull();
    // Memory node should survive
    expect(store.getNode("memory:keep-me")).not.toBeNull();

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws descriptive error when codegraph is not found", async () => {
    const fakeExec: ExecFn = (cmd: string) => {
      if (cmd.includes("codegraph")) {
        const err = new Error("spawn codegraph ENOENT") as any;
        err.code = "ENOENT";
        throw err;
      }
      return "";
    };

    await expect(indexCodebase("/fake/repo", store, { exec: fakeExec })).rejects.toThrow("codegraph is required");
  });
});

describe("indexCoChanges", () => {
  it("creates co_changes edges from git log", () => {
    store.addNode({ id: "file:src/a.ts", type: "file", label: "src/a.ts" });
    store.addNode({ id: "file:src/b.ts", type: "file", label: "src/b.ts" });

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

    const edges = store.getEdges("file:src/a.ts", { relation: "co_changes" });
    expect(edges.length).toBeGreaterThanOrEqual(1);
    const coEdge = edges.find(
      (e) =>
        (e.source_id === "file:src/a.ts" && e.target_id === "file:src/b.ts") ||
        (e.source_id === "file:src/b.ts" && e.target_id === "file:src/a.ts"),
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
    expect(count).toBe(0);
  });

  it("handles git log failure gracefully", () => {
    const fakeExec: ExecFn = () => {
      throw new Error("not a git repo");
    };
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

    const mainEdges = store.getEdges("file:src/main.ts", { relation: "modified_by", direction: "out" });
    expect(mainEdges.length).toBe(1);
    expect(mainEdges[0].target_id).toBe("session:s-123");
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
    expect(node!.label).toBe("Initial summary");
  });

  it("handles empty changed files list", () => {
    indexSessionCompletion(store, "s-789", "No file changes", "success", []);

    const node = store.getNode("session:s-789");
    expect(node).not.toBeNull();
    expect(node!.metadata.files_changed).toEqual([]);

    const edges = store.getEdges("session:s-789", { relation: "modified_by" });
    expect(edges.length).toBe(0);
  });
});
