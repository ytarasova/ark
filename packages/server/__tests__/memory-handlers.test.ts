/**
 * Tests for memory/* RPC handlers (memory.ts).
 *
 * memory.ts wraps the knowledge graph to expose a simpler "memory entry"
 * shape over RPC. Until this file existed there were 0 tests for any of
 * memory/list, memory/recall, memory/forget, memory/add, memory/clear
 * -- coverage was 14.29% funcs, 11.76% lines (audit 2026-04-19).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext, setApp, clearApp } from "../../core/app.js";
import { registerMemoryHandlers } from "../handlers/memory.js";
import { Router } from "../router.js";
import { createRequest, type JsonRpcResponse } from "../../protocol/types.js";

let app: AppContext;
beforeAll(async () => {
  app = await AppContext.forTestAsync();
  setApp(app);
  await app.boot();
});
afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

let router: Router;

beforeEach(() => {
  // Fresh router per test, but share the AppContext + knowledge store; we
  // clear memory nodes between tests below so the store is effectively
  // reset without tearing down the DB.
  router = new Router();
  registerMemoryHandlers(router, app);
  app.knowledge.clear({ type: "memory" });
});

function ok(res: unknown): Record<string, any> {
  return (res as JsonRpcResponse).result as Record<string, any>;
}

async function addMemory(content: string, opts: { tags?: string[]; scope?: string; importance?: number } = {}) {
  const res = await router.dispatch(createRequest(1, "memory/add", { content, ...opts }));
  return ok(res).memory;
}

describe("memory/add", () => {
  it("persists content and returns a memory entry with defaults", async () => {
    const memory = await addMemory("remember this");
    expect(memory).toBeDefined();
    expect(memory.id).toBeDefined();
    expect(memory.content).toBe("remember this");
    expect(memory.tags).toEqual([]);
    expect(memory.scope).toBe("global");
    expect(memory.importance).toBe(0.5);
    expect(memory.accessCount).toBe(0);
    expect(new Date(memory.createdAt).getTime()).toBeGreaterThan(0);
  });

  it("preserves explicit tags, scope, and importance", async () => {
    const memory = await addMemory("deploy steps", {
      tags: ["deploy", "runbook"],
      scope: "team",
      importance: 0.9,
    });
    expect(memory.tags).toEqual(["deploy", "runbook"]);
    expect(memory.scope).toBe("team");
    expect(memory.importance).toBe(0.9);
  });
});

describe("memory/list", () => {
  it("returns all memories when no scope filter is provided", async () => {
    await addMemory("global-a", { scope: "global" });
    await addMemory("global-b", { scope: "global" });
    await addMemory("team-a", { scope: "team" });

    const res = ok(await router.dispatch(createRequest(1, "memory/list", {})));
    const memories = res.memories as Array<{ content: string }>;
    const contents = memories.map((m) => m.content).sort();
    expect(contents).toEqual(["global-a", "global-b", "team-a"]);
  });

  it("scope filter also includes global scope (fallback)", async () => {
    await addMemory("team-a", { scope: "team" });
    await addMemory("global-a", { scope: "global" });
    await addMemory("personal-a", { scope: "personal" });

    const res = ok(await router.dispatch(createRequest(1, "memory/list", { scope: "team" })));
    const contents = (res.memories as Array<{ content: string }>).map((m) => m.content).sort();
    // scope="team" should return team-scoped AND global-scoped memories
    expect(contents).toEqual(["global-a", "team-a"]);
  });

  it("returns an empty list when there are no memories", async () => {
    const res = ok(await router.dispatch(createRequest(1, "memory/list", {})));
    expect(res.memories).toEqual([]);
  });
});

describe("memory/recall", () => {
  it("returns results that semantically match the query", async () => {
    await addMemory("ark uses bun as the runtime", { tags: ["build"] });
    await addMemory("unrelated memory about cooking", { tags: ["food"] });

    const res = ok(await router.dispatch(createRequest(1, "memory/recall", { query: "bun" })));
    const results = res.results as Array<{ content: string }>;
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((m) => m.content.includes("bun"))).toBe(true);
  });

  it("respects an explicit limit", async () => {
    for (let i = 0; i < 5; i++) await addMemory(`bun fact ${i}`);
    const res = ok(await router.dispatch(createRequest(1, "memory/recall", { query: "bun", limit: 2 })));
    const results = res.results as unknown[];
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

describe("memory/forget", () => {
  it("removes an existing memory and returns ok:true", async () => {
    const memory = await addMemory("forget me");
    const res = ok(await router.dispatch(createRequest(1, "memory/forget", { id: memory.id })));
    expect(res.ok).toBe(true);

    // Confirm it is actually gone
    const listed = ok(await router.dispatch(createRequest(2, "memory/list", {}))).memories as unknown[];
    expect(listed.length).toBe(0);
  });

  it("returns ok:false for an unknown id", async () => {
    const res = ok(await router.dispatch(createRequest(1, "memory/forget", { id: "mem-does-not-exist" })));
    expect(res.ok).toBe(false);
  });
});

describe("memory/clear", () => {
  it("clears memories matching a specific scope and returns the count", async () => {
    await addMemory("team-a", { scope: "team" });
    await addMemory("team-b", { scope: "team" });
    await addMemory("global-a", { scope: "global" });

    const res = ok(await router.dispatch(createRequest(1, "memory/clear", { scope: "team" })));
    expect(res.count).toBe(2);

    // Global should survive
    const remaining = ok(await router.dispatch(createRequest(2, "memory/list", {}))).memories as Array<{
      content: string;
    }>;
    expect(remaining.length).toBe(1);
    expect(remaining[0].content).toBe("global-a");
  });

  it("clears all memories when no scope is provided", async () => {
    await addMemory("a");
    await addMemory("b");
    await addMemory("c", { scope: "team" });

    const res = ok(await router.dispatch(createRequest(1, "memory/clear", {})));
    expect(res.count).toBe(3);

    const remaining = ok(await router.dispatch(createRequest(2, "memory/list", {}))).memories as unknown[];
    expect(remaining.length).toBe(0);
  });
});
