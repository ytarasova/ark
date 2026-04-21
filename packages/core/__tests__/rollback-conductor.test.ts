import { describe, it, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import { watchMergedPR, type RollbackConfig, type CheckSuiteResult } from "../integrations/rollback.js";
import { getApp } from "./test-helpers.js";

withTestContext();

const config: RollbackConfig = {
  enabled: true,
  timeout: 2,
  on_timeout: "ignore",
  auto_merge: false,
  health_url: null,
};

describe("watchMergedPR integration", async () => {
  it("returns none when all checks pass", async () => {
    const session = await getApp().sessions.create({ summary: "test" });
    let callCount = 0;
    const fetcher = async () => {
      callCount++;
      return { check_suites: [{ id: 1, conclusion: "success", status: "completed" }] };
    };
    const onRevert = async () => {
      throw new Error("should not be called");
    };
    const result = await watchMergedPR(getApp(), {
      sessionId: session.id,
      sha: "abc",
      owner: "org",
      repo: "r",
      prNumber: 1,
      prTitle: "test",
      branch: "feat/x",
      config,
      fetcher,
      onRevert,
    });
    expect(result.action).toBe("none");
    expect(callCount).toBe(1);
  });

  it("triggers rollback on CI failure", async () => {
    const session = await getApp().sessions.create({ summary: "test" });
    let reverted = false;
    const fetcher = async () => ({
      check_suites: [{ id: 1, conclusion: "failure", status: "completed" }] as CheckSuiteResult[],
    });
    const onRevert = async () => {
      reverted = true;
    };
    const result = await watchMergedPR(getApp(), {
      sessionId: session.id,
      sha: "abc",
      owner: "org",
      repo: "r",
      prNumber: 1,
      prTitle: "test PR",
      branch: "feat/x",
      config,
      fetcher,
      onRevert,
    });
    expect(result.action).toBe("rollback");
    expect(reverted).toBe(true);
  });

  it("on_timeout=ignore returns none after timeout", async () => {
    const session = await getApp().sessions.create({ summary: "test" });
    const fetcher = async () => ({
      check_suites: [{ id: 1, conclusion: null, status: "in_progress" }] as CheckSuiteResult[],
    });
    const shortConfig = { ...config, timeout: 0 };
    const result = await watchMergedPR(getApp(), {
      sessionId: session.id,
      sha: "abc",
      owner: "org",
      repo: "r",
      prNumber: 1,
      prTitle: "test",
      branch: "feat/x",
      config: shortConfig,
      fetcher,
      onRevert: async () => {},
    });
    expect(result.action).toBe("none");
  });

  it("triggers rollback on timeout when on_timeout=rollback", async () => {
    const session = await getApp().sessions.create({ summary: "test" });
    let reverted = false;
    const fetcher = async () => ({
      check_suites: [{ id: 1, conclusion: null, status: "in_progress" }] as CheckSuiteResult[],
    });
    const timeoutConfig = { ...config, timeout: 0, on_timeout: "rollback" as const };
    const result = await watchMergedPR(getApp(), {
      sessionId: session.id,
      sha: "abc",
      owner: "org",
      repo: "r",
      prNumber: 1,
      prTitle: "test",
      branch: "feat/x",
      config: timeoutConfig,
      fetcher,
      onRevert: async () => {
        reverted = true;
      },
    });
    expect(result.action).toBe("rollback");
    expect(reverted).toBe(true);
  });

  it("triggers rollback when health check fails", async () => {
    const session = await getApp().sessions.create({ summary: "test" });
    let reverted = false;
    const fetcher = async () => ({
      check_suites: [{ id: 1, conclusion: "success", status: "completed" }] as CheckSuiteResult[],
    });
    const healthConfig = { ...config, health_url: "http://localhost:19999/health" };
    const result = await watchMergedPR(getApp(), {
      sessionId: session.id,
      sha: "abc",
      owner: "org",
      repo: "r",
      prNumber: 1,
      prTitle: "test",
      branch: "feat/x",
      config: healthConfig,
      fetcher,
      healthFetcher: async () => false,
      onRevert: async () => {
        reverted = true;
      },
    });
    expect(result.action).toBe("rollback");
    expect(reverted).toBe(true);
  });
});
