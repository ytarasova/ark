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
import { startHarness, waitForText, readTerminal, seedSession, mkTempArkDir } from "../harness.js";

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
