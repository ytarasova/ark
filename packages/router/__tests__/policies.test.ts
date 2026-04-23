/**
 * Tests for pluggable routing policies (Open/Closed Principle).
 *
 * Verifies that the engine dispatches to a custom `PolicySelector` without
 * any switch/case modification in engine.ts.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { RoutingEngine } from "../engine.js";
import { ProviderRegistry } from "../providers.js";
import { defaultPolicyRegistry, TierEscalator, type PolicySelector, type Tier } from "../policies/index.js";
import type { RouterConfig, ModelConfig } from "../types.js";
import type { ClassificationResult } from "../classifier.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<RouterConfig>): RouterConfig {
  return {
    port: 8430,
    policy: "balanced",
    quality_floor: 0.8,
    providers: [],
    sticky_session_ttl_ms: 3600000,
    cascade_enabled: false,
    cascade_confidence_threshold: 0.7,
    log_decisions: false,
    ...overrides,
  };
}

const TEST_MODELS: ModelConfig[] = [
  {
    id: "fast-economy",
    provider: "p-fast",
    tier: "economy",
    cost_input: 1.0,
    cost_output: 2.0,
    max_context: 200000,
    supports_tools: true,
    quality: 0.8,
  },
  {
    id: "slow-frontier",
    provider: "p-slow",
    tier: "frontier",
    cost_input: 30.0,
    cost_output: 60.0,
    max_context: 200000,
    supports_tools: true,
    quality: 0.99,
  },
];

function makeRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register({
    name: "p-fast",
    base_url: "http://localhost:9999",
    models: TEST_MODELS.filter((m) => m.provider === "p-fast"),
  });
  registry.register({
    name: "p-slow",
    base_url: "http://localhost:9998",
    models: TEST_MODELS.filter((m) => m.provider === "p-slow"),
  });
  return registry;
}

function makeClassification(overrides?: Partial<ClassificationResult>): ClassificationResult {
  return {
    score: 0.5,
    task_type: "generation",
    difficulty: "moderate",
    has_tools: false,
    context_length: 500,
    turn_count: 2,
    signals: [],
    ...overrides,
  };
}

// ── Custom policy: "latency-aware-v2" (picks model with lowest tier index) ───

class LatencyAwarePolicy implements PolicySelector {
  readonly name = "latency-aware-v2";
  selectCalls = 0;

  select(candidates: ModelConfig[]): ModelConfig {
    this.selectCalls++;
    // Pretend economy tier is fastest; prefer economy > standard > frontier.
    const rank = (m: ModelConfig) => (m.tier === "economy" ? 0 : m.tier === "standard" ? 1 : 2);
    return candidates.reduce((best, m) => (rank(m) < rank(best) ? m : best), candidates[0]);
  }

  skipReason(model: ModelConfig, selected: ModelConfig): string | null {
    if (model.tier === selected.tier) return null;
    return "higher_latency_tier";
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("RoutingEngine policy extensibility", () => {
  let engine: RoutingEngine;

  afterEach(() => {
    engine?.stop();
  });

  test("engine dispatches to a registered custom policy without modifying engine.ts", () => {
    const registry = makeRegistry();
    const policies = defaultPolicyRegistry();
    const custom = new LatencyAwarePolicy();
    policies.register(custom);

    engine = new RoutingEngine(registry, makeConfig({ policy: "balanced" }), { policies });

    const decision = engine.route(
      {
        model: "auto",
        messages: [{ role: "user", content: "test" }],
        routing: { policy: "latency-aware-v2" },
      },
      makeClassification({ score: 0.9, difficulty: "complex" }),
    );

    // Despite score=0.9 (which would push balanced to frontier), the custom
    // policy returns economy-tier.
    expect(decision.selected_model).toBe("fast-economy");
    expect(decision.reason).toContain("policy:latency-aware-v2");
    expect(custom.selectCalls).toBe(1);
  });

  test("unknown policy falls back to the config default", () => {
    const registry = makeRegistry();
    engine = new RoutingEngine(registry, makeConfig({ policy: "quality" }));

    const decision = engine.route(
      {
        model: "auto",
        messages: [{ role: "user", content: "test" }],
        routing: { policy: "nonexistent-policy" },
      },
      makeClassification({ score: 0.5 }),
    );

    // Fallback "quality" picks the highest-quality model regardless.
    expect(decision.selected_model).toBe("slow-frontier");
    // The fallback selector's name shows up in the reason.
    expect(decision.reason).toContain("policy:quality");
  });

  test("registerPolicy() on the engine enables custom policies post-construction", () => {
    const registry = makeRegistry();
    engine = new RoutingEngine(registry, makeConfig({ policy: "balanced" }));

    const custom = new LatencyAwarePolicy();
    engine.registerPolicy(custom);

    const decision = engine.route(
      {
        model: "auto",
        messages: [{ role: "user", content: "test" }],
        routing: { policy: "latency-aware-v2" },
      },
      makeClassification({ score: 0.9, difficulty: "complex" }),
    );

    expect(decision.selected_model).toBe("fast-economy");
    expect(custom.selectCalls).toBe(1);
  });
});

describe("TierEscalator", () => {
  test("default ladder promotes economy -> standard -> frontier", () => {
    const esc = new TierEscalator();
    expect(esc.higherTiers("economy")).toEqual(["standard", "frontier"] as Tier[]);
    expect(esc.higherTiers("standard")).toEqual(["frontier"] as Tier[]);
    expect(esc.higherTiers("frontier")).toEqual([] as Tier[]);
  });

  test("unknown tier returns an empty ladder", () => {
    const esc = new TierEscalator();
    expect(esc.higherTiers("platinum")).toEqual([]);
  });
});
