import { describe, it, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

withTestContext();

describe("tmux-notify", () => {
  it("exports updateTmuxStatusBar and clearTmuxStatusBar", async () => {
    const mod = await import("../infra/tmux-notify.js");
    expect(typeof mod.updateTmuxStatusBar).toBe("function");
    expect(typeof mod.clearTmuxStatusBar).toBe("function");
  });

  it("updateTmuxStatusBar does not throw when tmux is unavailable", async () => {
    const { updateTmuxStatusBar } = await import("../infra/tmux-notify.js");
    // Should silently catch the error from missing tmux
    expect(() => updateTmuxStatusBar()).not.toThrow();
  });

  it("clearTmuxStatusBar does not throw when tmux is unavailable", async () => {
    const { clearTmuxStatusBar } = await import("../infra/tmux-notify.js");
    expect(() => clearTmuxStatusBar()).not.toThrow();
  });

  it("updateTmuxStatusBar handles waiting sessions without crashing", async () => {
    const { updateTmuxStatusBar } = await import("../infra/tmux-notify.js");
    // Create some sessions in various states to exercise the filter logic
    const s1 = getApp().sessions.create({ summary: "waiting-session" });
    getApp().sessions.update(s1.id, { status: "waiting" });
    const s2 = getApp().sessions.create({ summary: "blocked-session" });
    getApp().sessions.update(s2.id, { status: "blocked" });
    const s3 = getApp().sessions.create({ summary: "running-session" });
    getApp().sessions.update(s3.id, { status: "running" });

    // Even with waiting sessions, should not throw (tmux just won't be available)
    expect(() => updateTmuxStatusBar()).not.toThrow();
  });

  it("updateTmuxStatusBar handles empty session list", async () => {
    const { updateTmuxStatusBar } = await import("../infra/tmux-notify.js");
    // Fresh context has no sessions
    expect(() => updateTmuxStatusBar()).not.toThrow();
  });
});
