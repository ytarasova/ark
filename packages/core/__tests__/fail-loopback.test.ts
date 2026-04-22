import { describe, it, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

const { getCtx } = withTestContext();

describe("fail-loopback", () => {
  it("retryWithContext resets status to ready", async () => {
    const s = await getApp().sessions.create({ summary: "test", flow: "bare" });
    await getApp().sessions.update(s.id, { status: "failed", error: "Test failed: expected 3 got 4", stage: "work" });

    const result = await getApp().sessionHooks.retryWithContext(s.id);
    expect(result.ok).toBe(true);

    const updated = (await getApp().sessions.get(s.id))!;
    expect(updated.status).toBe("ready");
  });

  it("error context logged as event", async () => {
    const s = await getApp().sessions.create({ summary: "test", flow: "bare" });
    await getApp().sessions.update(s.id, { status: "failed", error: "Something broke", stage: "work" });

    await getApp().sessionHooks.retryWithContext(s.id);

    const events = await getApp().events.list(s.id);
    const retryEvent = events.find((e) => e.type === "retry_with_context");
    expect(retryEvent).toBeDefined();
    expect(retryEvent!.data!.error).toBe("Something broke");
    expect(retryEvent!.data!.attempt).toBe(1);
    expect(retryEvent!.data!.stage).toBe("work");
  });

  it("respects max retry count", async () => {
    const s = await getApp().sessions.create({ summary: "test", flow: "bare" });
    // Simulate 3 prior retries
    for (let i = 0; i < 3; i++) {
      await getApp().events.log(s.id, "retry_with_context", { actor: "system", data: { attempt: i + 1 } });
    }
    await getApp().sessions.update(s.id, { status: "failed", error: "still broken" });

    const result = await getApp().sessionHooks.retryWithContext(s.id, { maxRetries: 3 });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Max retries");
  });

  it("rejects non-failed sessions", async () => {
    const s = await getApp().sessions.create({ summary: "test", flow: "bare" });
    await getApp().sessions.update(s.id, { status: "running" });

    const result = await getApp().sessionHooks.retryWithContext(s.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not in failed state");
  });
});
