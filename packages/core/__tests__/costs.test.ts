import { describe, it, expect } from "bun:test";
import { calculateCost, formatCost, getSessionCost, getAllSessionCosts, checkBudget } from "../observability/costs.js";
import { PricingRegistry, type TokenUsage } from "../observability/pricing.js";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

withTestContext();

// Local registry used for the pure calculateCost() tests. Exercising the
// standalone function no longer leans on a module-level singleton -- callers
// pass the pricing registry through explicitly (the DI container wires the
// same thing into the `pricing` singleton used by service code).
const pricing = new PricingRegistry();

// Helper: record usage for a session the same way the dispatch flow would
function recordUsage(sessionId: string, model: string, u: Partial<TokenUsage>): void {
  getApp().usageRecorder.record({
    sessionId,
    model,
    provider: "anthropic",
    usage: {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_read_tokens: u.cache_read_tokens ?? 0,
      cache_write_tokens: u.cache_write_tokens ?? 0,
    },
  });
}

describe("calculateCost", () => {
  it("calculates sonnet cost correctly", () => {
    const usage: TokenUsage = {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      cache_read_tokens: 500_000,
      cache_write_tokens: 200_000,
    };
    const cost = calculateCost(pricing, usage, "sonnet");
    // input: 1M * 3/1M = 3.00, output: 100K * 15/1M = 1.50
    // cacheRead: 500K * 0.30/1M = 0.15, cacheWrite: 200K * 3.75/1M = 0.75
    // Total: 5.40
    expect(cost).toBeCloseTo(5.4, 2);
  });

  it("calculates opus cost correctly", () => {
    const usage: TokenUsage = {
      input_tokens: 100_000,
      output_tokens: 10_000,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };
    const cost = calculateCost(pricing, usage, "opus");
    expect(cost).toBeCloseTo(2.25, 2);
  });

  it("calculates haiku cost correctly", () => {
    const usage: TokenUsage = { input_tokens: 1_000_000, output_tokens: 0 };
    const cost = calculateCost(pricing, usage, "haiku");
    expect(cost).toBeCloseTo(0.8, 2);
  });

  it("defaults to sonnet for unknown model", () => {
    const usage: TokenUsage = { input_tokens: 1_000_000, output_tokens: 0 };
    expect(calculateCost(pricing, usage, "unknown")).toBeCloseTo(3.0, 2);
    expect(calculateCost(pricing, usage, null)).toBeCloseTo(3.0, 2);
  });
});

describe("formatCost", () => {
  it("formats zero", () => expect(formatCost(0)).toBe("$0.00"));
  it("formats small cost", () => expect(formatCost(0.005)).toBe("<$0.01"));
  it("formats normal cost", () => expect(formatCost(1.234)).toBe("$1.23"));
  it("formats large cost", () => expect(formatCost(99.99)).toBe("$99.99"));
});

describe("getSessionCost", async () => {
  it("returns cost from UsageRecorder records", async () => {
    const app = getApp();
    const s = await app.sessions.create({ summary: "test" });
    recordUsage(s.id, "sonnet", { input_tokens: 1_000_000, output_tokens: 0 });
    const sc = await getSessionCost(app, (await app.sessions.get(s.id))!);
    expect(sc.cost).toBeCloseTo(3.0, 2);
  });

  it("returns 0 cost for session without records", async () => {
    const app = getApp();
    const s = await app.sessions.create({ summary: "no-usage" });
    const sc = await getSessionCost(app, s);
    expect(sc.cost).toBe(0);
  });
});

describe("getAllSessionCosts", async () => {
  it("returns sorted costs and total", async () => {
    const app = getApp();
    const s1 = await app.sessions.create({ summary: "cheap" });
    const s2 = await app.sessions.create({ summary: "expensive" });
    recordUsage(s1.id, "haiku", { input_tokens: 100_000, output_tokens: 0 });
    recordUsage(s2.id, "opus", { input_tokens: 100_000, output_tokens: 0 });
    const sessions = [(await app.sessions.get(s1.id))!, (await app.sessions.get(s2.id))!];
    const result = await getAllSessionCosts(app, sessions);
    expect(result.sessions.length).toBe(2);
    expect(result.sessions[0].sessionId).toBe(s2.id); // opus is more expensive
    expect(result.total).toBeGreaterThan(0);
  });

  it("filters out zero-cost sessions", async () => {
    const app = getApp();
    const s1 = await app.sessions.create({ summary: "has-cost" });
    const s2 = await app.sessions.create({ summary: "no-cost" });
    recordUsage(s1.id, "sonnet", { input_tokens: 100_000, output_tokens: 0 });
    const sessions = [(await app.sessions.get(s1.id))!, s2];
    const result = await getAllSessionCosts(app, sessions);
    expect(result.sessions.length).toBe(1);
    expect(result.sessions[0].sessionId).toBe(s1.id);
  });
});

describe("calculateCost edge cases", () => {
  it("returns 0 for zero tokens", () => {
    expect(calculateCost(pricing, { input_tokens: 0, output_tokens: 0 }, "opus")).toBe(0);
  });

  it("handles cache-only usage", () => {
    const usage: TokenUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 1_000_000,
      cache_write_tokens: 500_000,
    };
    const cost = calculateCost(pricing, usage, "sonnet");
    // cacheRead: 1M * 0.30/1M = 0.30, cacheWrite: 500K * 3.75/1M = 1.875
    expect(cost).toBeCloseTo(2.175, 2);
  });

  it("handles undefined model same as null", () => {
    const usage: TokenUsage = { input_tokens: 1_000_000, output_tokens: 0 };
    expect(calculateCost(pricing, usage, undefined)).toBeCloseTo(calculateCost(pricing, usage, null), 10);
  });
});

describe("formatCost edge cases", () => {
  it("formats exactly one cent", () => expect(formatCost(0.01)).toBe("$0.01"));
  it("formats very large cost", () => expect(formatCost(1234.56)).toBe("$1234.56"));
  it("formats negative cost", () => expect(formatCost(-1)).toBe("-$1.00"));
  it("formats small negative cost", () => expect(formatCost(-0.05)).toBe("-$0.05"));
});

describe("getAllSessionCosts edge cases", async () => {
  it("returns empty for no sessions", async () => {
    const app = getApp();
    const result = await getAllSessionCosts(app, []);
    expect(result.sessions).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("skips sessions with zero cost", async () => {
    const app = getApp();
    const s = await app.sessions.create({ summary: "no-tokens" });
    const result = await getAllSessionCosts(app, [(await app.sessions.get(s.id))!]);
    expect(result.sessions).toHaveLength(0);
  });

  it("handles multiple sessions with different models", async () => {
    const app = getApp();
    const s1 = await app.sessions.create({ summary: "opus-session" });
    const s2 = await app.sessions.create({ summary: "haiku-session" });
    recordUsage(s1.id, "opus", { input_tokens: 100_000, output_tokens: 0 });
    recordUsage(s2.id, "haiku", { input_tokens: 100_000, output_tokens: 0 });

    const result = await getAllSessionCosts(app, [(await app.sessions.get(s1.id))!, (await app.sessions.get(s2.id))!]);
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions[0].cost).toBeGreaterThan(result.sessions[1].cost); // opus > haiku
    expect(result.total).toBeGreaterThan(0);
  });
});

describe("checkBudget", async () => {
  it("detects daily limit exceeded", async () => {
    const app = getApp();
    const s = await app.sessions.create({ summary: "budget-test" });
    recordUsage(s.id, "opus", { input_tokens: 10_000_000, output_tokens: 1_000_000 });

    const sessions = [(await app.sessions.get(s.id))!];
    const status = await checkBudget(app, sessions, { dailyLimit: 10 });
    expect(status.daily.exceeded).toBe(true);
    expect(status.daily.warning).toBe(true);
  });

  it("no warning when under budget", async () => {
    const app = getApp();
    const s = await app.sessions.create({ summary: "cheap" });
    recordUsage(s.id, "haiku", { input_tokens: 1000, output_tokens: 100 });

    const sessions = [(await app.sessions.get(s.id))!];
    const status = await checkBudget(app, sessions, { dailyLimit: 100 });
    expect(status.daily.exceeded).toBe(false);
    expect(status.daily.warning).toBe(false);
  });

  it("handles no limits configured", async () => {
    const app = getApp();
    const status = await checkBudget(app, [], {});
    expect(status.daily.limit).toBeNull();
    expect(status.daily.exceeded).toBe(false);
  });
});
