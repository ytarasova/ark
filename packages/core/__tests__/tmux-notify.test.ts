import { describe, it, expect } from "bun:test";
// tmux-notify functions require real tmux, so we just test they're importable
describe("tmux-notify", () => {
  it("exports updateTmuxStatusBar and clearTmuxStatusBar", async () => {
    const mod = await import("../tmux-notify.js");
    expect(typeof mod.updateTmuxStatusBar).toBe("function");
    expect(typeof mod.clearTmuxStatusBar).toBe("function");
  });
});
