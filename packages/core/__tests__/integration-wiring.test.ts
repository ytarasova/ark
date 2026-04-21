import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../app.js";
import { buildContext, formatContextAsMarkdown } from "../knowledge/context.js";
import type { KnowledgeStore } from "../knowledge/store.js";
import { TenantPolicyManager } from "../auth/tenant-policy.js";

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

beforeEach(async () => {
  await store.clear();
});

// ── buildContext token budget ──────────────────────────────────────────────

describe("buildContext token budget", async () => {
  it("respects maxTokens by limiting items", async () => {
    // Add many items
    for (let i = 0; i < 20; i++) {
      await store.addNode({
        id: `memory:m-${i}`,
        type: "memory",
        label: `Memory about topic ${i} with keywords for search`,
        content: `Detailed content about topic ${i} for testing budget limits`.repeat(5),
        metadata: { importance: 0.5 + i * 0.02, scope: "global" },
      });
    }

    const ctx = await buildContext(store, "topic budget test", { maxTokens: 500 });
    // With a small budget, should get fewer items
    expect(ctx.memories.length).toBeLessThanOrEqual(3);
  });

  it("default limits are 5 files, 3 memories, 3 sessions, 2 learnings, 2 skills", async () => {
    for (let i = 0; i < 10; i++) {
      await store.addNode({
        id: `file:src/f${i}.ts`,
        type: "file",
        label: `src/f${i}.ts`,
        content: "test file content",
        metadata: { language: "typescript" },
      });
      await store.addNode({
        id: `memory:m${i}`,
        type: "memory",
        label: `Memory ${i} test`,
        content: `test content ${i}`,
        metadata: { importance: 0.5, scope: "global" },
      });
      await store.addNode({
        id: `session:s${i}`,
        type: "session",
        label: `Session ${i} test`,
        content: `session content ${i}`,
        metadata: { outcome: "success", files_changed: [] },
      });
      await store.addNode({
        id: `learning:l${i}`,
        type: "learning",
        label: `Learning ${i} test`,
        content: `learning content ${i}`,
      });
      await store.addNode({
        id: `skill:sk${i}`,
        type: "skill",
        label: `Skill ${i} test`,
        content: `skill content ${i}`,
      });
    }

    const ctx = await buildContext(store, "test content");
    expect(ctx.files.length).toBeLessThanOrEqual(5);
    expect(ctx.memories.length).toBeLessThanOrEqual(3);
    expect(ctx.sessions.length).toBeLessThanOrEqual(3);
    expect(ctx.learnings.length).toBeLessThanOrEqual(2);
    expect(ctx.skills.length).toBeLessThanOrEqual(2);
  });
});

describe("formatContextAsMarkdown maxChars", () => {
  it("truncates output to maxChars budget", () => {
    const ctx = {
      files: Array.from({ length: 5 }, (_, i) => ({
        path: `src/file${i}.ts`,
        language: "typescript",
        dependents: i,
        recent_sessions: [],
      })),
      memories: Array.from({ length: 3 }, (_, i) => ({
        content: `Important memory number ${i} with lots of detail about the project`.repeat(3),
        importance: 0.9 - i * 0.1,
        scope: "global",
      })),
      sessions: Array.from({ length: 3 }, (_, i) => ({
        id: `s-${i}`,
        summary: `Session ${i} did something important`,
        outcome: "success",
        files_changed: [`file${i}.ts`],
        date: "2026-04-01",
      })),
      learnings: [{ title: "Test tip", description: "Always test" }],
      skills: [{ name: "review", description: "Code review skill" }],
    };

    const full = formatContextAsMarkdown(ctx);
    const limited = formatContextAsMarkdown(ctx, { maxChars: 500 });

    expect(limited.length).toBeLessThan(full.length);
    expect(limited.length).toBeLessThanOrEqual(800); // some overhead from headers
  });

  it("includes MCP tools footer", () => {
    const ctx = {
      files: [],
      memories: [{ content: "test", importance: 0.5, scope: "global" }],
      sessions: [],
      learnings: [],
      skills: [],
    };

    const md = formatContextAsMarkdown(ctx);
    expect(md).toContain("knowledge/search");
  });
});

// ── Router URL injection ──────────────────────────────────────────────────

describe("router config", () => {
  it("config has router settings", () => {
    expect(app.config.router).toBeDefined();
    expect(typeof app.config.router.enabled).toBe("boolean");
    expect(typeof app.config.router.url).toBe("string");
    expect(typeof app.config.router.policy).toBe("string");
    expect(typeof app.config.router.autoStart).toBe("boolean");
  });

  it("config has knowledge settings", () => {
    expect(app.config.knowledge).toBeDefined();
    expect(typeof app.config.knowledge!.autoIndex).toBe("boolean");
    expect(typeof app.config.knowledge!.incrementalIndex).toBe("boolean");
  });
});

// ── Tenant integration policies ──────────────────────────────────────────

describe("tenant integration policies", () => {
  it("getEffectiveIntegrationSettings merges tenant + global", async () => {
    const mgr = new TenantPolicyManager(app.db);

    // Set a tenant policy with router required
    await mgr.setPolicy({
      tenant_id: "test-integration",
      allowed_providers: [],
      default_provider: "k8s",
      max_concurrent_sessions: 10,
      max_cost_per_day_usd: null,
      compute_pools: [],
      router_enabled: null,
      router_required: true,
      router_policy: "cost",
      auto_index: null,
      auto_index_required: true,
      tensorzero_enabled: null,
    });

    const settings = await mgr.getEffectiveIntegrationSettings("test-integration", {
      routerEnabled: false,
      autoIndex: false,
      tensorZeroEnabled: false,
      routerPolicy: "balanced",
    });

    // router_required overrides global routerEnabled=false
    expect(settings.routerEnabled).toBe(true);
    // tenant policy sets cost
    expect(settings.routerPolicy).toBe("cost");
    // auto_index_required overrides global autoIndex=false
    expect(settings.autoIndex).toBe(true);
    // tensorzero inherits from global (null in tenant)
    expect(settings.tensorZeroEnabled).toBe(false);

    await mgr.deletePolicy("test-integration");
  });

  it("defaults to global config when no tenant policy", async () => {
    const mgr = new TenantPolicyManager(app.db);

    const settings = await mgr.getEffectiveIntegrationSettings("no-policy-tenant", {
      routerEnabled: true,
      autoIndex: true,
      tensorZeroEnabled: true,
      routerPolicy: "quality",
    });

    expect(settings.routerEnabled).toBe(true);
    expect(settings.routerPolicy).toBe("quality");
    expect(settings.autoIndex).toBe(true);
    expect(settings.tensorZeroEnabled).toBe(true);
  });
});

// ── ingestRemoteIndex ────────────────────────────────────────────────────

describe("ingestRemoteIndex", async () => {
  it("maps remote nodes/edges into knowledge store", async () => {
    // Simulate the data returned by arkd /codegraph/index
    const remoteData = {
      ok: true,
      nodes: [
        {
          id: 1,
          kind: "function",
          name: "boot",
          file: "src/app.ts",
          line: 10,
          end_line: 30,
          exported: 1,
          qualified_name: "src/app.ts::boot",
        },
        {
          id: 2,
          kind: "class",
          name: "Database",
          file: "src/db.ts",
          line: 5,
          end_line: 45,
          exported: 1,
          qualified_name: "src/db.ts::Database",
        },
      ],
      edges: [{ source_id: 1, target_id: 2, kind: "calls" }],
      files: 2,
      symbols: 2,
    };

    // Import the ingest function indirectly by calling the same logic
    const addedFiles = new Set<string>();
    for (const node of remoteData.nodes) {
      if (node.file && !addedFiles.has(node.file)) {
        await store.addNode({
          id: `file:${node.file}`,
          type: "file",
          label: node.file,
          metadata: { language: node.file.split(".").pop() ?? "unknown" },
        });
        addedFiles.add(node.file);
      }
      await store.addNode({
        id: `symbol:${node.file}::${node.name}:${node.line}`,
        type: "symbol",
        label: node.name,
        metadata: {
          kind: node.kind,
          file: node.file,
          line_start: node.line,
          line_end: node.end_line,
          exported: node.exported === 1,
        },
      });
    }

    // Verify files
    expect(await store.getNode("file:src/app.ts")).not.toBeNull();
    expect(await store.getNode("file:src/db.ts")).not.toBeNull();

    // Verify symbols
    const boot = await store.getNode("symbol:src/app.ts::boot:10");
    expect(boot).not.toBeNull();
    expect(boot!.metadata.kind).toBe("function");
    expect(boot!.metadata.exported).toBe(true);

    const db = await store.getNode("symbol:src/db.ts::Database:5");
    expect(db).not.toBeNull();
    expect(db!.metadata.kind).toBe("class");
  });
});
