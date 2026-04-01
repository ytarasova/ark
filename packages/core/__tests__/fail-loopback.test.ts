import { describe, it, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import * as store from "../store.js";
import * as session from "../session.js";

const { getCtx } = withTestContext();

describe("fail-loopback", () => {
  it("retryWithContext resets status to ready", () => {
    const s = store.createSession({ summary: "test", flow: "bare" });
    store.updateSession(s.id, { status: "failed", error: "Test failed: expected 3 got 4", stage: "work" });

    const result = session.retryWithContext(s.id);
    expect(result.ok).toBe(true);

    const updated = store.getSession(s.id)!;
    expect(updated.status).toBe("ready");
  });

  it("error context logged as event", () => {
    const s = store.createSession({ summary: "test", flow: "bare" });
    store.updateSession(s.id, { status: "failed", error: "Something broke", stage: "work" });

    session.retryWithContext(s.id);

    const events = store.getEvents(s.id);
    const retryEvent = events.find(e => e.type === "retry_with_context");
    expect(retryEvent).toBeDefined();
    expect(retryEvent!.data!.error).toBe("Something broke");
    expect(retryEvent!.data!.attempt).toBe(1);
    expect(retryEvent!.data!.stage).toBe("work");
  });

  it("respects max retry count", () => {
    const s = store.createSession({ summary: "test", flow: "bare" });
    // Simulate 3 prior retries
    for (let i = 0; i < 3; i++) {
      store.logEvent(s.id, "retry_with_context", { actor: "system", data: { attempt: i + 1 } });
    }
    store.updateSession(s.id, { status: "failed", error: "still broken" });

    const result = session.retryWithContext(s.id, { maxRetries: 3 });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Max retries");
  });

  it("rejects non-failed sessions", () => {
    const s = store.createSession({ summary: "test", flow: "bare" });
    store.updateSession(s.id, { status: "running" });

    const result = session.retryWithContext(s.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not in failed state");
  });
});
