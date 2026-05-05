import { describe, it, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

withTestContext();

describe("session compute dispatch", async () => {
  it("dispatch is an async function that returns a Promise", async () => {
    // dispatch should be a function
    expect(typeof getApp().dispatchService.dispatch).toBe("function");

    // Calling dispatch with a nonexistent session should return a Promise
    const resultPromise = getApp().dispatchService.dispatch("nonexistent-id");
    expect(resultPromise).toBeInstanceOf(Promise);
    await resultPromise;
  });

  it("dispatch resolves with ok: false for nonexistent session", async () => {
    const result = await getApp().dispatchService.dispatch("nonexistent-id");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("dispatch resolves with ok: false when session has no stage", async () => {
    // Create a session with no flow stage set up
    const session = await getApp().sessions.create({ summary: "test-no-stage" });
    // Session starts with status 'pending' and no stage
    const result = await getApp().dispatchService.dispatch(session.id);
    expect(result.ok).toBe(false);
  });

  // #472: sessions dispatched without an explicit `compute` arg used to land
  // with NULL compute_name in the DB. The compute panel's predicate then
  // treated NULL as "match every compute" and surfaced one session under
  // every panel. Backfill the default at create time so the row has the
  // compute attribution every downstream view expects.
  it("sessionService.start defaults compute_name to 'local' when not specified", async () => {
    const session = await getApp().sessionService.start({ summary: "no-compute-arg" });
    const stored = await getApp().sessions.get(session.id);
    expect(stored?.compute_name).toBe("local");
  });

  it("sessionService.start respects an explicit compute_name", async () => {
    const session = await getApp().sessionService.start({
      summary: "explicit-compute",
      compute_name: "ec2-ssm",
    });
    const stored = await getApp().sessions.get(session.id);
    expect(stored?.compute_name).toBe("ec2-ssm");
  });
});
