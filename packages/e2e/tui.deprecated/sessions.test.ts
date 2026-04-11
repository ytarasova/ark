/**
 * E2E TUI sessions list and navigation tests.
 *
 * Verifies sessions created via core API appear in the list pane,
 * j/k navigation updates the detail pane, Tab toggles focus,
 * and status bar shows session count.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as core from "../../core/index.js";
import { TuiDriver } from "../fixtures/tui-driver.js";
import { snapshotArkTmuxSessions, killNewArkTmuxSessions } from "../../core/__tests__/test-helpers.js";

let tmuxSnapshot: Set<string>;
beforeAll(() => { tmuxSnapshot = snapshotArkTmuxSessions(); });
afterAll(() => { killNewArkTmuxSessions(tmuxSnapshot); });

describe("e2e TUI sessions list", () => {

  it("shows sessions created via core API in the list pane", async () => {
    const tui = new TuiDriver();
    try {
      tui.createSession({
        repo: process.cwd(),
        summary: "sessions-list-alpha",
        flow: "bare",
      });
      tui.createSession({
        repo: process.cwd(),
        summary: "sessions-list-beta",
        flow: "bare",
      });

      await tui.start();

      const foundAlpha = await tui.waitFor("sessions-list-alpha");
      expect(foundAlpha).toBe(true);

      const foundBeta = await tui.waitFor("sessions-list-beta");
      expect(foundBeta).toBe(true);

      tui.expectRegion("listPane", /sessions-list-(alpha|beta)/);
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("navigates sessions with j/k and updates detail pane", async () => {
    const tui = new TuiDriver();
    try {
      const s1 = tui.createSession({
        repo: process.cwd(),
        summary: "nav-session-first",
        flow: "bare",
      });
      const s2 = tui.createSession({
        repo: process.cwd(),
        summary: "nav-session-second",
        flow: "bare",
      });

      await tui.start();
      await tui.waitFor("nav-session");

      // The detail pane should show one of the sessions
      const detailLoaded = await tui.waitFor(/s-[0-9a-f]+/, 5000, { region: "detailPane" });
      expect(detailLoaded).toBe(true);

      // Navigate down
      await tui.selectDown(1);
      await new Promise(r => setTimeout(r, 300));

      // Detail pane should still show a session ID
      const screen = tui.screen();
      const detail = screen.detailPane.join("\n");
      expect(detail).toMatch(/s-[0-9a-f]+/);

      // Navigate up
      await tui.selectUp(1);
      await new Promise(r => setTimeout(r, 300));

      const screen2 = tui.screen();
      const detail2 = screen2.detailPane.join("\n");
      expect(detail2).toMatch(/s-[0-9a-f]+/);
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("Tab toggles focus between list and detail pane", async () => {
    const tui = new TuiDriver();
    try {
      tui.createSession({
        repo: process.cwd(),
        summary: "focus-toggle-test",
        flow: "bare",
      });

      await tui.start();
      await tui.waitFor("focus-toggle-test");

      // Press Tab to focus detail pane
      tui.togglePane();
      await new Promise(r => setTimeout(r, 500));

      // The TUI should still be alive and showing the session
      expect(tui.alive()).toBe(true);
      const raw = tui.text();
      expect(raw).toContain("focus-toggle-test");

      // Press Tab again to return focus to list pane
      tui.togglePane();
      await new Promise(r => setTimeout(r, 500));

      expect(tui.alive()).toBe(true);
      expect(tui.text()).toContain("focus-toggle-test");
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("status bar shows session count", async () => {
    const tui = new TuiDriver();
    try {
      tui.createSession({
        repo: process.cwd(),
        summary: "count-test-one",
        flow: "bare",
      });
      tui.createSession({
        repo: process.cwd(),
        summary: "count-test-two",
        flow: "bare",
      });

      await tui.start();
      await tui.waitFor("count-test");

      const statusBar = tui.screen().statusBar;
      expect(statusBar).toMatch(/\d+ sessions/);
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("session detail pane shows flow and status info", async () => {
    const tui = new TuiDriver();
    try {
      const s = tui.createSession({
        repo: process.cwd(),
        summary: "detail-fields-test",
        flow: "bare",
      });

      await tui.start();
      await tui.waitFor("detail-fields-test");

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
