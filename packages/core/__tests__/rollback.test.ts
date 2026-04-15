import { describe, it, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import {
  pollCheckSuites,
  shouldRollback,
  createRevertPayload,
  type CheckSuiteResult,
  type RollbackConfig,
} from "../integrations/rollback.js";

withTestContext();

const defaultConfig: RollbackConfig = {
  enabled: true,
  timeout: 10,
  on_timeout: "ignore",
  auto_merge: false,
  health_url: null,
};

describe("rollback — shouldRollback", () => {
  it("returns false when all checks pass", () => {
    const suites: CheckSuiteResult[] = [
      { id: 1, conclusion: "success", status: "completed" },
      { id: 2, conclusion: "success", status: "completed" },
    ];
    expect(shouldRollback(suites, defaultConfig)).toBe(false);
  });

  it("returns true when any check fails", () => {
    const suites: CheckSuiteResult[] = [
      { id: 1, conclusion: "success", status: "completed" },
      { id: 2, conclusion: "failure", status: "completed" },
    ];
    expect(shouldRollback(suites, defaultConfig)).toBe(true);
  });

  it("returns false for in-progress checks", () => {
    const suites: CheckSuiteResult[] = [{ id: 1, conclusion: null, status: "in_progress" }];
    expect(shouldRollback(suites, defaultConfig)).toBe(false);
  });
});

describe("rollback — createRevertPayload", () => {
  it("creates correct revert PR payload", () => {
    const payload = createRevertPayload({
      owner: "org",
      repo: "my-repo",
      originalPrNumber: 42,
      originalPrTitle: "feat: add auth",
      originalBranch: "feat/auth",
      failedChecks: ["CI / build", "CI / lint"],
    });
    expect(payload.title).toBe("Revert: feat: add auth");
    expect(payload.head).toBe("revert-feat/auth");
    expect(payload.body).toContain("#42");
    expect(payload.body).toContain("CI / build");
  });
});

describe("rollback — pollCheckSuites", () => {
  it("calls fetcher and returns results", async () => {
    const mockFetcher = async () => ({
      check_suites: [{ id: 1, conclusion: "success", status: "completed" }],
    });
    const result = await pollCheckSuites("abc123", mockFetcher);
    expect(result.length).toBe(1);
    expect(result[0].conclusion).toBe("success");
  });
});
