/**
 * Tests for the routing engine.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { RoutingEngine } from "../engine.js";
import { ProviderRegistry } from "../providers.js";
import type { RouterConfig, ModelConfig } from "../types.js";
import type { ClassificationResult } from "../classifier.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

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
    id: "frontier-a",
    provider: "test-a",
    tier: "frontier",
    cost_input: 15.0,
    cost_output: 75.0,
    max_context: 200000,
    supports_tools: true,
    quality: 0.98,
  },
  {
    id: "standard-a",
    provider: "test-a",
    tier: "standard",
    cost_input: 3.0,
    cost_output: 15.0,
    max_context: 200000,
    supports_tools: true,
    quality: 0.92,
  },
  {
    id: "economy-a",
    provider: "test-a",
    tier: "economy",
    cost_input: 0.8,
    cost_output: 4.0,
    max_context: 200000,
    supports_tools: true,
    quality: 0.82,
  },
  {
    id: "economy-b",
    provider: "test-b",
    tier: "economy",
    cost_input: 0.1,
    cost_output: 0.4,
    max_context: 1000000,
    supports_tools: true,
    quality: 0.75,
  },
  {
    id: "frontier-b",
    provider: "test-b",
    tier: "frontier",
    cost_input: 2.0,
    cost_output: 8.0,
    max_context: 1000000,
    supports_tools: true,
    quality: 0.95,
  },
];

async function makeRegistry(): Promise<ProviderRegistry> {
  const registry = new ProviderRegistry();
  await registry.register({
    name: "test-a",
    base_url: "http://localhost:9999",
    models: TEST_MODELS.filter((m) => m.provider === "test-a"),
  });
  await registry.register({
    name: "test-b",
    base_url: "http://localhost:9998",
    models: TEST_MODELS.filter((m) => m.provider === "test-b"),
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("RoutingEngine", () => {
  let engine: RoutingEngine;
  let registry: ProviderRegistry;

  beforeEach(async () => {
    registry = await makeRegistry();
  });

  afterEach(() => {
    engine?.stop();
  });

  test("quality policy always picks highest quality model", () => {
    engine = new RoutingEngine(registry, makeConfig({ policy: "quality" }));
    const decision = engine.route(
      { model: "auto", messages: [{ role: "user", content: "test" }] },
      makeClassification({ score: 0.1, difficulty: "trivial" }),
    );
    expect(decision.selected_model).toBe("frontier-a"); // quality 0.98
  });

  test("cost policy picks cheapest model", () => {
    engine = new RoutingEngine(registry, makeConfig({ policy: "cost" }));
    const decision = engine.route(
      { model: "auto", messages: [{ role: "user", content: "test" }] },
      makeClassification({ score: 0.1, difficulty: "trivial" }),
    );
    expect(decision.selected_model).toBe("economy-b"); // cost 0.1 + 0.4 = 0.5
  });

  test("balanced policy picks economy tier for low complexity", () => {
    engine = new RoutingEngine(registry, makeConfig({ policy: "balanced", quality_floor: 0.7 }));
    const decision = engine.route(
      { model: "auto", messages: [{ role: "user", content: "test" }] },
      makeClassification({ score: 0.1, difficulty: "trivial" }),
    );
    expect(decision.selected_model).toBe("economy-b"); // cheapest economy above floor
  });

  test("balanced policy picks standard tier for moderate complexity", () => {
    engine = new RoutingEngine(registry, makeConfig({ policy: "balanced", quality_floor: 0.7 }));
    const decision = engine.route(
      { model: "auto", messages: [{ role: "user", content: "test" }] },
      makeClassification({ score: 0.5, difficulty: "moderate" }),
    );
    expect(decision.selected_model).toBe("standard-a"); // only standard model
  });

  test("balanced policy picks frontier tier for high complexity", () => {
    engine = new RoutingEngine(registry, makeConfig({ policy: "balanced", quality_floor: 0.7 }));
    const decision = engine.route(
      { model: "auto", messages: [{ role: "user", content: "test" }] },
      makeClassification({ score: 0.8, difficulty: "complex" }),
    );
    // Should pick cheapest frontier: frontier-b (cost 10) vs frontier-a (cost 90)
    expect(decision.selected_model).toBe("frontier-b");
  });

  test("balanced policy respects quality floor", () => {
    engine = new RoutingEngine(registry, makeConfig({ policy: "balanced", quality_floor: 0.9 }));
    const decision = engine.route(
      { model: "auto", messages: [{ role: "user", content: "test" }] },
      makeClassification({ score: 0.1, difficulty: "trivial" }),
    );
    // Economy models are below 0.9 floor, so should upgrade
    expect(["standard-a", "frontier-a", "frontier-b"]).toContain(decision.selected_model);
  });

  test("sticky sessions maintain model selection", () => {
    engine = new RoutingEngine(registry, makeConfig({ policy: "balanced", quality_floor: 0.7 }));

    // First request
    const decision1 = engine.route(
      { model: "auto", messages: [{ role: "user", content: "test" }], routing: { sticky_session_id: "sess-1" } },
      makeClassification({ score: 0.5, difficulty: "moderate" }),
    );

    // Second request with same session -- should stick
    const decision2 = engine.route(
      { model: "auto", messages: [{ role: "user", content: "test" }], routing: { sticky_session_id: "sess-1" } },
      makeClassification({ score: 0.55, difficulty: "moderate" }),
    );

    expect(decision2.selected_model).toBe(decision1.selected_model);
    expect(decision2.reason).toContain("sticky_session");
  });

  test("sticky sessions escalate on complexity spike", () => {
    engine = new RoutingEngine(registry, makeConfig({ policy: "balanced", quality_floor: 0.7 }));

    // First request (low complexity)
    const decision1 = engine.route(
      { model: "auto", messages: [{ role: "user", content: "test" }], routing: { sticky_session_id: "sess-2" } },
      makeClassification({ score: 0.2, difficulty: "simple" }),
    );

    // Second request -- big complexity spike (>0.3 delta)
    const decision2 = engine.route(
      { model: "auto", messages: [{ role: "user", content: "test" }], routing: { sticky_session_id: "sess-2" } },
      makeClassification({ score: 0.8, difficulty: "complex" }),
    );

    // Should have re-routed (not sticky)
    expect(decision2.reason).not.toContain("sticky_session");
  });

  test("excluded models are filtered out", () => {
    engine = new RoutingEngine(registry, makeConfig({ policy: "quality" }));
    const decision = engine.route(
      {
        model: "auto",
        messages: [{ role: "user", content: "test" }],
        routing: { excluded_models: ["frontier-a"] },
      },
      makeClassification(),
    );
    expect(decision.selected_model).not.toBe("frontier-a");
  });

  test("preferred providers filter models", () => {
    engine = new RoutingEngine(registry, makeConfig({ policy: "quality" }));
    const decision = engine.route(
      {
        model: "auto",
        messages: [{ role: "user", content: "test" }],
        routing: { preferred_providers: ["test-b"] },
      },
      makeClassification(),
    );
    expect(decision.selected_provider).toBe("test-b");
  });

  test("routing decision includes alternatives", () => {
    engine = new RoutingEngine(registry, makeConfig({ policy: "quality" }));
    const decision = engine.route(
      { model: "auto", messages: [{ role: "user", content: "test" }] },
      makeClassification(),
    );
    expect(decision.alternatives_considered.length).toBeGreaterThan(0);
  });

  test("routing decision includes latency info", () => {
    engine = new RoutingEngine(registry, makeConfig());
    const decision = engine.route(
      { model: "auto", messages: [{ role: "user", content: "test" }] },
      makeClassification(),
    );
    expect(decision.latency_ms.routing).toBeGreaterThanOrEqual(0);
  });
});
