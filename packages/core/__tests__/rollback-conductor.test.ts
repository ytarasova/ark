import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestContext, setContext, type TestContext } from "../context.js";
import { watchMergedPR, type RollbackConfig, type CheckSuiteResult } from "../rollback.js";
import { createSession } from "../store.js";

let ctx: TestContext;
beforeEach(() => { ctx = createTestContext(); setContext(ctx); });
afterEach(() => { ctx.cleanup(); });

const config: RollbackConfig = {
  enabled: true, timeout: 2, on_timeout: "ignore", auto_merge: false, health_url: null,
};

describe("watchMergedPR integration", () => {
  it("returns none when all checks pass", async () => {
    const session = createSession({ summary: "test" });
    let callCount = 0;
    const fetcher = async () => {
      callCount++;
      return { check_suites: [{ id: 1, conclusion: "success", status: "completed" }] };
    };
    const onRevert = async () => { throw new Error("should not be called"); };
    const result = await watchMergedPR({
      sessionId: session.id, sha: "abc", owner: "org", repo: "r", prNumber: 1,
      prTitle: "test", branch: "feat/x", config, fetcher, onRevert,
    });
    expect(result.action).toBe("none");
    expect(callCount).toBe(1);
  });

  it("triggers rollback on CI failure", async () => {
    const session = createSession({ summary: "test" });
    let reverted = false;
    const fetcher = async () => ({
      check_suites: [{ id: 1, conclusion: "failure", status: "completed" }] as CheckSuiteResult[],
    });
    const onRevert = async () => { reverted = true; };
    const result = await watchMergedPR({
      sessionId: session.id, sha: "abc", owner: "org", repo: "r", prNumber: 1,
      prTitle: "test PR", branch: "feat/x", config, fetcher, onRevert,
    });
    expect(result.action).toBe("rollback");
    expect(reverted).toBe(true);
  });

  it("on_timeout=ignore returns none after timeout", async () => {
    const session = createSession({ summary: "test" });
    const fetcher = async () => ({
      check_suites: [{ id: 1, conclusion: null, status: "in_progress" }] as CheckSuiteResult[],
    });
    const shortConfig = { ...config, timeout: 0 };
    const result = await watchMergedPR({
      sessionId: session.id, sha: "abc", owner: "org", repo: "r", prNumber: 1,
      prTitle: "test", branch: "feat/x", config: shortConfig, fetcher,
      onRevert: async () => {},
    });
    expect(result.action).toBe("none");
  });
});
