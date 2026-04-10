import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { track, flush, getBuffer, clearBuffer, disableTelemetry, configureTelemetry, resetTelemetry } from "../observability/telemetry.js";

beforeEach(() => { clearBuffer(); disableTelemetry(); });
afterEach(() => { resetTelemetry(); });

describe("telemetry flush", () => {
  it("flush sends events and clears buffer", async () => {
    configureTelemetry({ enabled: true, endpoint: "http://localhost:19999/telemetry" });
    track("test_event", { foo: "bar" });
    expect(getBuffer().length).toBe(1);
    await flush();
    expect(getBuffer().length).toBe(0);
  });

  it("flush clears buffer even without endpoint", async () => {
    configureTelemetry({ enabled: true });
    track("test_event");
    await flush();
    expect(getBuffer().length).toBe(0);
  });

  it("track is no-op when disabled", () => {
    configureTelemetry({ enabled: false });
    track("test_event");
    expect(getBuffer().length).toBe(0);
  });
});
