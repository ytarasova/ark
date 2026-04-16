import { describe, it, expect, beforeEach } from "bun:test";
import {
  track,
  getBuffer,
  clearBuffer,
  enableTelemetry,
  disableTelemetry,
  isTelemetryEnabled,
} from "../observability/telemetry.js";

describe("telemetry", () => {
  beforeEach(() => {
    clearBuffer();
    disableTelemetry();
  });

  it("disabled by default (no ARK_TELEMETRY env)", () => {
    track("test_event");
    expect(getBuffer()).toHaveLength(0);
  });

  it("tracks events when enabled", () => {
    enableTelemetry();
    track("session_created", { flow: "default" });
    expect(getBuffer()).toHaveLength(1);
    expect(getBuffer()[0].event).toBe("session_created");
  });

  it("respects max buffer size", () => {
    enableTelemetry();
    for (let i = 0; i < 150; i++) track(`event_${i}`);
    expect(getBuffer().length).toBeLessThanOrEqual(100);
  });

  it("clearBuffer empties the buffer", () => {
    enableTelemetry();
    track("a");
    track("b");
    clearBuffer();
    expect(getBuffer()).toHaveLength(0);
  });

  it("isTelemetryEnabled reflects state", () => {
    expect(isTelemetryEnabled()).toBe(false);
    enableTelemetry();
    expect(isTelemetryEnabled()).toBe(true);
  });
});
