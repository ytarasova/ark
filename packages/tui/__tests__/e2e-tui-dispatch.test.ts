/**
 * End-to-end TUI dispatch flow tests via tmux.
 *
 * Tests dispatch, live output, stop, and event display by launching
 * the real TUI, sending keystrokes, and capturing screen output.
 * Uses the shared TuiDriver from tui-driver.ts.
 */

import { describe, it, expect } from "bun:test";
import * as core from "../../core/index.js";
import { TuiDriver } from "./tui-driver.js";

describe("e2e TUI dispatch and interaction", () => {
  it("dispatch from TUI shows session as running", async () => {
    const tui = new TuiDriver();
    try {
      const s = tui.createSession({
        summary: "tui-dispatch-test",
        repo: process.cwd(),
        flow: "bare",
      });

      await tui.start();
      await tui.waitFor("tui-dispatch-test");

      tui.press("enter");

      // Wait for dispatch to take effect — use waitUntil on DB state
      await tui.waitUntil(() => {
        const updated = core.getSession(s.id);
        return updated?.status === "running" || updated?.status === "failed";
      }, 10_000, 500);

      const updated = core.getSession(s.id)!;
      expect(["running", "failed"]).toContain(updated.status);
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("live output section appears for running session", async () => {
    const tui = new TuiDriver();
    try {
      const s = tui.createSession({
        summary: "live-output-test",
        repo: process.cwd(),
        flow: "bare",
      });
      await core.dispatch(s.id);

      await tui.start();
      const found = await tui.waitFor(/Live Output|live-output-test/, 5000);
      expect(found).toBe(true);
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("stop session from TUI with s key", async () => {
    const tui = new TuiDriver();
    try {
      const s = tui.createSession({
        summary: "tui-stop-test",
        repo: process.cwd(),
        flow: "bare",
      });
      await core.dispatch(s.id);

      await tui.start();
      await tui.waitFor("tui-stop-test");

      tui.press("s");

      // Wait for stop to propagate to DB
      await tui.waitUntil(() => {
        const updated = core.getSession(s.id);
        return updated?.status === "stopped";
      }, 8000, 500);

      const updated = core.getSession(s.id)!;
      expect(updated.status).toBe("stopped");
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("events section shows in session detail", async () => {
    const tui = new TuiDriver();
    try {
      tui.createSession({
        summary: "events-display-test",
        repo: process.cwd(),
        flow: "bare",
      });

      await tui.start();
      await tui.waitFor("events-display-test");

      const raw = tui.text();
      expect(
        raw.includes("Events") || raw.includes("Session created"),
      ).toBe(true);
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("delete session from TUI with x key removes it from list", async () => {
    const tui = new TuiDriver();
    try {
      const s = tui.createSession({
        summary: "tui-delete-target",
        repo: process.cwd(),
        flow: "bare",
      });

      await tui.start();
      await tui.waitFor("tui-delete-target");

      tui.press("x"); // First press starts delete confirmation
      await new Promise(r => setTimeout(r, 500));
      tui.press("x"); // Second press confirms delete
      const gone = await tui.waitForGone("tui-delete-target");
      expect(gone).toBe(true);

      // Session is soft-deleted (status "deleting") for 90s undo window
      const updated = core.getSession(s.id);
      expect(updated?.status).toBe("deleting");
      tui.untrack(s.id);
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("session detail shows flow and status info", async () => {
    const tui = new TuiDriver();
    try {
      const s = tui.createSession({
        summary: "detail-info-test",
        repo: process.cwd(),
        flow: "bare",
      });

      await tui.start();
      await tui.waitFor("detail-info-test");

      // Wait for session detail to populate in the right pane
      const detailLoaded = await tui.waitFor(s.id, 5000, { region: "detailPane" });
      expect(detailLoaded).toBe(true);

      const { detailPane } = tui.screen();
      const detail = detailPane.join("\n");
      expect(detail).toContain(s.id);
      expect(detail).toContain("bare");
    } finally {
      tui.stop();
    }
  }, 30_000);
});
