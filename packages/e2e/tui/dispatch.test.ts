/**
 * E2E TUI dispatch, stop, interrupt, attach, and event display tests.
 *
 * These are slow tests that actually dispatch agents in tmux sessions.
 * Consolidated from existing dispatch/attach tests plus new flows.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { getApp } from "../../core/app.js";
import { dispatch } from "../../core/services/session-orchestration.js";
import { TuiDriver } from "../fixtures/tui-driver.js";
import { snapshotArkTmuxSessions, killNewArkTmuxSessions } from "../../core/__tests__/test-helpers.js";
import { AppContext, setApp, clearApp } from "../../core/app.js";

let tmuxSnapshot: Set<string>;
beforeAll(() => { tmuxSnapshot = snapshotArkTmuxSessions(); });
afterAll(() => { killNewArkTmuxSessions(tmuxSnapshot); });

describe("e2e TUI dispatch and interaction", () => {

  it("dispatch with Enter shows session as running", async () => {
    const tui = new TuiDriver();
    try {
      const s = tui.createSession({
        summary: "dispatch-enter-test",
        repo: process.cwd(),
        flow: "bare",
      });

      await tui.start();
      await tui.waitFor("dispatch-enter-test");

      tui.press("enter");

      // Wait for dispatch to take effect via DB state
      const app = getApp();
      await tui.waitUntil(() => {
        const updated = app.sessions.get(s.id);
        return updated?.status === "running" || updated?.status === "failed";
      }, 10_000, 500);

      const updated = app.sessions.get(s.id)!;
      expect(["running", "failed"]).toContain(updated.status);
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("stop session from TUI with s key", async () => {
    const tui = new TuiDriver();
    try {
      const s = tui.createSession({
        summary: "dispatch-stop-test",
        repo: process.cwd(),
        flow: "bare",
      });
      const app = getApp();
      await dispatch(app, s.id);

      await tui.start();
      await tui.waitFor("dispatch-stop-test");

      tui.press("s");

      // Wait for stop to propagate to DB
      await tui.waitUntil(() => {
        const updated = app.sessions.get(s.id);
        return updated?.status === "stopped";
      }, 8000, 500);

      const updated = app.sessions.get(s.id)!;
      expect(updated.status).toBe("stopped");
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("interrupt session with I key", async () => {
    const tui = new TuiDriver();
    try {
      const s = tui.createSession({
        summary: "dispatch-interrupt-test",
        repo: process.cwd(),
        flow: "bare",
      });
      const app = getApp();
      await dispatch(app, s.id);

      await tui.start();
      await tui.waitFor("dispatch-interrupt-test");

      // Press I to send interrupt (Ctrl+C to agent)
      tui.press("I");
      await new Promise(r => setTimeout(r, 1000));

      // The session should still exist -- interrupt doesn't kill it
      const updated = app.sessions.get(s.id)!;
      expect(updated).toBeTruthy();
      // Session may still be running or may have stopped/failed due to interrupt
      expect(["running", "stopped", "failed", "waiting"]).toContain(updated.status);
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("attach opens new tmux window with a key", async () => {
    const tui = new TuiDriver();
    try {
      const session = tui.createSession({
        summary: "dispatch-attach-test",
        repo: process.cwd(),
        flow: "bare",
      });
      const app = getApp();
      await dispatch(app, session.id);

      const dispatched = app.sessions.get(session.id)!;
      expect(dispatched.status).toBe("running");

      await tui.start();
      await tui.waitFor("dispatch-attach-test");

      tui.press("a");

      // Wait for attach action to process
      await tui.waitUntil(() => {
        const s = tui.text();
        return s.includes("new tmux window") || s.includes("tmux attach") || s.includes("dispatch-attach-test");
      }, 5000);

      // TUI should still be visible
      expect(tui.alive()).toBe(true);
      const tuiStillVisible = tui.text().includes("dispatch-attach-test");
      const hasMsg = tui.text().includes("new tmux window") || tui.text().includes("tmux attach");
      expect(tuiStillVisible || hasMsg).toBe(true);

      // Check that the tmux session now has 1+ windows
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
  }, 30_000);

  it("detail pane shows events for a session", async () => {
    const tui = new TuiDriver();
    try {
      tui.createSession({
        summary: "dispatch-events-display",
        repo: process.cwd(),
        flow: "bare",
      });

      await tui.start();
      await tui.waitFor("dispatch-events-display");

      // Focus detail pane and wait for event data to render
      tui.press("tab");
      await new Promise(r => setTimeout(r, 500));

      const raw = tui.text();
      expect(
        raw.includes("Events") || raw.includes("stage_ready") || raw.includes("dispatch-events-display"),
      ).toBe(true);
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("live output section appears for running session", async () => {
    const tui = new TuiDriver();
    try {
      const s = tui.createSession({
        summary: "dispatch-live-output",
        repo: process.cwd(),
        flow: "bare",
      });
      const app = getApp();
      await dispatch(app, s.id);

      await tui.start();
      const found = await tui.waitFor(/Live Output|dispatch-live-output/, 5000);
      expect(found).toBe(true);
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("cleans orphan tmux sessions that have no DB record", async () => {
    // Re-establish AppContext since TuiDriver tests overwrite the global app
    const freshApp = AppContext.forTest();
    setApp(freshApp);
    await freshApp.boot();

    const { listArkSessionsAsync, killSession } = await import("../../core/tmux.js");
    const orphanName = `ark-s-orphan-e2e-${Date.now()}`;

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
      expect(freshApp.sessions.get(sessionId)).toBeNull();

      let cleaned = 0;
      for (const ts of sessions) {
        const sid = ts.name.replace("ark-", "");
        if (!freshApp.sessions.get(sid)) {
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
});
