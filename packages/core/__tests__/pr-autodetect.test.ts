import { describe, it, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

withTestContext();

describe("PR URL on sessions", () => {
  it("pr_url can be stored and retrieved", async () => {
    const session = await getApp().sessions.create({ summary: "pr-test" });
    await getApp().sessions.update(session.id, { pr_url: "https://github.com/owner/repo/pull/1" });
    const updated = await getApp().sessions.get(session.id);
    expect(updated?.pr_url).toBe("https://github.com/owner/repo/pull/1");
  });

  it("pr_url is null by default", async () => {
    const session = await getApp().sessions.create({ summary: "no-pr" });
    expect((await getApp().sessions.get(session.id))?.pr_url).toBeFalsy();
  });

  it("pr_url persists across reads", async () => {
    const session = await getApp().sessions.create({ summary: "persist" });
    await getApp().sessions.update(session.id, { pr_url: "https://github.com/a/b/pull/99" });
    // Read twice
    expect((await getApp().sessions.get(session.id))?.pr_url).toBe("https://github.com/a/b/pull/99");
    expect((await getApp().sessions.get(session.id))?.pr_url).toBe("https://github.com/a/b/pull/99");
  });
});
