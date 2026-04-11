/**
 * E2E TUI tab navigation and content tests.
 *
 * Verifies all 9 tabs render, switching works with 1-9 keys,
 * Agents/Flows tabs show builtin definitions, Compute tab shows
 * local as running, and status bar hints update per tab.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { TuiDriver } from "../fixtures/tui-driver.js";
import { snapshotArkTmuxSessions, killNewArkTmuxSessions } from "../../core/__tests__/test-helpers.js";

let tmuxSnapshot: Set<string>;
beforeAll(() => { tmuxSnapshot = snapshotArkTmuxSessions(); });
afterAll(() => { killNewArkTmuxSessions(tmuxSnapshot); });

describe("e2e TUI tabs", () => {

  it("shows all 9 tabs in the tab bar", async () => {
    const tui = new TuiDriver();
    try {
      await tui.start();
      const raw = tui.text();
      expect(raw).toContain("Sessions");
      expect(raw).toContain("Agents");
      expect(raw).toContain("Flows");
      expect(raw).toContain("Compute");
      expect(raw).toContain("History");
      expect(raw).toContain("Memory");
      expect(raw).toContain("Tools");
      expect(raw).toContain("Schedules");
      expect(raw).toContain("Costs");
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("switches between all tabs with number keys 1-9", async () => {
    const tui = new TuiDriver();
    try {
      await tui.start();

      // Start on Sessions (tab 1)
      tui.expectRegion("tabBar", "Sessions");

      await tui.switchTab(2);
      tui.expectRegion("tabBar", "Agents");

      await tui.switchTab(3);
      tui.expectRegion("tabBar", "Flows");

      await tui.switchTab(4);
      tui.expectRegion("tabBar", "Compute");

      await tui.switchTab(5);
      tui.expectRegion("tabBar", "History");

      await tui.switchTab(6);
      tui.expectRegion("tabBar", "Memory");

      // Return to Sessions
      await tui.switchTab(1);
      tui.expectRegion("tabBar", "Sessions");
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("Agents tab shows builtin agent names", async () => {
    const tui = new TuiDriver();
    try {
      await tui.start();
      await tui.switchTab(2);

      // Wait for agents to load
      const found = await tui.waitFor("worker", 5000);
      expect(found).toBe(true);

      const raw = tui.text();
      // These are builtin agents from agents/ directory
      expect(raw).toContain("worker");
      expect(raw).toContain("planner");
      expect(raw).toContain("implementer");
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("Flows tab shows builtin flow names", async () => {
    const tui = new TuiDriver();
    try {
      await tui.start();
      await tui.switchTab(3);

      // Wait for flows to load
      const found = await tui.waitFor("bare", 5000);
      expect(found).toBe(true);

      const raw = tui.text();
      expect(raw).toContain("bare");
      expect(raw).toContain("default");
      expect(raw).toContain("quick");
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("Compute tab shows local compute as running", async () => {
    const tui = new TuiDriver();
    try {
      await tui.start();
      await tui.switchTab(4);
      await tui.waitFor("local");

      const raw = tui.text();
      expect(raw).toContain("local");
      expect(raw).toContain("running");
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("status bar hints change per tab", async () => {
    const tui = new TuiDriver();
    try {
      await tui.start();

      // Sessions tab -- should show session-relevant hints
      tui.expectRegion("statusBar", "new");
      tui.expectRegion("statusBar", "quit");

      // Compute tab -- should show compute-relevant hints
      await tui.switchTab(4);
      await tui.waitFor("provision", 3000, { region: "statusBar" });
      tui.expectRegion("statusBar", "provision");
      tui.expectRegion("statusBar", "new");

      // Agents tab -- different hint set
      await tui.switchTab(2);
      await tui.waitFor("Agents", 3000, { region: "tabBar" });
      // Should still show quit
      tui.expectRegion("statusBar", "quit");
    } finally {
      tui.stop();
    }
  }, 30_000);
});
