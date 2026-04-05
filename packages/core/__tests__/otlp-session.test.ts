import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import { configureOtlp, resetOtlp, getSpanBuffer, emitSessionSpanStart, emitSessionSpanEnd, emitStageSpanStart, emitStageSpanEnd, getSessionTraceId } from "../otlp.js";

withTestContext();

beforeEach(() => {
  resetOtlp();
  configureOtlp({ enabled: true, endpoint: "http://localhost:9999/v1/traces" });
});
afterEach(() => { resetOtlp(); });

describe("OTLP session integration", () => {
  it("emitSessionSpanStart creates a root span", () => {
    emitSessionSpanStart("s-1", { flow: "default", repo: "/tmp/repo", agent: "worker" });
    const traceId = getSessionTraceId("s-1");
    expect(traceId).toBeDefined();
  });

  it("emitStageSpanStart creates a child span", () => {
    emitSessionSpanStart("s-2", { flow: "default", repo: "/tmp/repo" });
    emitStageSpanStart("s-2", { stage: "plan", agent: "planner", gate: "auto" });
    expect(getSpanBuffer().length).toBe(0);  // still active, not in buffer
  });

  it("full lifecycle produces parent+child spans", () => {
    emitSessionSpanStart("s-3", { flow: "default", repo: "/tmp/repo" });
    emitStageSpanStart("s-3", { stage: "plan", agent: "planner", gate: "auto" });
    emitStageSpanEnd("s-3", { status: "completed" });
    emitStageSpanStart("s-3", { stage: "implement", agent: "implementer", gate: "auto" });
    emitStageSpanEnd("s-3", { status: "completed" });
    emitSessionSpanEnd("s-3", { status: "completed", tokens_in: 1000, tokens_out: 500, cost_usd: 0.02, turns: 5 });

    const buffer = getSpanBuffer();
    expect(buffer.length).toBe(3);  // 2 stage + 1 session

    const session = buffer.find(s => s.name === "session");
    const plan = buffer.find(s => s.name === "stage:plan");
    const impl = buffer.find(s => s.name === "stage:implement");

    expect(session).toBeDefined();
    expect(plan!.parentSpanId).toBeDefined();
    expect(impl!.parentSpanId).toBe(plan!.parentSpanId);  // same parent
  });
});
