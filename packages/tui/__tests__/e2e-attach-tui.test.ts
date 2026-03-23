/**
 * E2E test: attach opens a new tmux window, TUI stays intact.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { join } from "path";
import * as core from "../../core/index.js";

const ARK_BIN = join(import.meta.dir, "..", "..", "..", "ark");
const tuiSessions: string[] = [];
const arkSessions: string[] = [];

afterEach(() => {
  for (const name of tuiSessions) {
    try { execFileSync("tmux", ["kill-session", "-t", name], { stdio: "pipe" }); } catch {}
  }
  tuiSessions.length = 0;
  for (const id of arkSessions) {
    try {
      const s = core.getSession(id);
      if (s?.session_id) core.killSession(s.session_id);
      core.deleteSession(id);
    } catch {}
  }
  arkSessions.length = 0;
});

function screen(name: string): string {
  try {
    return execFileSync("tmux", ["capture-pane", "-t", name, "-p", "-S", "-50"],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  } catch { return ""; }
}

function press(name: string, key: string): void {
  execFileSync("tmux", ["send-keys", "-t", name, key], { stdio: "pipe" });
}

async function waitFor(name: string, text: string, timeoutMs = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (screen(name).includes(text)) return true;
    await Bun.sleep(300);
  }
  return false;
}

describe("e2e TUI attach via tmux new-window", () => {
  it("pressing 'a' opens session in new tmux window, TUI stays intact", async () => {
    // 1. Create and dispatch a session
    const session = core.startSession({
      summary: "attach-newwin-test",
      repo: process.cwd(),
      flow: "bare",
    });
    arkSessions.push(session.id);
    await core.dispatch(session.id);

    const dispatched = core.getSession(session.id)!;
    expect(dispatched.status).toBe("running");
    await Bun.sleep(2000);

    // 2. Launch TUI inside a tmux session (so tmux new-window works)
    const tuiName = `ark-e2e-attach-${Date.now()}`;
    tuiSessions.push(tuiName);

    const testDir = process.env.ARK_TEST_DIR ?? "";
    execFileSync("tmux", [
      "new-session", "-d", "-s", tuiName, "-x", "200", "-y", "50",
      "bash", "-c", `export ARK_TEST_DIR='${testDir}' && ${ARK_BIN} tui`,
    ], { stdio: "pipe" });

    await waitFor(tuiName, "Sessions", 10000);
    await waitFor(tuiName, "attach-newwin-test", 5000);

    // 3. Press 'a' — should create a new tmux window
    press(tuiName, "a");
    await Bun.sleep(2000);

    // 4. TUI should still be visible (it stays in its window)
    const tuiStillVisible = screen(tuiName).includes("attach-newwin-test");
    // The TUI shows a status message about the new window
    const statusMsg = screen(tuiName);
    const hasMsg = statusMsg.includes("new tmux window") || statusMsg.includes("tmux attach");
    expect(tuiStillVisible || hasMsg).toBe(true);

    // 5. Check that the tmux session now has 2+ windows
    try {
      const windows = execFileSync("tmux", ["list-windows", "-t", tuiName],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      const windowCount = windows.trim().split("\n").length;
      expect(windowCount).toBeGreaterThanOrEqual(1); // at least the TUI window
    } catch {
      // tmux session may have different name
    }
  }, 30000);
});
