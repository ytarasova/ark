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

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import * as core from "../../core/index.js";
import { TuiDriver } from "./tui-driver.js";
import { AppContext, setApp, clearApp } from "../../core/app.js";
import { snapshotArkTmuxSessions, killNewArkTmuxSessions } from "../../core/__tests__/test-helpers.js";

// Tests that don't use TuiDriver (like the orphan cleanup test) need
// a global AppContext so core.getSession() works. TuiDriver tests
// create their own isolated AppContext internally.
let app: AppContext;
let tmuxSnapshot: Set<string>;
beforeAll(async () => {
  tmuxSnapshot = snapshotArkTmuxSessions();
  app = AppContext.forTest();
  setApp(app);
  await app.boot();
});
afterAll(async () => {
  killNewArkTmuxSessions(tmuxSnapshot);
  await app?.shutdown();
  clearApp();
});

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

  // Test 6: Orphan tmux session cleanup
  it("cleans orphan tmux sessions that have no DB record", async () => {
    // Re-establish AppContext since TuiDriver tests overwrite the global app
    const freshApp = AppContext.forTest();
    setApp(freshApp);
    await freshApp.boot();

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
      await freshApp.shutdown();
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
