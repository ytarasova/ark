/**
 * Layer-one e2e coverage for the Ark TUI Memory (knowledge) tab.
 *
 * The Memory tab (index 6) is backed by MemoryManager.tsx, which calls
 * `memory/list` over JSON-RPC. `memory/list` reads type=memory nodes
 * directly from the knowledge graph, so we can pre-seed the tab by
 * running `ark knowledge remember <content>` against a fresh
 * ARK_TEST_DIR BEFORE booting the harness -- same SQLite-locking
 * constraint as sessions.pw.ts.
 *
 * Covers:
 *   1. Switching to the Memory tab via `6` renders without crashing.
 *   2. Fresh harness shows an empty-state message.
 *   3. Memory-tab status bar hints (`n:add`, `/:search`, `s:stats`).
 *   4. Seeded memories appear in the list pane.
 *   5. Multiple seeded memories render and the list label updates.
 *   6. Pressing `1` returns to the Sessions tab.
 *   7. `j/k` navigation does not crash on a populated list.
 */

import { test, expect } from "@playwright/test";
import { rmSync } from "node:fs";
import {
  startHarness,
  waitForText,
  readTerminal,
  pressKey,
  runArkCli,
  mkTempArkDir,
} from "../harness.js";

test.describe("Ark TUI memory tab", () => {
  test("knowledge CLI subcommands are available", async () => {
    // Sanity check: the seeding path we rely on actually exists.
    // If this regresses we want a clear error here, not a mysterious
    // "memory is empty" failure five tests later.
    const arkDir = mkTempArkDir();
    try {
      const help = runArkCli(["knowledge", "--help"], { arkDir });
      expect(help).toContain("remember");
      expect(help).toContain("recall");
      expect(help).toContain("stats");
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("pressing `6` switches to the Memory tab without crashing", async ({ page }) => {
    const harness = await startHarness();
    try {
      await page.goto(harness.pageUrl);
      await waitForText(page, "Sessions", { timeoutMs: 15_000 });

      await pressKey(page, "6");

      // The TabBar label "Memory" is always rendered on every tab, so
      // the reliable signal that we actually switched is the left-pane
      // title which MemoryManager sets to "Memories (<n>)". Wait for
      // that instead of a top-bar substring.
      await waitForText(page, /Memories\s*\(/, { timeoutMs: 10_000 });

      const text = await readTerminal(page);
      expect(text).toContain("Memory");
      expect(text).toMatch(/Memories\s*\(\d+\)/);
    } finally {
      await harness.stop();
    }
  });

  test("empty state renders on a fresh harness", async ({ page }) => {
    const harness = await startHarness();
    try {
      await page.goto(harness.pageUrl);
      await waitForText(page, "Sessions", { timeoutMs: 15_000 });

      await pressKey(page, "6");
      await waitForText(page, /Memories\s*\(0\)/, { timeoutMs: 10_000 });

      // MemoryManager passes emptyMessage="No memories. Press n to add."
      // to TreeList when the list is empty.
      await waitForText(page, "No memories", { timeoutMs: 10_000 });

      const text = await readTerminal(page);
      expect(text).toContain("No memories");
      // The empty-state copy also tells the user how to proceed.
      expect(text).toMatch(/Press\s+n\s+to\s+add/i);
    } finally {
      await harness.stop();
    }
  });

  test("status bar shows memory-related hints", async ({ page }) => {
    const harness = await startHarness();
    try {
      await page.goto(harness.pageUrl);
      await waitForText(page, "Sessions", { timeoutMs: 15_000 });

      await pressKey(page, "6");
      await waitForText(page, /Memories\s*\(/, { timeoutMs: 10_000 });

      const text = await readTerminal(page);
      // MemoryManager's getMemoryHints() emits these KeyHint entries
      // (see packages/tui/components/MemoryManager.tsx).
      expect(text).toContain("n:add");
      expect(text).toContain("/:search");
      expect(text).toContain("s:stats");
      expect(text).toContain("x:delete");
      // GLOBAL_HINTS adds quit on every tab's hint row.
      expect(text).toContain("q:quit");
    } finally {
      await harness.stop();
    }
  });

  test("seeded memory appears in the list pane", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      // `ark knowledge remember <content>` stores a type=memory node in
      // the knowledge graph, which is exactly what `memory/list` reads.
      runArkCli(
        ["knowledge", "remember", "memory-tab-seed-alpha", "--tags", "e2e,alpha"],
        { arkDir },
      );

      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });

        await pressKey(page, "6");
        // Wait for the list to pick up the seeded row. The label is
        // truncated to 40 chars in getItemLabel, so the full literal
        // is safe to search for.
        await waitForText(page, "memory-tab-seed-alpha", { timeoutMs: 15_000 });

        const text = await readTerminal(page);
        expect(text).toContain("memory-tab-seed-alpha");
        // `(n)` suffix in the left pane title should reflect at least 1.
        expect(text).toMatch(/Memories\s*\([1-9]\d*\)/);
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("multiple seeded memories render in the list", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      runArkCli(["knowledge", "remember", "memory-list-one"], { arkDir });
      runArkCli(["knowledge", "remember", "memory-list-two"], { arkDir });
      runArkCli(["knowledge", "remember", "memory-list-three"], { arkDir });

      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });

        await pressKey(page, "6");
        await waitForText(page, "memory-list-one", { timeoutMs: 15_000 });
        await waitForText(page, "memory-list-two", { timeoutMs: 10_000 });
        await waitForText(page, "memory-list-three", { timeoutMs: 10_000 });

        const text = await readTerminal(page);
        // All three seeds should be visible simultaneously on a
        // 40-row terminal, and the count should reflect the number of
        // seeded rows.
        expect(text).toContain("memory-list-one");
        expect(text).toContain("memory-list-two");
        expect(text).toContain("memory-list-three");
        expect(text).toMatch(/Memories\s*\(3\)/);
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("pressing `j`/`k` on a populated list does not crash", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      runArkCli(["knowledge", "remember", "nav-test-row-1"], { arkDir });
      runArkCli(["knowledge", "remember", "nav-test-row-2"], { arkDir });

      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });

        await pressKey(page, "6");
        await waitForText(page, "nav-test-row-1", { timeoutMs: 15_000 });

        // useListNavigation handles j/k for the left pane in list mode.
        // We don't assert on selection highlighting (ANSI colors are
        // not captured by translateToString), just that the rows stay
        // rendered and the TUI does not disappear.
        await pressKey(page, "j");
        await page.waitForTimeout(150);
        await pressKey(page, "j");
        await page.waitForTimeout(150);
        await pressKey(page, "k");
        await page.waitForTimeout(150);

        const text = await readTerminal(page);
        expect(text).toContain("nav-test-row-1");
        expect(text).toContain("nav-test-row-2");
        expect(text).toMatch(/Memories\s*\(2\)/);
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("pressing `1` from Memory tab returns to Sessions", async ({ page }) => {
    const harness = await startHarness();
    try {
      await page.goto(harness.pageUrl);
      await waitForText(page, "Sessions", { timeoutMs: 15_000 });

      await pressKey(page, "6");
      await waitForText(page, /Memories\s*\(/, { timeoutMs: 10_000 });

      await pressKey(page, "1");
      // SessionsTab renders a "No sessions. Press n to create." empty
      // state on a fresh harness -- a signal that only appears once
      // the Sessions tab has actually re-rendered (not just the tab
      // index moving). Waiting on the status bar or tab header is
      // unreliable because the Memory tab's left pane stays in the
      // xterm buffer during the Sessions load spinner.
      await waitForText(page, "No sessions", { timeoutMs: 10_000 });

      const text = await readTerminal(page);
      // Sessions empty-state copy is present.
      expect(text).toContain("No sessions");
      // Sessions tab still renders the tab bar.
      expect(text).toContain("Sessions");
    } finally {
      await harness.stop();
    }
  });
});
