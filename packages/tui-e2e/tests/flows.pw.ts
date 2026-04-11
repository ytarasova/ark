/**
 * Flow progression E2E tests for the Ark TUI.
 *
 * Exercises the core Ark flow mechanic from the terminal side:
 *   - A newly-seeded session displays the first stage of its flow in
 *     the detail pane.
 *   - Advancing the stage via `ark session advance --force` (run BEFORE
 *     the TUI opens the DB) is reflected in the rendered detail.
 *   - Sessions seeded with different flows each report their own
 *     flow + stage in the sessions list row.
 *
 * These tests assert on the actual terminal buffer via `readTerminal`,
 * matching the sibling `sessions.pw.ts` pattern. No in-process
 * AppContext -- the TUI owns its own SQLite DB in a subprocess, so
 * state is seeded via `runArkCli` against `ARK_TEST_DIR` before
 * `startHarness()`.
 *
 * Flow stage literals come from the shipped YAMLs:
 *   - `flows/definitions/bare.yaml`    -> 1 stage: work
 *   - `flows/definitions/default.yaml` -> 9 stages, first: intake
 */

import { test, expect } from "@playwright/test";
import { rmSync } from "node:fs";
import {
  startHarness,
  waitForText,
  readTerminal,
  seedSession,
  runArkCli,
  mkTempArkDir,
  pressKey,
  type Harness,
} from "../harness.js";

// Stage literals copied from the shipped flow YAMLs. If these change,
// the test should break loudly.
const DEFAULT_FIRST_STAGE = "intake";
const DEFAULT_SECOND_STAGE = "plan";

test.describe("Ark TUI flow progression", () => {
  // ───────────────────────────────────────────────────────────────────────
  // 1. bare flow: detail pane shows the initial `work` stage
  // ───────────────────────────────────────────────────────────────────────
  test("bare-flow session renders its initial `work` stage in the detail pane", async ({ page }) => {
    const arkDir = mkTempArkDir();
    let harness: Harness | null = null;
    try {
      const id = seedSession(arkDir, { summary: "bare-flow-detail-stage", flow: "bare" });

      harness = await startHarness({ arkDir, rows: 40 });
      await page.goto(harness.pageUrl);
      await waitForText(page, "Sessions", { timeoutMs: 15_000 });
      await waitForText(page, "bare-flow-detail-stage", { timeoutMs: 10_000 });

      // The detail pane renders `Flow <value>` and `Stage <value>` as
      // key-value rows. The left pane is narrow enough that the row's
      // `stage:...` suffix gets truncated by the summary column width,
      // so we assert on the Info grid in the right pane instead.
      await waitForText(page, /Stage\s+work/, { timeoutMs: 10_000 });
      await waitForText(page, /Flow\s+bare/, { timeoutMs: 10_000 });
      // Orchestration logs `stage_ready` with stage `work` at session
      // start -- the Events strip renders the friendly `Ready to run:
      // <stage>` summary, confirming the stage made it to the event
      // stream (not just the session row).
      await waitForText(page, "Ready to run: work", { timeoutMs: 10_000 });

      const text = await readTerminal(page);
      if (id) expect(text).toContain(id);
      expect(text).toMatch(/Stage\s+work/);
      expect(text).toMatch(/Flow\s+bare/);
      expect(text).toContain("Ready to run: work");
    } finally {
      if (harness) await harness.stop();
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // 2. default flow: detail pane shows the first stage `intake`
  // ───────────────────────────────────────────────────────────────────────
  test("default-flow session renders `intake` as its first stage", async ({ page }) => {
    const arkDir = mkTempArkDir();
    let harness: Harness | null = null;
    try {
      const id = seedSession(arkDir, { summary: "default-flow-first-stage", flow: "default" });

      harness = await startHarness({ arkDir, rows: 40 });
      await page.goto(harness.pageUrl);
      await waitForText(page, "Sessions", { timeoutMs: 15_000 });
      await waitForText(page, "default-flow-first-stage", { timeoutMs: 10_000 });

      // Detail-pane Info grid is where the stage is reliably visible
      // (left-pane rows truncate long summaries + stage suffixes).
      await waitForText(page, new RegExp(`Stage\\s+${DEFAULT_FIRST_STAGE}`), { timeoutMs: 10_000 });
      await waitForText(page, /Flow\s+default/, { timeoutMs: 10_000 });
      // The orchestration emits `stage_ready` with the first stage
      // name; the Events strip renders it as `Ready to run: <stage>`.
      await waitForText(page, `Ready to run: ${DEFAULT_FIRST_STAGE}`, { timeoutMs: 10_000 });

      const text = await readTerminal(page);
      if (id) expect(text).toContain(id);
      expect(text).toMatch(new RegExp(`Stage\\s+${DEFAULT_FIRST_STAGE}`));
      expect(text).toMatch(/Flow\s+default/);
      expect(text).toContain(`Ready to run: ${DEFAULT_FIRST_STAGE}`);
    } finally {
      if (harness) await harness.stop();
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // 3. advance BEFORE boot: detail pane reflects the advanced stage
  // ───────────────────────────────────────────────────────────────────────
  test("`session advance --force` run before boot shifts the displayed stage", async ({ page }) => {
    const arkDir = mkTempArkDir();
    let harness: Harness | null = null;
    try {
      const id = seedSession(arkDir, { summary: "advance-before-boot", flow: "default" });
      expect(id).toMatch(/^s-[0-9a-f]+$/);

      // Walk the stage pointer from `intake` -> `plan` via the CLI. The
      // CLI creates an in-process server against ARK_TEST_DIR, so the
      // DB is not held open once this call returns. This must run
      // BEFORE the TUI opens its own connection.
      const advanceOut = runArkCli(
        ["session", "advance", id, "--force"],
        { arkDir },
      );
      // `advance` prints the result from orchestration; confirm it
      // reported reaching the second stage before we even look at the
      // TUI.
      expect(advanceOut).toContain(DEFAULT_SECOND_STAGE);

      harness = await startHarness({ arkDir, rows: 40 });
      await page.goto(harness.pageUrl);
      await waitForText(page, "Sessions", { timeoutMs: 15_000 });
      await waitForText(page, "advance-before-boot", { timeoutMs: 10_000 });

      // The detail pane `Stage` row now reflects the second stage. The
      // first stage `intake` must NOT be the displayed stage anymore
      // (though its name may still live in the event history).
      await waitForText(page, new RegExp(`Stage\\s+${DEFAULT_SECOND_STAGE}`), { timeoutMs: 10_000 });
      await waitForText(page, /Flow\s+default/, { timeoutMs: 10_000 });

      const text = await readTerminal(page);
      expect(text).toMatch(new RegExp(`Stage\\s+${DEFAULT_SECOND_STAGE}`));
      // Make sure the Stage row is NOT showing the initial `intake`
      // stage -- that would mean advance didn't take.
      expect(text).not.toMatch(new RegExp(`Stage\\s+${DEFAULT_FIRST_STAGE}`));
      expect(text).toMatch(/Flow\s+default/);
    } finally {
      if (harness) await harness.stop();
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // 4. Two sessions, two flows: navigate the list and verify each
  //    session's detail pane shows its own flow + stage
  // ───────────────────────────────────────────────────────────────────────
  test("sessions with different flows each render their own flow + stage when selected", async ({ page }) => {
    const arkDir = mkTempArkDir();
    let harness: Harness | null = null;
    try {
      // Seed two sessions -- the TreeList sorts by created_at DESC so
      // the most recently seeded is at the top and preselected on boot.
      const defaultId = seedSession(arkDir, { summary: "row-default-session", flow: "default" });
      const bareId = seedSession(arkDir, { summary: "row-bare-session", flow: "bare" });
      expect(defaultId).toMatch(/^s-[0-9a-f]+$/);
      expect(bareId).toMatch(/^s-[0-9a-f]+$/);

      harness = await startHarness({ arkDir, rows: 40 });
      await page.goto(harness.pageUrl);
      await waitForText(page, "Sessions", { timeoutMs: 15_000 });

      // Both sessions appear in the left-pane list. Summary width is
      // large enough that neither label gets truncated.
      await waitForText(page, "row-default-session", { timeoutMs: 10_000 });
      await waitForText(page, "row-bare-session", { timeoutMs: 10_000 });

      // Footer reports the session count.
      await waitForText(page, /2 sessions/, { timeoutMs: 10_000 });

      // The detail pane on boot shows whichever session the TreeList
      // preselected. We don't assume which -- instead we wait until
      // one of the two known Flow/Stage pairs is visible, then press
      // `j`/`k` until the OTHER pair becomes visible. This proves both
      // sessions route their own flow + stage through the detail pane.
      const PAIR_BARE = /Flow\s+bare[\s\S]*?Stage\s+work/;
      const PAIR_DEFAULT = new RegExp(
        `Flow\\s+default[\\s\\S]*?Stage\\s+${DEFAULT_FIRST_STAGE}`,
      );

      // Initial snapshot -- which pair does the preselected row show?
      let text = await readTerminal(page);
      const sawBareFirst = PAIR_BARE.test(text);
      const sawDefaultFirst = PAIR_DEFAULT.test(text);
      expect(sawBareFirst || sawDefaultFirst).toBe(true);

      // Now move selection to the other row. Two `j` presses is
      // always enough with 2 rows (bottom wraps or clamps). Use `k`
      // too to guarantee coverage regardless of preselection order.
      const targetPair = sawBareFirst ? PAIR_DEFAULT : PAIR_BARE;
      let matched = false;
      for (let i = 0; i < 4 && !matched; i++) {
        await pressKey(page, i % 2 === 0 ? "j" : "k");
        await page.waitForTimeout(200);
        text = await readTerminal(page);
        matched = targetPair.test(text);
      }
      expect(matched).toBe(true);

      // Final buffer should contain the target pair. At this point
      // we have observed BOTH pairs across the run: the initial
      // snapshot matched one, and `text` now matches the other.
      expect(text).toMatch(targetPair);
    } finally {
      if (harness) await harness.stop();
      rmSync(arkDir, { recursive: true, force: true });
    }
  });
});
