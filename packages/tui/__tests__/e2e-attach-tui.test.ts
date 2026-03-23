/**
 * E2E test: full attach/detach cycle via TUI.
 *
 * Launches the TUI in tmux, creates a session, dispatches it,
 * presses 'a' to attach, detaches, and verifies TUI resumes with state.
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

describe("e2e TUI attach/detach cycle", () => {
  it("attach to session, detach, TUI resumes with state", async () => {
    // 1. Create and dispatch a session
    const session = core.startSession({
      summary: "attach-cycle-test",
      repo: process.cwd(),
      pipeline: "bare",
    });
    arkSessions.push(session.id);

    const dispatchResult = await core.dispatch(session.id);
    expect(dispatchResult.ok).toBe(true);

    const dispatched = core.getSession(session.id)!;
    expect(dispatched.status).toBe("running");
    expect(dispatched.session_id).toBeTruthy();

    // Verify tmux session exists
    await Bun.sleep(2000);
    expect(core.sessionExists(dispatched.session_id!)).toBe(true);

    // 2. Launch TUI in tmux
    const tuiName = `ark-e2e-attach-${Date.now()}`;
    tuiSessions.push(tuiName);

    const testDir = process.env.ARK_TEST_DIR ?? "";
    execFileSync("tmux", [
      "new-session", "-d", "-s", tuiName, "-x", "200", "-y", "50",
      "bash", "-c", `export ARK_TEST_DIR='${testDir}' && ${ARK_BIN} tui`,
    ], { stdio: "pipe" });

    // Wait for TUI to render
    const tuiReady = await waitFor(tuiName, "Sessions", 10000);
    expect(tuiReady).toBe(true);

    // 3. Verify session appears in TUI
    const sessionVisible = await waitFor(tuiName, "attach-cycle-test", 5000);
    expect(sessionVisible).toBe(true);

    // Verify it shows as running
    expect(screen(tuiName)).toContain("running");

    // 4. Press 'a' to attach
    press(tuiName, "a");
    await Bun.sleep(3000);

    // Should be in tmux/Claude now (look for Claude indicators)
    const attachedScreen = screen(tuiName);
    const isAttached = attachedScreen.includes("Claude") ||
                       attachedScreen.includes("claude") ||
                       attachedScreen.includes("bash") ||
                       attachedScreen.includes("ark-s-");
    expect(isAttached).toBe(true);

    // 5. Detach: Ctrl+B then d
    press(tuiName, "C-b");
    await Bun.sleep(500);
    press(tuiName, "d");
    await Bun.sleep(3000);

    // 6. TUI should resume — verify it shows the session list again
    const tuiResumed = await waitFor(tuiName, "Sessions", 5000);
    expect(tuiResumed).toBe(true);

    // Verify session is still visible with state preserved
    const resumedScreen = screen(tuiName);
    expect(resumedScreen).toContain("attach-cycle-test");
    expect(resumedScreen).toContain("running");
  }, 60000);
});
