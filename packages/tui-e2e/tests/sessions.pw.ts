/**
 * Ported from packages/e2e/tui.deprecated/sessions.test.ts.
 *
 * Seeds sessions via `ark session start` against a fresh ARK_TEST_DIR
 * BEFORE booting the harness. SQLite's lock semantics mean the TUI
 * subprocess can't coexist with a second `ark` CLI writer on the same
 * DB, so seeding has to happen before the TUI opens the connection.
 */

import { test, expect } from "@playwright/test";
import { rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { startHarness, waitForText, readTerminal, seedSession, pressKey, mkTempArkDir, runArkCli } from "../harness.js";

test.describe("Ark TUI sessions list", () => {
  test("seeded sessions appear in the list pane", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      seedSession(arkDir, { summary: "sessions-list-alpha" });
      seedSession(arkDir, { summary: "sessions-list-beta" });

      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });
        await waitForText(page, "sessions-list-alpha", { timeoutMs: 10_000 });
        await waitForText(page, "sessions-list-beta", { timeoutMs: 10_000 });
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("status bar reflects a session count after seeding", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      seedSession(arkDir, { summary: "count-test-one" });
      seedSession(arkDir, { summary: "count-test-two" });

      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });
        await waitForText(page, "count-test-one", { timeoutMs: 10_000 });

        const text = await readTerminal(page);
        expect(text).toMatch(/\d+ sessions?/);
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("group-by-status shows status group headers", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      // Seed sessions: 3 ready + 2 completed
      seedSession(arkDir, { summary: "grp-ready-alpha" });
      seedSession(arkDir, { summary: "grp-ready-beta" });
      seedSession(arkDir, { summary: "grp-ready-gamma" });
      const doneId1 = seedSession(arkDir, { summary: "grp-done-0" });
      const doneId2 = seedSession(arkDir, { summary: "grp-done-1" });
      if (doneId1) runArkCli(["session", "complete", doneId1, "--force"], { arkDir });
      if (doneId2) runArkCli(["session", "complete", doneId2, "--force"], { arkDir });

      const harness = await startHarness({ arkDir, rows: 30 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });
        await waitForText(page, "grp-ready-alpha", { timeoutMs: 10_000 });

        // Toggle group-by-status with %
        await pressKey(page, "%");
        await waitForText(page, "by status", { timeoutMs: 5_000 });

        const text = await readTerminal(page);

        // "Ready" header must be present and appear before the first ready session
        const readyPos = text.indexOf("Ready (3)");
        const firstSessionPos = text.indexOf("grp-ready-");
        expect(readyPos).toBeGreaterThan(-1);
        expect(firstSessionPos).toBeGreaterThan(-1);
        expect(readyPos).toBeLessThan(firstSessionPos);
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("group-by-status with zero sessions shows no crash", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 30 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });

        // Toggle group-by-status with no sessions
        await pressKey(page, "%");
        await waitForText(page, "by status", { timeoutMs: 5_000 });

        const text = await readTerminal(page);
        // Should not crash, just show empty
        expect(text).toContain("Sessions");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("session detail pane shows the flow name", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const id = seedSession(arkDir, { summary: "detail-fields-test", flow: "bare" });

      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });
        await waitForText(page, "detail-fields-test", { timeoutMs: 10_000 });

        const text = await readTerminal(page);
        if (id) expect(text).toContain(id);
        expect(text).toContain("bare");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });
});
