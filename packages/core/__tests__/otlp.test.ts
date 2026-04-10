import { describe, it, expect, beforeEach } from "bun:test";
import {
  configureOtlp, resetOtlp, startSpan, endSpan, getSpanBuffer, flushSpans,
  type OtlpConfig,
} from "../observability/otlp.js";

beforeEach(() => resetOtlp());

describe("OTLP span builder", () => {
  it("startSpan creates a span with correct attributes", () => {
    configureOtlp({ enabled: true, endpoint: "http://localhost:4318/v1/traces" });
    const spanId = startSpan({
      name: "session",
      traceId: "abc123",
      attributes: { "session.id": "s-1", "session.flow": "default" },
    });
    expect(spanId).toBeDefined();
    expect(typeof spanId).toBe("string");
  });

  it("endSpan finalizes the span and adds to buffer", () => {
    configureOtlp({ enabled: true, endpoint: "http://localhost:4318/v1/traces" });
    const spanId = startSpan({ name: "session", traceId: "trace-1", attributes: {} });
    endSpan(spanId, { "session.status": "completed", "cost.usd": 0.05 });
    const buffer = getSpanBuffer();
    expect(buffer.length).toBe(1);
    expect(buffer[0].name).toBe("session");
    expect(buffer[0].endTimeUnixNano).toBeDefined();
  });

  it("child span has correct parentSpanId", () => {
    configureOtlp({ enabled: true, endpoint: "http://localhost:4318/v1/traces" });
    const parentId = startSpan({ name: "session", traceId: "trace-1", attributes: {} });
    const childId = startSpan({ name: "stage:plan", traceId: "trace-1", parentSpanId: parentId, attributes: { "stage.name": "plan" } });
    endSpan(childId);
    endSpan(parentId);
    const buffer = getSpanBuffer();
    expect(buffer.length).toBe(2);
    const child = buffer.find(s => s.name === "stage:plan");
    expect(child!.parentSpanId).toBe(parentId);
  });

  it("does nothing when disabled", () => {
    configureOtlp({ enabled: false });
    const spanId = startSpan({ name: "session", traceId: "t1", attributes: {} });
    expect(spanId).toBe("");
    expect(getSpanBuffer().length).toBe(0);
  });

  it("flushSpans formats OTLP JSON and clears buffer", async () => {
    configureOtlp({ enabled: true, endpoint: "http://localhost:9999/v1/traces" });
    const spanId = startSpan({ name: "session", traceId: "trace-1", attributes: { "session.id": "s-1" } });
    endSpan(spanId, { "session.status": "completed" });
    await flushSpans();
    expect(getSpanBuffer().length).toBe(0);
  });
});
