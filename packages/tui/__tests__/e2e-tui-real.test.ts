/**
 * Real end-to-end TUI tests via tmux.
 *
 * These tests actually launch `ark tui` inside a detached tmux session,
 * send keystrokes, capture screen output, and verify what the user sees.
 * NOT unit tests — real process, real terminal, real keystrokes.
 *
 * State isolation: ARK_TEST_DIR is set by bunfig.toml preload (packages/test-setup.ts).
 * Each test gets its own TuiDriver with a unique tmux session name.
 * Cleanup is done in finally blocks so tmux sessions don't leak.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { join } from "path";
import * as core from "../../core/index.js";

const ARK_BIN = join(import.meta.dir, "..", "..", "..", "ark");

// Track session IDs created via the core API for cleanup
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

// ── TuiDriver ────────────────────────────────────────────────────────────────

class TuiDriver {
  readonly name: string;

  constructor() {
    this.name = `ark-e2e-tui-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  }

  /** Launch the TUI in a detached tmux session */
  async start(): Promise<void> {
    const testDir = process.env.ARK_TEST_DIR ?? "";
    execFileSync("tmux", [
      "new-session", "-d", "-s", this.name,
      "-x", "200", "-y", "50",
      "bash", "-c", `ARK_TEST_DIR=${testDir} ${ARK_BIN} tui`,
    ], { stdio: "pipe" });

    // Wait for TUI to render — poll until we see tab bar content
    const ready = await this.waitFor("Sessions", 15000);
    if (!ready) {
      const content = this.screen();
      this.stop();
      throw new Error(`TUI did not start within 15s. Screen:\n${content}`);
    }
  }

  /** Capture current screen content */
  screen(): string {
    try {
      return execFileSync("tmux", [
        "capture-pane", "-t", this.name, "-p", "-S", "-50",
      ], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      return "";
    }
  }

  /** Send a key to the TUI */
  press(key: string): void {
    execFileSync("tmux", ["send-keys", "-t", this.name, key], { stdio: "pipe" });
  }

  /** Send text followed by Enter */
  type(text: string): void {
    execFileSync("tmux", ["send-keys", "-t", this.name, text, "Enter"], { stdio: "pipe" });
  }

  /** Wait until screen contains text, with timeout */
  async waitFor(text: string, timeoutMs = 5000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.screen().includes(text)) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  /** Wait until screen does NOT contain text */
  async waitForGone(text: string, timeoutMs = 5000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (!this.screen().includes(text)) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  /** Check if the tmux session is still alive */
  alive(): boolean {
    try {
      execFileSync("tmux", ["has-session", "-t", this.name], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  /** Kill the TUI tmux session */
  stop(): void {
    try {
      execFileSync("tmux", ["kill-session", "-t", this.name], { stdio: "pipe" });
    } catch { /* already dead */ }
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("e2e TUI (real tmux)", () => {

  // Test 1: TUI starts and shows tab bar
  it("starts and shows tab bar with all tabs", async () => {
    const tui = new TuiDriver();
    try {
      await tui.start();
      const screen = tui.screen();
      expect(screen).toContain("Sessions");
      expect(screen).toContain("Compute");
      expect(screen).toContain("Agents");
      expect(screen).toContain("Flows");
      expect(screen).toContain("Recipes");
    } finally {
      tui.stop();
    }
  }, 30_000);

  // Test 2: Tab switching with number keys
  it("switches tabs with number keys", async () => {
    const tui = new TuiDriver();
    try {
      await tui.start();

      // Switch to Compute tab (key 2)
      tui.press("2");
      await tui.waitFor("Compute", 5000);
      expect(tui.screen()).toContain("Compute");

      // Switch to Agents tab (key 3)
      tui.press("3");
      await tui.waitFor("Agents", 5000);
      expect(tui.screen()).toContain("Agents");

      // Switch back to Sessions tab (key 1)
      tui.press("1");
      await tui.waitFor("Sessions", 5000);
      expect(tui.screen()).toContain("Sessions");
    } finally {
      tui.stop();
    }
  }, 30_000);

  // Test 3: Status bar shows session count
  it("shows session count in status bar", async () => {
    const tui = new TuiDriver();
    try {
      await tui.start();
      const screen = tui.screen();
      // StatusBar renders " N sessions"
      expect(screen).toMatch(/\d+ sessions/);
    } finally {
      tui.stop();
    }
  }, 30_000);

  // Test 4: Session shows in list after creation via core API
  it("shows sessions created via core API", async () => {
    // Create a session before launching TUI
    const session = core.startSession({
      repo: process.cwd(),
      summary: "e2e-tui-visible",
      flow: "bare",
    });
    createdSessionIds.push(session.id);

    const tui = new TuiDriver();
    try {
      await tui.start();
      // The session summary should appear in the sessions list
      const found = await tui.waitFor("e2e-tui-visible", 5000);
      expect(found).toBe(true);
      expect(tui.screen()).toContain("e2e-tui-visible");
    } finally {
      tui.stop();
    }
  }, 30_000);

  // Test 5: Compute tab shows local compute
  it("shows local compute on compute tab", async () => {
    const tui = new TuiDriver();
    try {
      await tui.start();
      tui.press("2"); // switch to compute tab
      await tui.waitFor("local", 5000);
      const screen = tui.screen();
      expect(screen).toContain("local");
      expect(screen).toContain("running");
    } finally {
      tui.stop();
    }
  }, 30_000);

  // Test 6: Quit with q key
  it("quits with q key", async () => {
    const tui = new TuiDriver();
    try {
      await tui.start();
      expect(tui.alive()).toBe(true);

      tui.press("q");
      // Wait for the tmux session to die
      await new Promise((r) => setTimeout(r, 2000));
      expect(tui.alive()).toBe(false);
    } finally {
      tui.stop(); // no-op if already dead
    }
  }, 30_000);

  // Test 7: Create session via new form (n key)
  it("opens new session form with n key", async () => {
    const tui = new TuiDriver();
    try {
      await tui.start();
      tui.press("n"); // open the form
      const formVisible = await tui.waitFor("New Session", 3000);
      expect(formVisible).toBe(true);
      expect(tui.screen()).toContain("Session name:");

      // Esc should close the form
      tui.press("Escape");
      const formGone = await tui.waitForGone("New Session", 3000);
      expect(formGone).toBe(true);
    } finally {
      tui.stop();
    }
  }, 30_000);

  // Test 8: Delete session (x key)
  it("deletes session with x key", async () => {
    // Create a session
    const session = core.startSession({
      repo: process.cwd(),
      summary: "e2e-tui-delete-me",
      flow: "bare",
    });
    createdSessionIds.push(session.id);

    const tui = new TuiDriver();
    try {
      await tui.start();
      // Verify session is visible
      const visible = await tui.waitFor("e2e-tui-delete-me", 5000);
      expect(visible).toBe(true);

      // Press x to delete
      tui.press("x");
      // Wait for session to disappear (useStore refreshes periodically)
      const gone = await tui.waitForGone("e2e-tui-delete-me", 5000);
      expect(gone).toBe(true);

      // Verify via core API that it's actually deleted
      const check = core.getSession(session.id);
      expect(check).toBeNull();

      // Remove from cleanup since already deleted
      const idx = createdSessionIds.indexOf(session.id);
      if (idx >= 0) createdSessionIds.splice(idx, 1);
    } finally {
      tui.stop();
    }
  }, 30_000);

  // Test 9: Orphan tmux session cleanup
  it("cleans orphan tmux sessions that have no DB record", async () => {
    const { listArkSessions, killSession } = await import("../../core/tmux.js");
    const orphanName = `ark-s-orphan-test-${Date.now()}`;

    try {
      // 1. Create an orphan tmux session (no DB record)
      execFileSync("tmux", [
        "new-session", "-d", "-s", orphanName,
        "-x", "80", "-y", "24",
        "bash", "-c", "sleep 300",
      ], { stdio: "pipe" });

      // Verify it exists
      let found = listArkSessions().some((s) => s.name === orphanName);
      expect(found).toBe(true);

      // 2. Confirm it has no DB record
      const sessionId = orphanName.replace("ark-", "");
      const dbSession = core.getSession(sessionId);
      expect(dbSession).toBeNull();

      // 3. Run the cleanup logic (same as ComputeTab 'c' key handler)
      const tmuxSessions = listArkSessions();
      let cleaned = 0;
      for (const ts of tmuxSessions) {
        const sid = ts.name.replace("ark-", "");
        const db = core.getSession(sid);
        if (!db) {
          killSession(ts.name);
          cleaned++;
        }
      }

      // 4. Verify the orphan session was killed
      expect(cleaned).toBeGreaterThanOrEqual(1);
      found = listArkSessions().some((s) => s.name === orphanName);
      expect(found).toBe(false);
    } finally {
      // Safety cleanup in case test failed before cleanup logic ran
      try { execFileSync("tmux", ["kill-session", "-t", orphanName], { stdio: "pipe" }); } catch { /* already gone */ }
    }
  }, 30_000);

  // Test 10: Key hints change per tab
  it("shows correct key hints per tab", async () => {
    const tui = new TuiDriver();
    try {
      await tui.start();

      // Sessions tab hints (no session selected = new/quit)
      const sessionsScreen = tui.screen();
      expect(sessionsScreen).toContain("new");
      expect(sessionsScreen).toContain("quit");

      // Compute tab hints
      tui.press("2");
      await tui.waitFor("provision", 3000);
      const computeScreen = tui.screen();
      expect(computeScreen).toContain("provision");
      expect(computeScreen).toContain("new");
    } finally {
      tui.stop();
    }
  }, 30_000);
});
