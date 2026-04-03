import { describe, it, expect } from "bun:test";
import { calculateCost, formatCost, getSessionCost, getAllSessionCosts } from "../costs.js";
import type { TranscriptUsage } from "../claude.js";
import { createSession, getSession, updateSession } from "../store.js";
import { withTestContext } from "./test-helpers.js";

withTestContext();

describe("calculateCost", () => {
  it("calculates sonnet cost correctly", () => {
    const usage: TranscriptUsage = {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      cache_read_input_tokens: 500_000,
      cache_creation_input_tokens: 200_000,
      total_tokens: 1_800_000,
    };
    const cost = calculateCost(usage, "sonnet");
    // input: 1M * 3/1M = 3.00, output: 100K * 15/1M = 1.50
    // cacheRead: 500K * 0.30/1M = 0.15, cacheWrite: 200K * 3.75/1M = 0.75
    // Total: 5.40
    expect(cost).toBeCloseTo(5.40, 2);
  });

  it("calculates opus cost correctly", () => {
    const usage: TranscriptUsage = {
      input_tokens: 100_000, output_tokens: 10_000,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_tokens: 110_000,
    };
    const cost = calculateCost(usage, "opus");
    // input: 100K * 15/1M = 1.50, output: 10K * 75/1M = 0.75
    expect(cost).toBeCloseTo(2.25, 2);
  });

  it("calculates haiku cost correctly", () => {
    const usage: TranscriptUsage = {
      input_tokens: 1_000_000, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_tokens: 1_000_000,
    };
    const cost = calculateCost(usage, "haiku");
    // input: 1M * 0.80/1M = 0.80
    expect(cost).toBeCloseTo(0.80, 2);
  });

  it("defaults to sonnet for unknown model", () => {
    const usage: TranscriptUsage = {
      input_tokens: 1_000_000, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_tokens: 1_000_000,
    };
    expect(calculateCost(usage, "unknown")).toBeCloseTo(3.00, 2);
    expect(calculateCost(usage, null)).toBeCloseTo(3.00, 2);
  });
});

describe("formatCost", () => {
  it("formats zero", () => expect(formatCost(0)).toBe("$0.00"));
  it("formats small cost", () => expect(formatCost(0.005)).toBe("<$0.01"));
  it("formats normal cost", () => expect(formatCost(1.234)).toBe("$1.23"));
  it("formats large cost", () => expect(formatCost(99.99)).toBe("$99.99"));
});

describe("getSessionCost", () => {
  it("returns cost from session config usage", () => {
    const s = createSession({ summary: "test" });
    updateSession(s.id, {
      agent: "sonnet",
      config: {
        usage: {
          input_tokens: 1_000_000, output_tokens: 0,
          cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_tokens: 1_000_000,
        },
      },
    });
    const refreshed = getSession(s.id)!;
    const sc = getSessionCost(refreshed);
    expect(sc.cost).toBeCloseTo(3.00, 2);
  });

  it("returns 0 cost for session without usage", () => {
    const s = createSession({ summary: "no-usage" });
    const sc = getSessionCost(s);
    expect(sc.cost).toBe(0);
  });
});

describe("getAllSessionCosts", () => {
  it("returns sorted costs and total", () => {
    const s1 = createSession({ summary: "cheap" });
    const s2 = createSession({ summary: "expensive" });
    updateSession(s1.id, {
      agent: "haiku",
      config: { usage: { input_tokens: 100_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_tokens: 100_000 } },
    });
    updateSession(s2.id, {
      agent: "opus",
      config: { usage: { input_tokens: 100_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_tokens: 100_000 } },
    });
    const sessions = [getSession(s1.id)!, getSession(s2.id)!];
    const result = getAllSessionCosts(sessions);
    expect(result.sessions.length).toBe(2);
    expect(result.sessions[0].sessionId).toBe(s2.id); // opus is more expensive
    expect(result.total).toBeGreaterThan(0);
  });

  it("filters out zero-cost sessions", () => {
    const s1 = createSession({ summary: "has-cost" });
    const s2 = createSession({ summary: "no-cost" });
    updateSession(s1.id, {
      agent: "sonnet",
      config: { usage: { input_tokens: 100_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_tokens: 100_000 } },
    });
    const sessions = [getSession(s1.id)!, s2];
    const result = getAllSessionCosts(sessions);
    expect(result.sessions.length).toBe(1);
    expect(result.sessions[0].sessionId).toBe(s1.id);
  });
});
