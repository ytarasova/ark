import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestContext, setContext } from "../context.js";
import { createSession, getSession, updateSession } from "../store.js";
import type { TestContext } from "../context.js";

let ctx: TestContext;
beforeEach(() => { ctx = createTestContext(); setContext(ctx); });
afterEach(() => { ctx.cleanup(); });

describe("PR auto-detection", () => {
  it("extracts PR URL from agent report content", () => {
    // This tests the regex pattern
    const content = "Created PR: https://github.com/owner/repo/pull/42 for the changes.";
    const match = content.match(/https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/);
    expect(match).not.toBeNull();
    expect(match![0]).toBe("https://github.com/owner/repo/pull/42");
  });

  it("does not match non-PR GitHub URLs", () => {
    const content = "See https://github.com/owner/repo/issues/10 for details.";
    const match = content.match(/https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/);
    expect(match).toBeNull();
  });

  it("pr_url can be stored on session", () => {
    const session = createSession({ summary: "pr-test" });
    updateSession(session.id, { pr_url: "https://github.com/owner/repo/pull/1" });
    const updated = getSession(session.id);
    expect(updated?.pr_url).toBe("https://github.com/owner/repo/pull/1");
  });
});
