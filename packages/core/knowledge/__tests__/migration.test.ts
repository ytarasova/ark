import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, unlinkSync, rmSync } from "fs";
import { join } from "path";
import { AppContext, setApp, clearApp } from "../../app.js";
import type { KnowledgeStore } from "../store.js";
import { migrateMemories, migrateLearnings, runKnowledgeMigrations } from "../migration.js";

let app: AppContext;
let store: KnowledgeStore;
let arkDir: string;

beforeAll(async () => {
  app = AppContext.forTest();
  await app.boot();
  setApp(app);
  store = app.knowledge;
  arkDir = app.config.arkDir;
});

afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

beforeEach(() => {
  store.clear();
  // Clean up any leftover files from previous tests
  const memPath = join(arkDir, "memories.json");
  if (existsSync(memPath)) unlinkSync(memPath);
  const conductorDir = join(arkDir, "conductor");
  if (existsSync(conductorDir)) rmSync(conductorDir, { recursive: true });
});

describe("migrateMemories", () => {
  it("migrates memories.json entries into memory nodes", () => {
    const memories = [
      {
        id: "mem-001",
        content: "Always run tests before committing",
        tags: ["testing", "workflow"],
        scope: "global",
        importance: 0.8,
        accessCount: 5,
      },
      {
        id: "mem-002",
        content: "Use worktrees for parallel development",
        tags: ["git"],
        scope: "project/ark",
        importance: 0.6,
        accessCount: 2,
      },
    ];
    writeFileSync(join(arkDir, "memories.json"), JSON.stringify(memories));

    const result = migrateMemories(store, arkDir);
    expect(result.migrated).toBe(2);

    const node1 = store.getNode("mem-001");
    expect(node1).not.toBeNull();
    expect(node1!.type).toBe("memory");
    expect(node1!.content).toBe("Always run tests before committing");
    expect(node1!.metadata.tags).toEqual(["testing", "workflow"]);
    expect(node1!.metadata.scope).toBe("global");
    expect(node1!.metadata.importance).toBe(0.8);
    expect(node1!.metadata.accessCount).toBe(5);

    const node2 = store.getNode("mem-002");
    expect(node2).not.toBeNull();
    expect(node2!.metadata.scope).toBe("project/ark");
  });

  it("is idempotent -- second run does nothing", () => {
    const memories = [{ id: "mem-idem", content: "Test memory", tags: [], scope: "global", importance: 0.5, accessCount: 0 }];
    writeFileSync(join(arkDir, "memories.json"), JSON.stringify(memories));

    const first = migrateMemories(store, arkDir);
    expect(first.migrated).toBe(1);

    const second = migrateMemories(store, arkDir);
    expect(second.migrated).toBe(0);

    // Still only one node
    expect(store.nodeCount("memory")).toBe(1);
  });

  it("handles missing memories.json gracefully", () => {
    // Use a subdir that definitely has no memories.json
    const emptyDir = join(arkDir, "empty-subdir");
    mkdirSync(emptyDir, { recursive: true });
    const result = migrateMemories(store, emptyDir);
    expect(result.migrated).toBe(0);
  });

  it("handles malformed JSON gracefully", () => {
    writeFileSync(join(arkDir, "memories.json"), "not valid json {{{");
    const result = migrateMemories(store, arkDir);
    expect(result.migrated).toBe(0);
  });

  it("handles non-array JSON gracefully", () => {
    writeFileSync(join(arkDir, "memories.json"), JSON.stringify({ not: "an array" }));
    const result = migrateMemories(store, arkDir);
    expect(result.migrated).toBe(0);
  });
});

describe("migrateLearnings", () => {
  it("migrates LEARNINGS.md sections into learning nodes", () => {
    const conductorDir = join(arkDir, "conductor");
    mkdirSync(conductorDir, { recursive: true });
    writeFileSync(join(conductorDir, "LEARNINGS.md"), [
      "# Conductor Learnings",
      "",
      "## Tests Need Sequential Execution",
      "**Recurrence:** 5",
      "**Last seen:** 2026-04-01",
      "Port collisions occur when tests run in parallel.",
      "",
      "## Use AppContext.forTest",
      "**Recurrence:** 2",
      "Always use forTest for isolation.",
    ].join("\n"));

    const result = migrateLearnings(store, arkDir);
    expect(result.migrated).toBe(2);

    const node1 = store.getNode("learning:tests-need-sequential-execution");
    expect(node1).not.toBeNull();
    expect(node1!.type).toBe("learning");
    expect(node1!.label).toBe("Tests Need Sequential Execution");
    expect(node1!.metadata.recurrence).toBe(5);
    expect(node1!.metadata.source).toBe("learning");

    const node2 = store.getNode("learning:use-appcontext.fortest");
    expect(node2).not.toBeNull();
    expect(node2!.metadata.recurrence).toBe(2);
  });

  it("migrates POLICY.md sections with source=policy", () => {
    const conductorDir = join(arkDir, "conductor");
    mkdirSync(conductorDir, { recursive: true });
    writeFileSync(join(conductorDir, "POLICY.md"), [
      "# Conductor Policy",
      "",
      "## Never Run Tests In Parallel",
      "**Promoted from learnings on:** 2026-03-15",
      "Tests share ports and must run sequentially.",
    ].join("\n"));

    const result = migrateLearnings(store, arkDir);
    expect(result.migrated).toBe(1);

    const node = store.getNode("learning:never-run-tests-in-parallel");
    expect(node).not.toBeNull();
    expect(node!.metadata.source).toBe("policy");
  });

  it("is idempotent -- second run does nothing for same nodes", () => {
    const conductorDir = join(arkDir, "conductor");
    mkdirSync(conductorDir, { recursive: true });
    writeFileSync(join(conductorDir, "LEARNINGS.md"), [
      "# Learnings",
      "",
      "## Idempotent Learning",
      "**Recurrence:** 1",
      "Should only be imported once.",
    ].join("\n"));

    const first = migrateLearnings(store, arkDir);
    expect(first.migrated).toBe(1);

    const second = migrateLearnings(store, arkDir);
    expect(second.migrated).toBe(0);
  });

  it("handles missing conductor directory gracefully", () => {
    const emptyDir = join(arkDir, "no-conductor-here");
    mkdirSync(emptyDir, { recursive: true });
    const result = migrateLearnings(store, emptyDir);
    expect(result.migrated).toBe(0);
  });
});

describe("runKnowledgeMigrations", () => {
  it("runs all migrations together", () => {
    // Set up memories
    const memories = [{ id: "mem-all", content: "Full migration test", tags: [], scope: "global", importance: 0.5, accessCount: 0 }];
    writeFileSync(join(arkDir, "memories.json"), JSON.stringify(memories));

    // Set up learnings
    const conductorDir = join(arkDir, "conductor");
    mkdirSync(conductorDir, { recursive: true });
    writeFileSync(join(conductorDir, "LEARNINGS.md"), [
      "# Learnings",
      "",
      "## Full Migration Test",
      "**Recurrence:** 1",
      "Combined migration works.",
    ].join("\n"));

    runKnowledgeMigrations(store, arkDir);

    expect(store.nodeCount("memory")).toBe(1);
    expect(store.nodeCount("learning")).toBe(1);
  });
});
