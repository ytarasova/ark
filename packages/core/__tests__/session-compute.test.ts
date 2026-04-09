import { describe, it, expect } from "bun:test";
import { dispatch } from "../services/session-orchestration.js";
import { getApp } from "../app.js";
import { withTestContext } from "./test-helpers.js";

withTestContext();

describe("session compute dispatch", () => {
  it("dispatch is an async function that returns a Promise", () => {
    // dispatch should be a function
    expect(typeof dispatch).toBe("function");

    // Calling dispatch with a nonexistent session should return a Promise
    const result = dispatch(getApp(), "nonexistent-id");
    expect(result).toBeInstanceOf(Promise);
  });

  it("dispatch resolves with ok: false for nonexistent session", async () => {
    const result = await dispatch(getApp(), "nonexistent-id");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("dispatch resolves with ok: false when session has no stage", async () => {
    // Create a session with no flow stage set up
    const session = getApp().sessions.create({ summary: "test-no-stage" });
    // Session starts with status 'pending' and no stage
    const result = await dispatch(getApp(), session.id);
    expect(result.ok).toBe(false);
  });
});
