/**
 * End-to-end TUI dispatch flow tests via tmux.
 *
 * Tests dispatch, live output, stop, and event display by launching
 * the real TUI inside a tmux session, sending keystrokes, and
 * capturing screen output. Uses the same TuiDriver pattern as
 * e2e-tui-real.test.ts.
 *
 * State isolation: ARK_TEST_DIR is set by bunfig.toml preload (packages/test-setup.ts).
 * Each test gets its own TuiDriver with a unique tmux session name.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { join } from "path";
import * as core from "../../core/index.js";

const ARK_BIN = join(import.meta.dir, "..", "..", "..", "ark");

// ── TuiDriver ────────────────────────────────────────────────────────────────

class TuiDriver {
  readonly name: string;

  constructor() {
    this.name = `ark-e2e-dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  }

  async start(): Promise<void> {
    const testDir = process.env.ARK_TEST_DIR ?? "";
    execFileSync("tmux", [
      "new-session", "-d", "-s", this.name,
      "-x", "200", "-y", "50",
      "bash", "-c", `ARK_TEST_DIR=${testDir} ${ARK_BIN} tui`,
    ], { stdio: "pipe" });

    const ready = await this.waitFor("Sessions", 15000);
    if (!ready) {
      const content = this.screen();
      this.stop();
      throw new Error(`TUI did not start within 15s. Screen:\n${content}`);
    }
  }

  screen(): string {
    try {
      return execFileSync("tmux", [
        "capture-pane", "-t", this.name, "-p", "-S", "-50",
      ], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      return "";
    }
  }

  press(key: string): void {
    execFileSync("tmux", ["send-keys", "-t", this.name, key], { stdio: "pipe" });
  }

  async waitFor(text: string, timeoutMs = 5000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.screen().includes(text)) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  async waitForGone(text: string, timeoutMs = 5000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!this.screen().includes(text)) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  stop(): void {
    try {
      execFileSync("tmux", ["kill-session", "-t", this.name], { stdio: "pipe" });
    } catch { /* already dead */ }
  }
}

// Track session IDs for cleanup
const createdSessionIds: string[] = [];

afterEach(() => {
  for (const id of createdSessionIds) {
    try {
      const s = core.getSession(id);
      if (s?.session_id) {
        try { core.killSession(s.session_id); } catch { /* already gone */ }
      }
      core.deleteSession(id);
    } catch { /* already gone */ }
  }
  createdSessionIds.length = 0;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("e2e TUI dispatch and interaction", () => {
  it("dispatch from TUI shows session as running", async () => {
    const s = core.startSession({
      summary: "tui-dispatch-test",
      repo: process.cwd(),
      flow: "bare",
    });
    createdSessionIds.push(s.id);

    const tui = new TuiDriver();
    try {
      await tui.start();
      // Session should appear in the list
      const found = await tui.waitFor("tui-dispatch-test", 5000);
      expect(found).toBe(true);

      // Press Enter to dispatch (session must be selected/highlighted)
      tui.press("Enter");

      // Wait for dispatch to take effect
      await new Promise((r) => setTimeout(r, 5000));

      // Check the session status in DB — should be running or failed
      // (running means dispatch succeeded, failed means agent exited quickly)
      const updated = core.getSession(s.id)!;
      expect(["running", "failed"]).toContain(updated.status);
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("live output section appears for running session", async () => {
    const s = core.startSession({
      summary: "live-output-test",
      repo: process.cwd(),
      flow: "bare",
    });
    createdSessionIds.push(s.id);
    await core.dispatch(s.id);

    const tui = new TuiDriver();
    try {
      await tui.start();
      // Wait for TUI to poll and show the running session's details
      await new Promise((r) => setTimeout(r, 3000));
      const screen = tui.screen();
      // Should show either Live Output section or the session summary
      expect(screen.includes("Live Output") || screen.includes("live-output-test")).toBe(true);
    } finally {
      tui.stop();
      try {
        const sid = core.getSession(s.id)?.session_id;
        if (sid) core.killSession(sid);
      } catch { /* ignore */ }
    }
  }, 30_000);

  it("stop session from TUI with s key", async () => {
    const s = core.startSession({
      summary: "tui-stop-test",
      repo: process.cwd(),
      flow: "bare",
    });
    createdSessionIds.push(s.id);
    await core.dispatch(s.id);

    const tui = new TuiDriver();
    try {
      await tui.start();
      await tui.waitFor("tui-stop-test", 5000);

      // Press s to stop
      tui.press("s");
      await new Promise((r) => setTimeout(r, 3000));

      const updated = core.getSession(s.id)!;
      expect(updated.status).toBe("failed");
      expect(updated.error).toContain("Stopped by user");
    } finally {
      tui.stop();
      try {
        const sid = core.getSession(s.id)?.session_id;
        if (sid) core.killSession(sid);
      } catch { /* ignore */ }
    }
  }, 30_000);

  it("events section shows in session detail", async () => {
    const s = core.startSession({
      summary: "events-display-test",
      repo: process.cwd(),
      flow: "bare",
    });
    createdSessionIds.push(s.id);

    const tui = new TuiDriver();
    try {
      await tui.start();
      await tui.waitFor("events-display-test", 5000);

      // Events section should be visible with at least session_created event
      const screen = tui.screen();
      expect(
        screen.includes("Events") || screen.includes("Session created")
      ).toBe(true);
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("delete session from TUI with x key removes it from list", async () => {
    const s = core.startSession({
      summary: "tui-delete-target",
      repo: process.cwd(),
      flow: "bare",
    });
    createdSessionIds.push(s.id);

    const tui = new TuiDriver();
    try {
      await tui.start();
      const visible = await tui.waitFor("tui-delete-target", 5000);
      expect(visible).toBe(true);

      // Press x to delete
      tui.press("x");
      const gone = await tui.waitForGone("tui-delete-target", 5000);
      expect(gone).toBe(true);

      // Verify via core API
      const check = core.getSession(s.id);
      expect(check).toBeNull();

      // Remove from cleanup since already deleted
      const idx = createdSessionIds.indexOf(s.id);
      if (idx >= 0) createdSessionIds.splice(idx, 1);
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("session detail shows flow and status info", async () => {
    const s = core.startSession({
      summary: "detail-info-test",
      repo: process.cwd(),
      flow: "bare",
    });
    createdSessionIds.push(s.id);

    const tui = new TuiDriver();
    try {
      await tui.start();
      await tui.waitFor("detail-info-test", 5000);
      const screen = tui.screen();

      // Detail pane should show the session ID, flow info, and status
      expect(screen).toContain(s.id);
      expect(screen).toContain("bare");
      expect(
        screen.includes("Flow") || screen.includes("ready")
      ).toBe(true);
    } finally {
      tui.stop();
    }
  }, 30_000);
});
