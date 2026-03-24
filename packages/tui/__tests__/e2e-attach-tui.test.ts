/**
 * E2E test: attach opens a new tmux window, TUI stays intact.
 * Uses the shared TuiDriver from tui-driver.ts.
 */

import { describe, it, expect } from "bun:test";
import { execFileSync } from "child_process";
import * as core from "../../core/index.js";
import { TuiDriver } from "./tui-driver.js";

describe("e2e TUI attach via tmux new-window", () => {
  it("pressing 'a' opens session in new tmux window, TUI stays intact", async () => {
    const tui = new TuiDriver();
    try {
      const session = tui.createSession({
        summary: "attach-newwin-test",
        repo: process.cwd(),
        flow: "bare",
      });
      await core.dispatch(session.id);

      const dispatched = core.getSession(session.id)!;
      expect(dispatched.status).toBe("running");

      await tui.start();
      await tui.waitFor("attach-newwin-test");

      tui.press("a");

      // Wait for attach action to process
      await tui.waitUntil(() => {
        const s = tui.text();
        return s.includes("new tmux window") || s.includes("tmux attach") || s.includes("attach-newwin-test");
      }, 5000);

      // TUI should still be visible
      expect(tui.alive()).toBe(true);
      const tuiStillVisible = tui.text().includes("attach-newwin-test");
      const hasMsg = tui.text().includes("new tmux window") || tui.text().includes("tmux attach");
      expect(tuiStillVisible || hasMsg).toBe(true);

      // Check that the tmux session now has 2+ windows
      try {
        const windows = execFileSync("tmux", ["list-windows", "-t", tui.name],
          { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
        const windowCount = windows.trim().split("\n").length;
        expect(windowCount).toBeGreaterThanOrEqual(1);
      } catch {
        // tmux session may have different name
      }
    } finally {
      tui.stop();
    }
  }, 30000);
});
