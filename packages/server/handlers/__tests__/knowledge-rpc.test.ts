/**
 * knowledge-rpc.ts handler tests -- happy path + error path for
 * knowledge/remember and knowledge/recall.
 *
 * The shared knowledge handlers (search/stats/codebase-status) and the
 * local-only ones (index/export/import) are exercised by
 * packages/server/__tests__/knowledge-handlers.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../../core/app.js";
import { Router } from "../../router.js";
import { registerKnowledgeRpcHandlers } from "../knowledge-rpc.js";
import { createRequest, type JsonRpcError, type JsonRpcResponse } from "../../../protocol/types.js";

let app: AppContext;
let router: Router;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

beforeEach(async () => {
  router = new Router();
  registerKnowledgeRpcHandlers(router, app);
  for (const t of ["memory", "learning"] as const) {
    await app.knowledge.clear({ type: t });
  }
});

function ok(res: unknown): Record<string, any> {
  return (res as JsonRpcResponse).result as Record<string, any>;
}
function err(res: unknown): { code: number; message: string } {
  return (res as JsonRpcError).error as { code: number; message: string };
}

describe("knowledge/remember", () => {
  it("stores a memory node and returns its id", async () => {
    const res = ok(
      await router.dispatch(
        createRequest(1, "knowledge/remember", {
          content: "prefer bun over node",
          tags: ["bun", "rule"],
          importance: 0.8,
        }),
      ),
    );
    expect(res.ok).toBe(true);
    expect(typeof res.id).toBe("string");
    expect(res.id.startsWith("memory:")).toBe(true);

    const node = await app.knowledge.getNode(res.id);
    expect(node?.content).toBe("prefer bun over node");
    expect(node?.metadata.importance).toBe(0.8);
  });

  it("rejects an empty content string", async () => {
    const res = err(await router.dispatch(createRequest(1, "knowledge/remember", { content: "" })));
    expect(res.message).toContain("non-empty");
  });

  it("rejects an out-of-range importance", async () => {
    const res = err(await router.dispatch(createRequest(1, "knowledge/remember", { content: "hi", importance: 1.5 })));
    expect(res.message).toContain("importance");
  });
});

describe("knowledge/recall", () => {
  it("returns memory + learning matches", async () => {
    await app.knowledge.addNode({
      type: "memory",
      label: "bun is fast",
      content: "bun is fast",
      metadata: {},
    });
    await app.knowledge.addNode({
      type: "learning",
      label: "bun beats node",
      content: "bun beats node",
      metadata: {},
    });
    await app.knowledge.addNode({
      type: "memory",
      label: "unrelated",
      content: "unrelated",
      metadata: {},
    });

    const res = ok(await router.dispatch(createRequest(1, "knowledge/recall", { query: "bun", limit: 5 })));
    const results = res.results as Array<{ content: string; type: string }>;
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.every((r) => r.type === "memory" || r.type === "learning")).toBe(true);
    expect(results.some((r) => r.content?.includes("bun"))).toBe(true);
  });

  it("errors when query is missing", async () => {
    const res = err(await router.dispatch(createRequest(1, "knowledge/recall", {})));
    expect(res.message).toBeDefined();
  });
});
