import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext, setApp, clearApp } from "../../app.js";
import type { KnowledgeStore } from "../store.js";
import { buildContext, formatContextAsMarkdown } from "../context.js";

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

describe("buildContext", () => {
  it("returns empty package for empty store", () => {
    const ctx = buildContext(store, "fix the login bug");
    expect(ctx.files).toEqual([]);
    expect(ctx.memories).toEqual([]);
    expect(ctx.sessions).toEqual([]);
    expect(ctx.learnings).toEqual([]);
    expect(ctx.skills).toEqual([]);
  });

  it("finds memories by keyword", () => {
    store.addNode({
      id: "memory:auth-tip",
      type: "memory",
      label: "Auth requires token refresh",
      content: "Always refresh the authentication token before API calls",
      metadata: { importance: 0.9, scope: "global" },
    });
    store.addNode({
      id: "memory:unrelated",
      type: "memory",
      label: "Database tuning",
      content: "Index columns used in WHERE clauses",
      metadata: { importance: 0.5, scope: "global" },
    });

    const ctx = buildContext(store, "fix authentication token issue");
    expect(ctx.memories.length).toBeGreaterThanOrEqual(1);
    const authMemory = ctx.memories.find(m => m.content.includes("authentication token"));
    expect(authMemory).not.toBeUndefined();
    expect(authMemory!.importance).toBe(0.9);
  });

  it("includes file neighbors", () => {
    const fileA = store.addNode({ id: "file:src/auth.ts", type: "file", label: "src/auth.ts", metadata: { language: "typescript" } });
    const fileB = store.addNode({ id: "file:src/session.ts", type: "file", label: "src/session.ts", metadata: { language: "typescript" } });
    store.addEdge(fileA, fileB, "imports");

    const ctx = buildContext(store, "update auth", { files: ["src/auth.ts"] });
    // Should include src/session.ts as a neighbor of src/auth.ts
    const sessionFile = ctx.files.find(f => f.path === "src/session.ts");
    expect(sessionFile).not.toBeUndefined();
  });

  it("excludes current session", () => {
    store.addNode({
      id: "session:s-current",
      type: "session",
      label: "Current session task",
      content: "Working on fixing the login bug",
      metadata: { outcome: "running", files_changed: [] },
    });
    store.addNode({
      id: "session:s-past",
      type: "session",
      label: "Past login fix",
      content: "Fixed login redirect bug",
      metadata: { outcome: "success", files_changed: ["src/login.ts"] },
    });

    const ctx = buildContext(store, "fix login bug", { sessionId: "s-current" });
    const sessionIds = ctx.sessions.map(s => s.id);
    expect(sessionIds).not.toContain("s-current");
    // Past session may or may not be found depending on search match, but current should never appear
  });

  it("populates file context with dependents count and recent sessions", () => {
    store.addNode({ id: "file:src/utils.ts", type: "file", label: "src/utils.ts", content: "utility functions", metadata: { language: "typescript" } });
    store.addNode({ id: "file:src/a.ts", type: "file", label: "src/a.ts", metadata: { language: "typescript" } });
    store.addNode({ id: "file:src/b.ts", type: "file", label: "src/b.ts", metadata: { language: "typescript" } });
    store.addNode({ id: "session:s-old", type: "session", label: "Refactored utils", metadata: { outcome: "success" } });

    store.addEdge("file:src/a.ts", "file:src/utils.ts", "imports");
    store.addEdge("file:src/b.ts", "file:src/utils.ts", "imports");
    store.addEdge("file:src/utils.ts", "session:s-old", "modified_by");

    const ctx = buildContext(store, "update utility functions");
    const utilsFile = ctx.files.find(f => f.path === "src/utils.ts");
    expect(utilsFile).not.toBeUndefined();
    expect(utilsFile!.language).toBe("typescript");
    expect(utilsFile!.dependents).toBe(2); // two files import it
    expect(utilsFile!.recent_sessions.length).toBe(1);
    expect(utilsFile!.recent_sessions[0].id).toBe("s-old");
  });

  it("sorts memories by importance descending", () => {
    store.addNode({
      id: "memory:low",
      type: "memory",
      label: "Low importance test tip",
      content: "Low importance test memory",
      metadata: { importance: 0.2, scope: "global" },
    });
    store.addNode({
      id: "memory:high",
      type: "memory",
      label: "High importance test tip",
      content: "High importance test memory",
      metadata: { importance: 0.95, scope: "global" },
    });
    store.addNode({
      id: "memory:mid",
      type: "memory",
      label: "Mid importance test tip",
      content: "Mid importance test memory",
      metadata: { importance: 0.6, scope: "global" },
    });

    const ctx = buildContext(store, "test memory importance");
    expect(ctx.memories.length).toBeGreaterThanOrEqual(2);
    // Verify sorted by importance descending
    for (let i = 1; i < ctx.memories.length; i++) {
      expect(ctx.memories[i - 1].importance).toBeGreaterThanOrEqual(ctx.memories[i].importance);
    }
  });

  it("respects limit", () => {
    // Add many memories
    for (let i = 0; i < 20; i++) {
      store.addNode({
        id: `memory:bulk-${i}`,
        type: "memory",
        label: `Bulk memory number ${i}`,
        content: `Bulk test content number ${i}`,
        metadata: { importance: 0.5, scope: "global" },
      });
    }

    const ctx = buildContext(store, "bulk test content number", { limit: 5 });
    expect(ctx.memories.length).toBeLessThanOrEqual(5);
  });

  it("populates learnings from search results", () => {
    store.addNode({
      id: "learning:testing-tip",
      type: "learning",
      label: "Sequential Testing Required",
      content: "Tests must run sequentially to avoid port collisions",
    });

    const ctx = buildContext(store, "run tests sequentially");
    const found = ctx.learnings.find(l => l.title === "Sequential Testing Required");
    expect(found).not.toBeUndefined();
    expect(found!.description).toContain("port collisions");
  });
});

describe("formatContextAsMarkdown", () => {
  it("returns empty string for empty package", () => {
    const result = formatContextAsMarkdown({
      files: [],
      memories: [],
      sessions: [],
      learnings: [],
      skills: [],
    });
    expect(result).toBe("");
  });

  it("produces valid markdown with all sections", () => {
    const md = formatContextAsMarkdown({
      files: [{ path: "src/app.ts", language: "typescript", dependents: 3, recent_sessions: [] }],
      memories: [{ content: "Always test first", importance: 0.9, scope: "global" }],
      sessions: [{ id: "s-1", summary: "Fixed auth", outcome: "success", files_changed: ["src/auth.ts"], date: "2026-04-01" }],
      learnings: [{ title: "Use worktrees", description: "Isolate parallel work" }],
      skills: [{ name: "code-review", description: "Structured review process" }],
    });

    expect(md).toContain("---");
    expect(md).toContain("# Context (auto-generated)");
    expect(md).toContain("## Relevant Knowledge");
    expect(md).toContain("Always test first");
    expect(md).toContain("## Related Past Sessions");
    expect(md).toContain("**s-1**: Fixed auth");
    expect(md).toContain("## Key Files");
    expect(md).toContain("`src/app.ts`");
    expect(md).toContain("3 dependents");
    expect(md).toContain("## Learnings");
    expect(md).toContain("**Use worktrees**");
    expect(md).toContain("## Applicable Skills");
    expect(md).toContain("**code-review**");
  });

  it("omits sections with no items", () => {
    const md = formatContextAsMarkdown({
      files: [],
      memories: [{ content: "Only memories here", importance: 0.5, scope: "global" }],
      sessions: [],
      learnings: [],
      skills: [],
    });

    expect(md).toContain("## Relevant Knowledge");
    expect(md).not.toContain("## Related Past Sessions");
    expect(md).not.toContain("## Key Files");
    expect(md).not.toContain("## Learnings");
    expect(md).not.toContain("## Applicable Skills");
  });

  it("formats session with files_changed list", () => {
    const md = formatContextAsMarkdown({
      files: [],
      memories: [],
      sessions: [{ id: "s-2", summary: "Multi-file fix", outcome: "success", files_changed: ["a.ts", "b.ts"], date: "2026-04-01" }],
      learnings: [],
      skills: [],
    });

    expect(md).toContain("changed: a.ts, b.ts");
  });
});
