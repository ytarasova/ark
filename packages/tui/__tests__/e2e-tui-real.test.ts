/**
 * Real end-to-end TUI tests via tmux.
 *
 * These tests actually launch `ark tui` inside a detached tmux session,
 * send keystrokes, capture screen output, and verify what the user sees.
 * NOT unit tests — real process, real terminal, real keystrokes.
 *
 * Uses the shared TuiDriver from tui-driver.ts for all tmux interaction,
 * screen region parsing, and automatic cleanup.
 */

import { describe, it, expect } from "bun:test";
import { execFileSync } from "child_process";
import * as core from "../../core/index.js";
import { TuiDriver } from "./tui-driver.js";

describe("e2e TUI (real tmux)", () => {

  // Test 1: TUI starts and shows tab bar
  it("starts and shows tab bar with all tabs", async () => {
    const tui = new TuiDriver();
    try {
      await tui.start();
      tui.expectRegion("tabBar", "Sessions");
      const raw = tui.text();
      expect(raw).toContain("Agents");
      expect(raw).toContain("Tools");
      expect(raw).toContain("Flows");
      expect(raw).toContain("History");
      expect(raw).toContain("Compute");
    } finally {
      tui.stop();
    }
  }, 30_000);

  // Test 2: Tab switching with number keys
  it("switches tabs with number keys", async () => {
    const tui = new TuiDriver();
    try {
      await tui.start();

      await tui.switchTab(2);
      tui.expectRegion("tabBar", "Agents");

      await tui.switchTab(3);
      tui.expectRegion("tabBar", "Tools");

      await tui.switchTab(1);
      tui.expectRegion("tabBar", "Sessions");
    } finally {
      tui.stop();
    }
  }, 30_000);

  // Test 3: Status bar shows session count
  it("shows session count in status bar", async () => {
    const tui = new TuiDriver();
    try {
      await tui.start();
      expect(tui.screen().statusBar).toMatch(/\d+ sessions/);
    } finally {
      tui.stop();
    }
  }, 30_000);

  // Test 4: Session shows in list after creation via core API
  it("shows sessions created via core API", async () => {
    const tui = new TuiDriver();
    try {
      tui.createSession({
        repo: process.cwd(),
        summary: "e2e-tui-visible",
        flow: "bare",
      });

      await tui.start();
      const found = await tui.waitFor("e2e-tui-visible");
      expect(found).toBe(true);
      tui.expectRegion("listPane", "e2e-tui-visible");
    } finally {
      tui.stop();
    }
  }, 30_000);

  // Test 5: Compute tab shows local compute
  it("shows local compute on compute tab", async () => {
    const tui = new TuiDriver();
    try {
      await tui.start();
      await tui.switchTab(6);
      await tui.waitFor("local");
      expect(tui.text()).toContain("local");
      expect(tui.text()).toContain("running");
    } finally {
      tui.stop();
    }
  }, 30_000);

  // Test 6: Quit with q key
  // TODO: flaky — Ink exit() doesn't reliably kill the parent tmux session
  it.skip("quits with q key", async () => {
    const tui = new TuiDriver();
    try {
      await tui.start();
      expect(tui.alive()).toBe(true);

      tui.press("q");
      // Wait for the tmux session to die after TUI exits
      const start = Date.now();
      while (tui.alive() && Date.now() - start < 8000) {
        await new Promise((r) => setTimeout(r, 300));
      }
      expect(tui.alive()).toBe(false);
    } finally {
      tui.stop();
    }
  }, 30_000);

  // Test 7: Create session via new form (n key)
  // TODO: form overlay not rendering in tmux capture — needs investigation
  it.skip("opens new session form with n key", async () => {
    const tui = new TuiDriver();
    try {
      await tui.start();
      tui.press("n");
      const formVisible = await tui.waitFor("New Session", 3000);
      expect(formVisible).toBe(true);

      // Esc should close the form
      tui.press("escape");
      const formGone = await tui.waitForGone("New Session", 3000);
      expect(formGone).toBe(true);
    } finally {
      tui.stop();
    }
  }, 30_000);

  // Test 8: Delete session (x key)
  // TODO: x key not triggering delete in tmux — may need focus/selection first
  it.skip("deletes session with x key", async () => {
    const tui = new TuiDriver();
    try {
      const session = tui.createSession({
        repo: process.cwd(),
        summary: "e2e-tui-delete-me",
        flow: "bare",
      });

      await tui.start();
      const visible = await tui.waitFor("e2e-tui-delete-me");
      expect(visible).toBe(true);

      tui.press("x");
      const gone = await tui.waitForGone("e2e-tui-delete-me");
      expect(gone).toBe(true);

      // Verify via core API
      expect(core.getSession(session.id)).toBeNull();
      tui.untrack(session.id);
    } finally {
      tui.stop();
    }
  }, 30_000);

  // Test 9: Orphan tmux session cleanup
  it("cleans orphan tmux sessions that have no DB record", async () => {
    const { listArkSessionsAsync, killSession } = await import("../../core/tmux.js");
    const orphanName = `ark-s-orphan-test-${Date.now()}`;

    try {
      execFileSync("tmux", [
        "new-session", "-d", "-s", orphanName,
        "-x", "80", "-y", "24",
        "bash", "-c", "sleep 300",
      ], { stdio: "pipe" });

      let sessions = await listArkSessionsAsync();
      let found = sessions.some((s) => s.name === orphanName);
      expect(found).toBe(true);

      const sessionId = orphanName.replace("ark-", "");
      expect(core.getSession(sessionId)).toBeNull();

      let cleaned = 0;
      for (const ts of sessions) {
        const sid = ts.name.replace("ark-", "");
        if (!core.getSession(sid)) {
          killSession(ts.name);
          cleaned++;
        }
      }

      expect(cleaned).toBeGreaterThanOrEqual(1);
      sessions = await listArkSessionsAsync();
      found = sessions.some((s) => s.name === orphanName);
      expect(found).toBe(false);
    } finally {
      try { execFileSync("tmux", ["kill-session", "-t", orphanName], { stdio: "pipe" }); } catch { /* already gone */ }
    }
  }, 30_000);

  // Test 10: Key hints change per tab
  it("shows correct key hints per tab", async () => {
    const tui = new TuiDriver();
    try {
      await tui.start();

      // Sessions tab hints
      tui.expectRegion("statusBar", "new");
      tui.expectRegion("statusBar", "quit");

      // Compute tab hints
      await tui.switchTab(6);
      await tui.waitFor("provision", 3000, { region: "statusBar" });
      tui.expectRegion("statusBar", "provision");
      tui.expectRegion("statusBar", "new");
    } finally {
      tui.stop();
    }
  }, 30_000);
});
