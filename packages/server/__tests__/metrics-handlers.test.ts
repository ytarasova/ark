/**
 * Tests for metrics/* + costs/* RPC handlers (metrics.ts).
 *
 * metrics.ts exposes cost tracking endpoints (costs/summary, /trend,
 * /session, /record) plus compute snapshot/process actions. Before this
 * commit: 0 tests, 10% functions, 16.33% lines (audit 2026-04-19).
 *
 * compute/docker-* and compute/kill-process are not exercised here --
 * they shell out to docker/kill. Those stay uncovered; a follow-up can
 * inject an exec shim to test them without touching the host.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../core/app.js";
import { registerMetricsHandlers } from "../handlers/metrics.js";
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
  registerMetricsHandlers(router, app);
});

function ok(res: unknown): Record<string, any> {
  return (res as JsonRpcResponse).result as Record<string, any>;
}

function err(res: unknown): { code: number; message: string } {
  return (res as JsonRpcError).error as { code: number; message: string };
}

describe("metrics/snapshot", () => {
  it("returns snapshot:null for an unknown compute name", async () => {
    const res = ok(await router.dispatch(createRequest(1, "metrics/snapshot", { computeName: "does-not-exist" })));
    expect(res.snapshot).toBeNull();
  });

  it("defaults to 'local' when computeName is omitted", async () => {
    // Either the local compute row exists (then snapshot is non-null or
    // null depending on provider support) or it does not (snapshot:null).
    // Either way, the handler must not throw and must return an object
    // with a `snapshot` key.
    const res = ok(await router.dispatch(createRequest(1, "metrics/snapshot", {})));
    expect(res).toHaveProperty("snapshot");
  });
});

describe("costs/read", () => {
  it("returns an object shaped { costs, total }", async () => {
    const res = ok(await router.dispatch(createRequest(1, "costs/read", {})));
    expect(res).toHaveProperty("costs");
    expect(res).toHaveProperty("total");
    // costs is a per-session array; empty when no sessions exist
    expect(Array.isArray(res.costs)).toBe(true);
    expect(typeof res.total).toBe("number");
  });
});

describe("costs/record + costs/summary + costs/trend + costs/session", () => {
  it("records a usage event that summary + trend + session then reflect", async () => {
    // The costs/record handler verifies the session belongs to the caller's
    // tenant via app.sessions.get(sessionId); create one first so the
    // handler doesn't reject with "Session not found".
    const session = app.sessions.create({ summary: "cost-record-session" });
    const sessionId = session.id;

    // Record a synthetic event via RPC
    const recordRes = ok(
      await router.dispatch(
        createRequest(1, "costs/record", {
          sessionId,
          model: "claude-opus-4",
          provider: "anthropic",
          runtime: "claude",
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        }),
      ),
    );
    expect(recordRes.ok).toBe(true);

    // Summary aggregates by model by default
    const summaryRes = ok(await router.dispatch(createRequest(2, "costs/summary", {})));
    expect(summaryRes).toHaveProperty("summary");
    expect(summaryRes).toHaveProperty("total");
    expect(Array.isArray(summaryRes.summary)).toBe(true);

    // Trend returns daily buckets
    const trendRes = ok(await router.dispatch(createRequest(3, "costs/trend", { days: 1 })));
    expect(trendRes).toHaveProperty("trend");
    expect(Array.isArray(trendRes.trend)).toBe(true);

    // Session lookup by sessionId returns totals + records
    const sessionRes = ok(await router.dispatch(createRequest(4, "costs/session", { sessionId })));
    expect(sessionRes).toHaveProperty("records");
    expect(Array.isArray(sessionRes.records)).toBe(true);
    // The record we just inserted should be present
    const match = (sessionRes.records as Array<{ session_id: string; model: string }>).find(
      (r) => r.session_id === sessionId && r.model === "claude-opus-4",
    );
    expect(match).toBeDefined();
  });

  it("costs/record rejects missing required params", async () => {
    const res = err(
      await router.dispatch(
        createRequest(1, "costs/record", {
          // missing sessionId + model + provider
          input_tokens: 10,
        }),
      ),
    );
    expect(res.message).toContain("required");
  });

  it("costs/session rejects missing sessionId", async () => {
    const res = err(await router.dispatch(createRequest(1, "costs/session", {})));
    expect(res.message).toContain("sessionId");
  });

  it("costs/summary accepts an explicit groupBy key", async () => {
    // The handler uses params.groupBy directly; UsageRecorder.getSummary
    // whitelists valid columns so a safe key like 'provider' works.
    const res = ok(await router.dispatch(createRequest(1, "costs/summary", { groupBy: "provider" })));
    expect(res).toHaveProperty("summary");
    expect(Array.isArray(res.summary)).toBe(true);
  });
});

describe("compute/kill-process + docker actions (validation only)", () => {
  it("compute/kill-process rejects missing pid", async () => {
    const res = err(await router.dispatch(createRequest(1, "compute/kill-process", {})));
    expect(res.message).toContain("pid");
  });

  it("compute/docker-logs rejects missing container", async () => {
    const res = err(await router.dispatch(createRequest(1, "compute/docker-logs", {})));
    expect(res.message).toContain("container");
  });

  it("compute/docker-action rejects missing container", async () => {
    const res = err(await router.dispatch(createRequest(1, "compute/docker-action", { action: "stop" })));
    expect(res.message).toContain("container");
  });

  it("compute/docker-action rejects an unknown action", async () => {
    const res = err(
      await router.dispatch(createRequest(1, "compute/docker-action", { container: "c1", action: "blowup" })),
    );
    expect(res.message).toContain("stop or restart");
  });
});
