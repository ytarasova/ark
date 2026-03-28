import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestContext, setContext } from "../context.js";
import { createSession, getSession, updateSession } from "../store.js";
import type { TestContext } from "../context.js";

let ctx: TestContext;
beforeEach(() => { ctx = createTestContext(); setContext(ctx); });
afterEach(() => { ctx.cleanup(); });

describe("PR URL on sessions", () => {
  it("pr_url can be stored and retrieved", () => {
    const session = createSession({ summary: "pr-test" });
    updateSession(session.id, { pr_url: "https://github.com/owner/repo/pull/1" });
    const updated = getSession(session.id);
    expect(updated?.pr_url).toBe("https://github.com/owner/repo/pull/1");
  });

  it("pr_url is null by default", () => {
    const session = createSession({ summary: "no-pr" });
    expect(getSession(session.id)?.pr_url).toBeFalsy();
  });

  it("pr_url persists across reads", () => {
    const session = createSession({ summary: "persist" });
    updateSession(session.id, { pr_url: "https://github.com/a/b/pull/99" });
    // Read twice
    expect(getSession(session.id)?.pr_url).toBe("https://github.com/a/b/pull/99");
    expect(getSession(session.id)?.pr_url).toBe("https://github.com/a/b/pull/99");
  });
});
