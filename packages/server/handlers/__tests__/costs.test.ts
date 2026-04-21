/**
 * costs/sync + costs/export RPC handler tests.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../../core/app.js";
import { Router } from "../../router.js";
import { registerCostsAdminHandlers } from "../costs.js";
import { createRequest, type JsonRpcResponse } from "../../../protocol/types.js";

let app: AppContext;
let router: Router;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

beforeEach(() => {
  router = new Router();
  registerCostsAdminHandlers(router, app);
});

function ok(res: unknown): Record<string, any> {
  return (res as JsonRpcResponse).result as Record<string, any>;
}

describe("costs/sync", () => {
  it("returns synced + skipped counts on an empty workspace", async () => {
    const res = ok(await router.dispatch(createRequest(1, "costs/sync", {})));
    expect(res.ok).toBe(true);
    expect(typeof res.synced).toBe("number");
    expect(typeof res.skipped).toBe("number");
    expect(res.synced).toBe(0);
  });
});

describe("costs/export", () => {
  it("returns a total + rows shape (empty when no usage records)", async () => {
    const res = ok(await router.dispatch(createRequest(1, "costs/export", {})));
    expect(res.total).toBe(0);
    expect(Array.isArray(res.rows)).toBe(true);
    expect(res.rows.length).toBe(0);
  });

  it("reflects a recorded usage entry as a structured row", async () => {
    const session = await app.sessions.create({ summary: "cost-test" });
    await app.usageRecorder.record({
      sessionId: session.id,
      model: "sonnet",
      provider: "anthropic",
      usage: { input_tokens: 1000, output_tokens: 500 },
      source: "test",
    });

    const res = ok(await router.dispatch(createRequest(1, "costs/export", {})));
    expect(res.rows.length).toBeGreaterThan(0);
    const row = res.rows.find((r: any) => r.sessionId === session.id);
    expect(row).toBeDefined();
    expect(row.input_tokens).toBe(1000);
    expect(row.output_tokens).toBe(500);
    expect(row.cost).toBeGreaterThan(0);
    expect(res.total).toBeGreaterThan(0);
  });
});
