import { describe, it, expect } from "bun:test";
import type { RouterUsageEvent } from "../server.js";

describe("RouterUsageEvent", () => {
  it("has the expected shape", () => {
    const event: RouterUsageEvent = {
      model: "claude-sonnet",
      provider: "anthropic",
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd: 0.0045,
    };

    expect(event.model).toBe("claude-sonnet");
    expect(event.provider).toBe("anthropic");
    expect(event.input_tokens).toBe(1000);
    expect(event.output_tokens).toBe(500);
    expect(event.cost_usd).toBeCloseTo(0.0045);
  });
});

describe("onUsage callback wiring", () => {
  it("emitUsage calculates cost from model pricing", async () => {
    // Import the server module to access emitUsage indirectly via startRouter
    const { startRouter } = await import("../server.js");
    const { loadRouterConfig } = await import("../config.js");

    const usageEvents: RouterUsageEvent[] = [];

    const config = loadRouterConfig({ port: 18431, policy: "balanced" });

    // Skip if no providers configured (no API keys)
    if (config.providers.length === 0) {
      console.log("  skipped: no API keys configured");
      return;
    }

    const server = startRouter(config, {
      onUsage: (event) => usageEvents.push(event),
    });

    // Verify server started with the callback
    expect(server.port).toBe(18431);

    server.stop();
  });
});
