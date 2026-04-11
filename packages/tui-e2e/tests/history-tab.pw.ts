/**
 * Layer-one end-to-end coverage for the TUI's History tab.
 *
 * The History tab reads Claude Code transcripts from `~/.claude/projects/`,
 * Codex transcripts from `~/.codex/sessions/`, and Gemini transcripts
 * from `~/.gemini/tmp/`. A fresh ARK_TEST_DIR does NOT isolate those
 * paths on its own -- they resolve via `homedir()` which reads `HOME`,
 * not `ARK_TEST_DIR`. To guarantee the empty state we boot the harness
 * with `HOME` pointed at the fresh temp dir so all three transcript
 * sources resolve to paths that do not exist.
 *
 * The primary goal is empty-state coverage (header renders, empty
 * message appears, hint bar advertises the key actions) plus a few
 * interaction smoke checks (`r` does not crash, `/` opens search and
 * Escape closes it, `1` returns to Sessions cleanly).
 */

import { test, expect } from "@playwright/test";
import { rmSync } from "node:fs";
import { startHarness, waitForText, readTerminal, pressKey, mkTempArkDir } from "../harness.js";

test.describe("Ark TUI history tab", () => {
  test("pressing 5 switches to History and renders the header", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      // HOME override forces empty transcript discovery -- see file header.
      const harness = await startHarness({ arkDir, env: { HOME: arkDir }, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });
        await waitForText(page, "History", { timeoutMs: 10_000 });

        await pressKey(page, "5");

        // The active-tab highlight renders `5:History` as a distinct
        // token in the tab bar. The pane title also flips to the
        // `History (N)` form once the tab is active.
        await waitForText(page, /History \(\d+\)/, { timeoutMs: 10_000 });

        const text = await readTerminal(page);
        expect(text).toContain("History");
        // A Sessions-pane marker (seeded row or its header) must NOT be
        // dominating the left pane anymore -- verify the active-tab
        // highlight references History rather than Sessions. The tab
        // labels themselves stay visible regardless of which tab is
        // active, so we key off the parenthesized row count.
        expect(text).toMatch(/History \(\d+\)/);
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("empty state renders when HOME has no transcripts", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, env: { HOME: arkDir }, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });
        await pressKey(page, "5");

        // With HOME=arkDir there is no ~/.claude/projects/, no
        // ~/.codex/sessions/, no ~/.gemini/tmp/. The background
        // `historyRefresh` completes finding zero sessions and
        // TreeList falls through to its empty-message path.
        //
        // The HistoryTab TreeList's emptyMessage is literally
        // "No sessions found." Wait for either that string or the
        // zero-count header; xterm wraps long lines so we keep the
        // needle short.
        await waitForText(page, /History \(0\)|No sessions found/, { timeoutMs: 10_000 });

        const text = await readTerminal(page);
        expect(text).toMatch(/History \(0\)|No sessions found/);
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("status bar advertises search and refresh hints on History", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, env: { HOME: arkDir }, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });
        await pressKey(page, "5");
        await waitForText(page, /History \(\d+\)/, { timeoutMs: 10_000 });

        // getHistoryHints() returns these three action hints (plus
        // NAV_HINTS + GLOBAL_HINTS). Each KeyHint renders as `k:label`.
        // `r/R:refresh/rebuild` is the most distinctive marker because
        // no other tab uses that exact label pair. Wait for it
        // explicitly -- the first HistoryTab paint happens before the
        // App finishes rendering its bottom hint rows, so polling for
        // the hint is more robust than a single buffer read.
        await waitForText(page, "refresh/rebuild", { timeoutMs: 10_000 });

        const text = await readTerminal(page);
        expect(text).toContain("refresh/rebuild");
        expect(text).toContain("/:search");
        // The hint bar always includes quit -- sanity check that the
        // second hint row (GLOBAL_HINTS) is still rendering after the
        // tab-specific row is painted.
        expect(text).toContain("quit");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("pressing r (refresh) does not crash and keeps History on screen", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, env: { HOME: arkDir }, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });
        await pressKey(page, "5");
        await waitForText(page, /History \(\d+\)/, { timeoutMs: 10_000 });

        // `r` triggers asyncState.run("Refreshing...", ...) which calls
        // historyRefreshAndIndex. With HOME=arkDir there is nothing to
        // refresh and the call returns almost immediately. We do NOT
        // assert on the transient "Refreshing..." label because it may
        // already be gone by the time we read the buffer -- the
        // load-bearing assertion is that the TUI is still alive and
        // still painting the History pane afterwards.
        await pressKey(page, "r");
        await page.waitForTimeout(800);

        const text = await readTerminal(page);
        expect(text).toMatch(/History \(\d+\)/);
        // Tab bar survives.
        expect(text).toContain("Sessions");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("/ opens the search input and Escape closes it", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, env: { HOME: arkDir }, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });
        await pressKey(page, "5");
        await waitForText(page, /History \(\d+\)/, { timeoutMs: 10_000 });

        // `/` flips mode -> "search" and sets searchInputActive=true.
        // The left-pane title flips from `History (N)` to
        // `Search (0)` and the search input placeholder
        // "search sessions and transcripts..." renders below it.
        await pressKey(page, "/");
        await waitForText(page, /Search \(0\)|search sessions and transcripts/, {
          timeoutMs: 10_000,
        });

        const openText = await readTerminal(page);
        expect(openText).toMatch(/Search \(0\)|search sessions and transcripts/);

        // Two Escapes: first closes the input (keeps mode=search),
        // second reverts to mode=recent. Either one is enough to prove
        // Escape is wired; we press twice to get all the way back to
        // the recent list so the post-assertion is unambiguous.
        await pressKey(page, "Escape");
        await page.waitForTimeout(200);
        await pressKey(page, "Escape");
        await waitForText(page, /History \(\d+\)/, { timeoutMs: 10_000 });

        const closedText = await readTerminal(page);
        expect(closedText).toMatch(/History \(\d+\)/);
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("returning to Sessions tab with `1` works cleanly", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, env: { HOME: arkDir }, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });

        await pressKey(page, "5");
        await waitForText(page, /History \(\d+\)/, { timeoutMs: 10_000 });
        // Let History's mount-time `historyRefreshAndIndex()` settle
        // before we fire the tab-switch keystroke. With the `HOME`
        // override there is nothing to refresh, so this just gives
        // the asyncState a tick to go non-loading and the TabBar
        // spinner to clear.
        await page.waitForTimeout(500);

        await pressKey(page, "1");
        // The Sessions empty state paints `No sessions. Press n to
        // create.` in the left pane. That string is unique to the
        // Sessions tab when the arkDir is empty, so it is the
        // unambiguous marker we have switched tabs. xterm's scrollback
        // may still contain the old History frame, so we do NOT
        // negative-assert on the History pane title here.
        await waitForText(page, /No sessions\. Press n to/, { timeoutMs: 10_000 });

        const text = await readTerminal(page);
        expect(text).toMatch(/No sessions\. Press n to/);
        // Tab bar row still lists History so we can flip back if we
        // want to -- confirms tab-switch did not crash the app.
        expect(text).toContain("History");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });
});
