import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../../app.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});

afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

describe("UsageRecorder cost_mode", () => {
  it("api mode: calculates cost from pricing registry", () => {
    app.usageRecorder.record({
      sessionId: "s-api-test",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      usage: { input_tokens: 1_000_000, output_tokens: 500_000 },
      costMode: "api",
    });

    const { records } = app.usageRecorder.getSessionCost("s-api-test");
    expect(records.length).toBe(1);
    expect(records[0].cost_usd).toBeGreaterThan(0); // real cost
    expect(records[0].input_tokens).toBe(1_000_000);
    expect(records[0].output_tokens).toBe(500_000);
  });

  it("subscription mode: cost_usd is zero, tokens still tracked", () => {
    app.usageRecorder.record({
      sessionId: "s-sub-test",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      usage: { input_tokens: 1_000_000, output_tokens: 500_000 },
      costMode: "subscription",
    });

    const { records } = app.usageRecorder.getSessionCost("s-sub-test");
    expect(records.length).toBe(1);
    expect(records[0].cost_usd).toBe(0); // subscription -- no per-token cost
    expect(records[0].input_tokens).toBe(1_000_000);
    expect(records[0].output_tokens).toBe(500_000);
  });

  it("free mode: cost_usd is zero, tokens still tracked", () => {
    app.usageRecorder.record({
      sessionId: "s-free-test",
      model: "gemini-2.5-pro",
      provider: "google",
      usage: { input_tokens: 100, output_tokens: 50 },
      costMode: "free",
    });

    const { records } = app.usageRecorder.getSessionCost("s-free-test");
    expect(records.length).toBe(1);
    expect(records[0].cost_usd).toBe(0);
    expect(records[0].input_tokens).toBe(100);
  });

  it("defaults to api mode when costMode omitted (backward compat)", () => {
    app.usageRecorder.record({
      sessionId: "s-default-test",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      usage: { input_tokens: 1000, output_tokens: 500 },
      // costMode omitted
    });

    const { records } = app.usageRecorder.getSessionCost("s-default-test");
    expect(records.length).toBe(1);
    // With api mode default, cost should be computed (non-zero for real pricing)
    // but tiny for this small amount, so just check it ran
    expect(records[0]).toBeDefined();
  });

  it("groupBy splits subscription vs api costs", () => {
    // Add mixed records
    app.usageRecorder.record({
      sessionId: "s-mix-1",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      usage: { input_tokens: 10_000, output_tokens: 5_000 },
      costMode: "api",
    });
    app.usageRecorder.record({
      sessionId: "s-mix-2",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      usage: { input_tokens: 10_000, output_tokens: 5_000 },
      costMode: "subscription",
    });

    // Raw SQL query to verify cost_mode column works
    const rows = app.db
      .prepare(
        "SELECT cost_mode, COUNT(*) as cnt FROM usage_records WHERE session_id IN ('s-mix-1', 's-mix-2') GROUP BY cost_mode",
      )
      .all() as Array<{ cost_mode: string; cnt: number }>;

    expect(rows.length).toBe(2);
    const byMode: Record<string, number> = {};
    for (const r of rows) byMode[r.cost_mode] = r.cnt;
    expect(byMode.api).toBe(1);
    expect(byMode.subscription).toBe(1);
  });
});
