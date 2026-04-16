import { describe, it, expect } from "bun:test";
import { PricingRegistry } from "../pricing.js";

describe("PricingRegistry", () => {
  describe("defaults", () => {
    it("loads default prices on construction", () => {
      const reg = new PricingRegistry();
      expect(reg.size).toBeGreaterThan(0);
    });

    it("includes all expected default models", () => {
      const reg = new PricingRegistry();
      const models = reg.listModels();
      expect(models).toContain("claude-opus-4-6");
      expect(models).toContain("claude-sonnet-4-6");
      expect(models).toContain("claude-haiku-4-5");
      expect(models).toContain("gpt-4.1");
      expect(models).toContain("gpt-4.1-mini");
      expect(models).toContain("gpt-4.1-nano");
      expect(models).toContain("gemini-2.5-pro");
      expect(models).toContain("gemini-2.5-flash");
      expect(models).toContain("o4-mini");
    });
  });

  describe("getPrice", () => {
    it("returns exact match", () => {
      const reg = new PricingRegistry();
      const price = reg.getPrice("claude-opus-4-6");
      expect(price).not.toBeNull();
      expect(price!.input_cost_per_token).toBe(15 / 1e6);
      expect(price!.output_cost_per_token).toBe(75 / 1e6);
    });

    it("resolves Ark alias 'opus' to claude-opus-4-6", () => {
      const reg = new PricingRegistry();
      const price = reg.getPrice("opus");
      expect(price).not.toBeNull();
      expect(price!.input_cost_per_token).toBe(15 / 1e6);
    });

    it("resolves Ark alias 'sonnet' to claude-sonnet-4-6", () => {
      const reg = new PricingRegistry();
      const price = reg.getPrice("sonnet");
      expect(price).not.toBeNull();
      expect(price!.input_cost_per_token).toBe(3 / 1e6);
    });

    it("resolves Ark alias 'haiku' to claude-haiku-4-5", () => {
      const reg = new PricingRegistry();
      const price = reg.getPrice("haiku");
      expect(price).not.toBeNull();
      expect(price!.input_cost_per_token).toBe(0.8 / 1e6);
    });

    it("resolves prefix match", () => {
      const reg = new PricingRegistry();
      // "claude-opus" should prefix-match "claude-opus-4-6"
      const price = reg.getPrice("claude-opus");
      expect(price).not.toBeNull();
      expect(price!.input_cost_per_token).toBe(15 / 1e6);
    });

    it("returns null for completely unknown model", () => {
      const reg = new PricingRegistry();
      const price = reg.getPrice("totally-unknown-model-xyz");
      expect(price).toBeNull();
    });
  });

  describe("calculateCost", () => {
    it("calculates opus cost correctly", () => {
      const reg = new PricingRegistry();
      const cost = reg.calculateCost("opus", {
        input_tokens: 1_000_000,
        output_tokens: 100_000,
      });
      // input: 1M * 15/1M = 15.00, output: 100K * 75/1M = 7.50
      expect(cost).toBeCloseTo(22.5, 2);
    });

    it("calculates sonnet cost with cache tokens", () => {
      const reg = new PricingRegistry();
      const cost = reg.calculateCost("sonnet", {
        input_tokens: 1_000_000,
        output_tokens: 100_000,
        cache_read_tokens: 500_000,
        cache_write_tokens: 200_000,
      });
      // input: 1M * 3/1M = 3.00
      // output: 100K * 15/1M = 1.50
      // cacheRead: 500K * 0.3/1M = 0.15
      // cacheWrite: 200K * 3.75/1M = 0.75
      expect(cost).toBeCloseTo(5.4, 2);
    });

    it("returns 0 for unknown model", () => {
      const reg = new PricingRegistry();
      const cost = reg.calculateCost("nonexistent-model", {
        input_tokens: 1_000_000,
        output_tokens: 100_000,
      });
      expect(cost).toBe(0);
    });

    it("returns 0 for zero tokens", () => {
      const reg = new PricingRegistry();
      const cost = reg.calculateCost("opus", {
        input_tokens: 0,
        output_tokens: 0,
      });
      expect(cost).toBe(0);
    });

    it("calculates GPT-4.1 cost correctly", () => {
      const reg = new PricingRegistry();
      const cost = reg.calculateCost("gpt-4.1", {
        input_tokens: 1_000_000,
        output_tokens: 500_000,
      });
      // input: 1M * 2/1M = 2.00, output: 500K * 8/1M = 4.00
      expect(cost).toBeCloseTo(6.0, 2);
    });

    it("calculates gemini cost correctly", () => {
      const reg = new PricingRegistry();
      const cost = reg.calculateCost("gemini-2.5-flash", {
        input_tokens: 10_000_000,
        output_tokens: 1_000_000,
      });
      // input: 10M * 0.15/1M = 1.50, output: 1M * 0.6/1M = 0.60
      expect(cost).toBeCloseTo(2.1, 2);
    });

    it("uses fallback cache pricing when model lacks cache prices", () => {
      const reg = new PricingRegistry();
      // gpt-4.1 has no cache pricing -- should use fallback (10% of input for read, 125% for write)
      const cost = reg.calculateCost("gpt-4.1", {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 1_000_000,
        cache_write_tokens: 1_000_000,
      });
      // read: 1M * (2/1M * 0.1) = 0.20, write: 1M * (2/1M * 1.25) = 2.50
      expect(cost).toBeCloseTo(2.7, 2);
    });
  });

  describe("fast mode", () => {
    it("applies fast multiplier when speed is fast", () => {
      const reg = new PricingRegistry();
      const normalCost = reg.calculateCost("claude-opus-4-6", {
        input_tokens: 1_000_000,
        output_tokens: 100_000,
      });
      const fastCost = reg.calculateCost("claude-opus-4-6", {
        input_tokens: 1_000_000,
        output_tokens: 100_000,
      }, { speed: "fast" });
      // Opus 4.6 has fastMultiplier: 6, so fast cost should be 6x normal
      expect(fastCost).toBeGreaterThan(normalCost);
      expect(fastCost).toBeCloseTo(normalCost * 6, 2);
    });

    it("defaults to 1 for models without fast multiplier", () => {
      const reg = new PricingRegistry();
      const normalCost = reg.calculateCost("gpt-4.1", {
        input_tokens: 1_000_000,
        output_tokens: 500_000,
      });
      const fastCost = reg.calculateCost("gpt-4.1", {
        input_tokens: 1_000_000,
        output_tokens: 500_000,
      }, { speed: "fast" });
      // GPT-4.1 has no fastMultiplier, defaults to 1 -- fast === normal
      expect(fastCost).toBeCloseTo(normalCost, 2);
    });
  });

  describe("web search", () => {
    it("adds web search cost when requests > 0", () => {
      const reg = new PricingRegistry();
      const baseCost = reg.calculateCost("claude-opus-4-6", {
        input_tokens: 1_000_000,
        output_tokens: 100_000,
      });
      const withSearch = reg.calculateCost("claude-opus-4-6", {
        input_tokens: 1_000_000,
        output_tokens: 100_000,
      }, { webSearchRequests: 3 });
      // 3 web search requests at $0.01 each = $0.03 extra
      expect(withSearch).toBeCloseTo(baseCost + 0.03, 2);
    });
  });
});
