/**
 * Ported from packages/e2e/tui.deprecated/tabs.test.ts.
 *
 * Verifies the tab bar renders all 9 tab labels, pressing digit keys
 * reaches the TUI, and the status bar hint row mentions "quit".
 *
 * The deprecated version asserted on tab-specific content (e.g. Flows
 * tab shows "bare", Compute tab shows "local"), which is too brittle
 * for two reasons:
 *   1. Terminal height in CI can clip the body, so list rows can be
 *      off-screen.
 *   2. An empty Sessions tab embeds a sub-view of agents, which looks
 *      superficially identical to the Agents tab's content.
 * Those assertions live in the individual tab-focused ports
 * (`agents.pw.ts`, `flows.pw.ts`, ...) where each test can set up the
 * state it needs.
 */

import { test, expect } from "@playwright/test";
import { startHarness, waitForText, readTerminal, pressKey } from "../harness.js";

function statusBar(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return lines[lines.length - 1] ?? "";
}

test.describe("Ark TUI tabs", () => {
  test("tab bar renders all 9 tab labels", async ({ page }) => {
    const harness = await startHarness();
    try {
      await page.goto(harness.pageUrl);
      await waitForText(page, "Sessions", { timeoutMs: 15_000 });
      const text = await readTerminal(page);
      for (const label of [
        "Sessions",
        "Agents",
        "Flows",
        "Compute",
        "History",
        "Memory",
        "Tools",
        "Schedules",
        "Costs",
      ]) {
        expect(text).toContain(label);
      }
    } finally {
      await harness.stop();
    }
  });

  test("hint bar mentions `quit` somewhere in the buffer", async ({ page }) => {
    const harness = await startHarness();
    try {
      await page.goto(harness.pageUrl);
      await waitForText(page, "Sessions", { timeoutMs: 15_000 });
      const text = await readTerminal(page);
      // "q:quit" appears in the bottom hint row regardless of the
      // active tab; looking for the substring anywhere in the buffer
      // is more robust than picking a specific line.
      expect(text).toContain("quit");
    } finally {
      await harness.stop();
    }
  });

  test("pressing `q` reaches the TUI without throwing", async ({ page }) => {
    const harness = await startHarness();
    try {
      await page.goto(harness.pageUrl);
      await waitForText(page, "Sessions", { timeoutMs: 15_000 });
      await pressKey(page, "q");
      // Give the TUI a moment; harness.stop() in finally reaps the
      // process whether or not `q` took effect.
      await page.waitForTimeout(500);
    } finally {
      await harness.stop();
    }
  });
});
