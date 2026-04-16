import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../../app.js";

let app: AppContext;

beforeAll(async () => {
  app = AppContext.forTest();
  await app.boot();
  setApp(app);
});

afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

describe("UsageRecorder", () => {
  describe("record", () => {
    it("inserts a usage record", () => {
      const session = app.sessions.create({ summary: "usage-test" });
      app.usageRecorder.record({
        sessionId: session.id,
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        runtime: "claude",
        agentRole: "implementer",
        usage: {
          input_tokens: 1_000_000,
          output_tokens: 100_000,
          cache_read_tokens: 500_000,
          cache_write_tokens: 200_000,
        },
        source: "transcript",
      });

      const { cost, records } = app.usageRecorder.getSessionCost(session.id);
      expect(records).toHaveLength(1);
      expect(records[0].model).toBe("claude-sonnet-4-6");
      expect(records[0].provider).toBe("anthropic");
      expect(records[0].runtime).toBe("claude");
      expect(records[0].agent_role).toBe("implementer");
      expect(records[0].input_tokens).toBe(1_000_000);
      expect(records[0].output_tokens).toBe(100_000);
      expect(records[0].cache_read_tokens).toBe(500_000);
      expect(records[0].cache_write_tokens).toBe(200_000);
      expect(records[0].source).toBe("transcript");
      expect(cost).toBeGreaterThan(0);
      // sonnet: input 3.00 + output 1.50 + cacheRead 0.15 + cacheWrite 0.75 = 5.40
      expect(cost).toBeCloseTo(5.4, 2);
    });

    it("uses default tenant and source", () => {
      const session = app.sessions.create({ summary: "defaults-test" });
      app.usageRecorder.record({
        sessionId: session.id,
        model: "gpt-4.1",
        provider: "openai",
        usage: { input_tokens: 1000, output_tokens: 500 },
      });

      const { records } = app.usageRecorder.getSessionCost(session.id);
      expect(records[0].tenant_id).toBe("default");
      expect(records[0].source).toBe("api");
    });
  });

  describe("getSessionCost", () => {
    it("sums multiple records for a session", () => {
      const session = app.sessions.create({ summary: "multi-record" });
      app.usageRecorder.record({
        sessionId: session.id,
        model: "claude-haiku-4-5",
        provider: "anthropic",
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      });
      app.usageRecorder.record({
        sessionId: session.id,
        model: "claude-haiku-4-5",
        provider: "anthropic",
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      });

      const { cost, records } = app.usageRecorder.getSessionCost(session.id);
      expect(records).toHaveLength(2);
      // haiku input: 1M * 0.8/1M = 0.80 each, total = 1.60
      expect(cost).toBeCloseTo(1.6, 2);
    });

    it("returns zero for session with no records", () => {
      const { cost, records } = app.usageRecorder.getSessionCost("nonexistent-session");
      expect(records).toHaveLength(0);
      expect(cost).toBe(0);
    });
  });

  describe("getSummary", () => {
    it("groups by model correctly", () => {
      const session = app.sessions.create({ summary: "summary-test" });
      app.usageRecorder.record({
        sessionId: session.id,
        model: "test-model-a",
        provider: "test-provider",
        usage: { input_tokens: 100, output_tokens: 50 },
      });
      app.usageRecorder.record({
        sessionId: session.id,
        model: "test-model-a",
        provider: "test-provider",
        usage: { input_tokens: 200, output_tokens: 100 },
      });
      app.usageRecorder.record({
        sessionId: session.id,
        model: "test-model-b",
        provider: "test-provider",
        usage: { input_tokens: 50, output_tokens: 25 },
      });

      const summary = app.usageRecorder.getSummary({ groupBy: "model" });
      const modelA = summary.find((r) => r.key === "test-model-a");
      const modelB = summary.find((r) => r.key === "test-model-b");

      expect(modelA).toBeDefined();
      expect(modelA!.count).toBe(2);
      expect(modelA!.input_tokens).toBe(300);
      expect(modelA!.output_tokens).toBe(150);

      expect(modelB).toBeDefined();
      expect(modelB!.count).toBe(1);
      expect(modelB!.input_tokens).toBe(50);
    });

    it("groups by provider", () => {
      const summary = app.usageRecorder.getSummary({ groupBy: "provider" });
      expect(summary.length).toBeGreaterThan(0);
      // Should have at least "anthropic" from the earlier tests
      const anthropic = summary.find((r) => r.key === "anthropic");
      expect(anthropic).toBeDefined();
    });

    it("rejects invalid groupBy column", () => {
      expect(() => app.usageRecorder.getSummary({ groupBy: "DROP TABLE sessions" })).toThrow();
    });

    it("filters by tenant", () => {
      const session = app.sessions.create({ summary: "tenant-test" });
      app.usageRecorder.record({
        sessionId: session.id,
        tenantId: "team-alpha",
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        usage: { input_tokens: 1000, output_tokens: 500 },
      });

      const summary = app.usageRecorder.getSummary({ tenantId: "team-alpha", groupBy: "model" });
      expect(summary.length).toBeGreaterThan(0);
      const total = summary.reduce((s, r) => s + r.count, 0);
      expect(total).toBe(1);
    });
  });

  describe("getDailyTrend", () => {
    it("returns daily aggregates", () => {
      const session = app.sessions.create({ summary: "trend-test" });
      app.usageRecorder.record({
        sessionId: session.id,
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        usage: { input_tokens: 1_000_000, output_tokens: 100_000 },
      });

      const trend = app.usageRecorder.getDailyTrend({ days: 1 });
      expect(trend.length).toBeGreaterThan(0);
      expect(trend[0].date).toBeDefined();
      expect(trend[0].cost).toBeGreaterThan(0);
    });

    it("returns empty for no data in range", () => {
      const trend = app.usageRecorder.getDailyTrend({ tenantId: "nonexistent-tenant", days: 1 });
      expect(trend).toHaveLength(0);
    });
  });

  describe("getTotalCost", () => {
    it("returns total across all records", () => {
      const total = app.usageRecorder.getTotalCost();
      expect(total).toBeGreaterThan(0);
    });

    it("filters by tenant", () => {
      const total = app.usageRecorder.getTotalCost({ tenantId: "nonexistent-tenant" });
      expect(total).toBe(0);
    });
  });

  describe("multi-runtime tracking", () => {
    it("tracks costs across different runtimes", () => {
      const session = app.sessions.create({ summary: "multi-runtime" });

      // Claude usage
      app.usageRecorder.record({
        sessionId: session.id,
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        runtime: "claude",
        usage: { input_tokens: 500_000, output_tokens: 50_000 },
      });

      // Codex usage
      app.usageRecorder.record({
        sessionId: session.id,
        model: "gpt-4.1-mini",
        provider: "openai",
        runtime: "codex",
        usage: { input_tokens: 200_000, output_tokens: 20_000 },
      });

      // Gemini usage
      app.usageRecorder.record({
        sessionId: session.id,
        model: "gemini-2.5-flash",
        provider: "google",
        runtime: "gemini",
        usage: { input_tokens: 1_000_000, output_tokens: 100_000 },
      });

      const { cost, records } = app.usageRecorder.getSessionCost(session.id);
      expect(records).toHaveLength(3);
      expect(cost).toBeGreaterThan(0);

      // Check runtime grouping
      const runtimeSummary = app.usageRecorder.getSummary({ groupBy: "runtime" });
      const claude = runtimeSummary.find((r) => r.key === "claude");
      const codex = runtimeSummary.find((r) => r.key === "codex");
      const gemini = runtimeSummary.find((r) => r.key === "gemini");
      expect(claude).toBeDefined();
      expect(codex).toBeDefined();
      expect(gemini).toBeDefined();
    });
  });
});
