/**
 * Tests for knowledge/* RPC handlers (knowledge.ts).
 *
 * knowledge.ts exposes search, stats, codebase/status, import, and export
 * over the knowledge graph. Before this commit: 0 tests, 14.29% functions,
 * 9.28% lines (audit 2026-04-19).
 *
 * knowledge/index and knowledge/import shell out to the indexer and
 * filesystem respectively; those are covered at the store layer in
 * packages/core/knowledge/__tests__/. Here we only verify the handlers
 * wire correctly and return the expected response shapes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AppContext } from "../../core/app.js";
import { registerKnowledgeHandlers } from "../handlers/knowledge.js";
import { Router } from "../router.js";
import { createRequest, type JsonRpcResponse, type JsonRpcError } from "../../protocol/types.js";

let app: AppContext;
beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});
afterAll(async () => {
  await app?.shutdown();
});

let router: Router;

beforeEach(() => {
  router = new Router();
  registerKnowledgeHandlers(router, app);
  // Clear any carry-over knowledge nodes between tests to keep expectations
  // stable across the full suite
  for (const t of ["memory", "learning", "skill", "recipe", "agent", "session", "symbol", "file"] as const) {
    app.knowledge.clear({ type: t });
  }
});

function ok(res: unknown): Record<string, any> {
  return (res as JsonRpcResponse).result as Record<string, any>;
}

function err(res: unknown): { code: number; message: string } {
  return (res as JsonRpcError).error as { code: number; message: string };
}

describe("knowledge/search", () => {
  it("returns results matching the query", async () => {
    app.knowledge.addNode({
      type: "memory",
      label: "ark is a bun-only orchestrator",
      content: "ark is a bun-only orchestrator",
      metadata: {},
    });
    app.knowledge.addNode({
      type: "memory",
      label: "unrelated fact",
      content: "unrelated fact",
      metadata: {},
    });

    const res = ok(await router.dispatch(createRequest(1, "knowledge/search", { query: "bun" })));
    const results = res.results as Array<{ content: string; score: number }>;
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => typeof r.score === "number")).toBe(true);
    expect(results.some((r) => r.content?.includes("bun"))).toBe(true);
  });

  it("narrows results with a types filter", async () => {
    app.knowledge.addNode({ type: "memory", label: "bun fact m", content: "bun memory", metadata: {} });
    app.knowledge.addNode({ type: "learning", label: "bun fact l", content: "bun learning", metadata: {} });

    const res = ok(await router.dispatch(createRequest(1, "knowledge/search", { query: "bun", types: ["learning"] })));
    const results = res.results as Array<{ type: string }>;
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.type === "learning")).toBe(true);
  });

  it("requires a query parameter", async () => {
    const res = err(await router.dispatch(createRequest(1, "knowledge/search", {})));
    // extract() throws on missing required params; the router relays that
    // as a JSON-RPC error
    expect(res.message).toBeDefined();
  });
});

describe("knowledge/stats", () => {
  it("returns aggregated node + edge counts", async () => {
    app.knowledge.addNode({ type: "memory", label: "m1", content: "m1", metadata: {} });
    app.knowledge.addNode({ type: "memory", label: "m2", content: "m2", metadata: {} });
    app.knowledge.addNode({ type: "learning", label: "l1", content: "l1", metadata: {} });

    const res = ok(await router.dispatch(createRequest(1, "knowledge/stats", {})));
    expect(res.nodes).toBeGreaterThanOrEqual(3);
    expect(typeof res.edges).toBe("number");
    expect(res.by_node_type.memory).toBe(2);
    expect(res.by_node_type.learning).toBe(1);
    // Zero-count types are omitted from the response
    expect(res.by_node_type.skill).toBeUndefined();
  });
});

describe("knowledge/export + knowledge/import", () => {
  it("round-trips memory nodes through the markdown export and import", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ark-knowledge-"));
    try {
      app.knowledge.addNode({
        type: "memory",
        label: "portable memory",
        content: "portable memory content",
        metadata: { scope: "global", tags: ["portable"], importance: 0.7 },
      });

      const exportRes = ok(await router.dispatch(createRequest(1, "knowledge/export", { dir })));
      expect(exportRes.ok).toBe(true);

      // Clear and re-import
      app.knowledge.clear({ type: "memory" });
      expect(app.knowledge.nodeCount("memory")).toBe(0);

      const importRes = ok(await router.dispatch(createRequest(2, "knowledge/import", { dir })));
      expect(importRes.ok).toBe(true);
      expect(app.knowledge.nodeCount("memory")).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("knowledge/codebase/status", () => {
  it("reports availability without throwing", async () => {
    const res = ok(await router.dispatch(createRequest(1, "knowledge/codebase/status", {})));
    // binary may or may not be vendored on this host; either way the
    // response shape must be valid
    expect(typeof res.available).toBe("boolean");
    if (res.available) {
      expect(typeof res.path).toBe("string");
      expect(Array.isArray(res.tools)).toBe(true);
      expect(res.tools.length).toBeGreaterThan(0);
    } else {
      expect(res.path).toBeNull();
      expect(res.version).toBeNull();
    }
  });
});
