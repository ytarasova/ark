import { describe, it, expect, beforeEach } from "bun:test";
import {
  configureObservability,
  recordEvent,
  getEventBuffer,
  resetObservability,
  getObservabilityConfig,
} from "../observability.js";

describe("observability", () => {
  beforeEach(() => resetObservability());

  it("does not record when disabled", () => {
    recordEvent({ type: "session_start", sessionId: "s-1", data: {} });
    expect(getEventBuffer()).toHaveLength(0);
  });

  it("records events when enabled", () => {
    configureObservability({ enabled: true, endpoint: "https://example.com" });
    recordEvent({ type: "session_start", sessionId: "s-1", data: { flow: "default" } });
    expect(getEventBuffer()).toHaveLength(1);
    expect(getEventBuffer()[0].type).toBe("session_start");
  });

  it("events have timestamp", () => {
    configureObservability({ enabled: true, endpoint: "https://example.com" });
    recordEvent({ type: "tool_call", sessionId: "s-1", data: { tool: "Bash" } });
    expect(getEventBuffer()[0].timestamp).toBeDefined();
  });

  it("getObservabilityConfig returns copy", () => {
    configureObservability({ enabled: true, provider: "langfuse" });
    const config = getObservabilityConfig();
    expect(config.provider).toBe("langfuse");
  });

  it("resetObservability clears everything", () => {
    configureObservability({ enabled: true, endpoint: "https://example.com" });
    recordEvent({ type: "error", sessionId: "s-1", data: {} });
    resetObservability();
    expect(getEventBuffer()).toHaveLength(0);
    expect(getObservabilityConfig().enabled).toBe(false);
  });
});
