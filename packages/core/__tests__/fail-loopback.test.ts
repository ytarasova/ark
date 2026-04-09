import { describe, it, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "../app.js";
import * as session from "../services/session-orchestration.js";

const { getCtx } = withTestContext();

describe("fail-loopback", () => {
  it("retryWithContext resets status to ready", () => {
    const s = getApp().sessions.create({ summary: "test", flow: "bare" });
    getApp().sessions.update(s.id, { status: "failed", error: "Test failed: expected 3 got 4", stage: "work" });

    const result = session.retryWithContext(getApp(), s.id);
    expect(result.ok).toBe(true);

    const updated = getApp().sessions.get(s.id)!;
    expect(updated.status).toBe("ready");
  });

  it("error context logged as event", () => {
    const s = getApp().sessions.create({ summary: "test", flow: "bare" });
    getApp().sessions.update(s.id, { status: "failed", error: "Something broke", stage: "work" });

    session.retryWithContext(getApp(), s.id);

    const events = getApp().events.list(s.id);
    const retryEvent = events.find(e => e.type === "retry_with_context");
    expect(retryEvent).toBeDefined();
    expect(retryEvent!.data!.error).toBe("Something broke");
    expect(retryEvent!.data!.attempt).toBe(1);
    expect(retryEvent!.data!.stage).toBe("work");
  });

  it("respects max retry count", () => {
    const s = getApp().sessions.create({ summary: "test", flow: "bare" });
    // Simulate 3 prior retries
    for (let i = 0; i < 3; i++) {
      getApp().events.log(s.id, "retry_with_context", { actor: "system", data: { attempt: i + 1 } });
    }
    getApp().sessions.update(s.id, { status: "failed", error: "still broken" });

    const result = session.retryWithContext(getApp(), s.id, { maxRetries: 3 });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Max retries");
  });

  it("rejects non-failed sessions", () => {
    const s = getApp().sessions.create({ summary: "test", flow: "bare" });
    getApp().sessions.update(s.id, { status: "running" });

    const result = session.retryWithContext(getApp(), s.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not in failed state");
  });
});
