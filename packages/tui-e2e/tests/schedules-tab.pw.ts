/**
 * Layer-one e2e coverage for the Ark TUI Schedules tab.
 *
 * Mirrors the pattern used by sessions.pw.ts / session-crud.pw.ts:
 *
 *   - Allocate a fresh ARK_TEST_DIR with `mkTempArkDir`.
 *   - Seed schedules via `runArkCli(["schedule", "add", ...])` BEFORE
 *     `startHarness()`. SQLite/WAL can't share writers while the TUI
 *     subprocess holds the connection, so all seeding must happen
 *     before the TUI boots.
 *   - Press `8` to switch to the Schedules tab (index 7 in TABS, which
 *     lives in packages/tui/components/TabBar.tsx).
 *   - Assert against the rendered xterm buffer via `readTerminal` /
 *     `waitForText`, not against in-process state.
 *
 * CLI note: the ark CLI uses `ark schedule add`, NOT `ark schedule
 * create`. Verified via `ark schedule --help` -- the subcommand is
 * `add`. Flags are `--cron`, `--flow`, `--repo`, `--summary`,
 * `--compute`, `--group`.
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

/**
 * Seed a schedule in the given ARK_TEST_DIR. Thin wrapper over
 * `ark schedule add`. Returns the `sched-<hex>` id parsed from stdout.
 */
function seedSchedule(
  arkDir: string,
  opts: {
    cron: string;
    summary: string;
    repo?: string;
    flow?: string;
  },
): string {
  const args = [
    "schedule",
    "add",
    "--cron",
    opts.cron,
    "--repo",
    opts.repo ?? process.cwd(),
    "--summary",
    opts.summary,
    "--flow",
    opts.flow ?? "bare",
  ];
  const out = runArkCli(args, { arkDir });
  const match = out.match(/sched-[0-9a-f]+/);
  return match?.[0] ?? "";
}

/** Switch to the Schedules tab and wait for its header to render. */
async function openSchedulesTab(page: import("@playwright/test").Page): Promise<void> {
  await waitForText(page, "Sessions", { timeoutMs: 15_000 });
  await pressKey(page, "8");
  // The tab-switch writes a "Schedules (N)" SplitPane header. Wait
  // for that concrete substring -- the tab label "Schedules" is
  // already present in the top tab bar even before navigation, so
  // matching "Schedules (" distinguishes the navigated-to state.
  await waitForText(page, /Schedules \(\d+\)/, { timeoutMs: 10_000 });
}

test.describe("Ark TUI Schedules tab", () => {
  test("pressing 8 switches to the Schedules tab", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await openSchedulesTab(page);

        const text = await readTerminal(page);
        // SplitPane header "Schedules (0)" -- parens distinguish it
        // from the top tab bar label.
        expect(text).toMatch(/Schedules \(\d+\)/);
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("empty state renders when no schedules exist", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await openSchedulesTab(page);

        // SchedulesTab renders `<Text dimColor>No schedules configured.</Text>`
        // when the list is empty.
        await waitForText(page, "No schedules configured.", { timeoutMs: 5_000 });

        const text = await readTerminal(page);
        expect(text).toContain("No schedules configured.");
        expect(text).toMatch(/Schedules \(0\)/);
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("seeded schedule appears in the list after boot", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const id = seedSchedule(arkDir, {
        cron: "0 9 * * *",
        summary: "daily-morning-seed",
      });
      expect(id).toMatch(/^sched-/);

      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await openSchedulesTab(page);

        // Row renders the summary (truncated to 30 chars, padded) and
        // the cron expression. Both should appear in the buffer.
        await waitForText(page, "daily-morning-seed", { timeoutMs: 10_000 });
        await waitForText(page, "0 9 * * *", { timeoutMs: 5_000 });

        const text = await readTerminal(page);
        expect(text).toContain("daily-morning-seed");
        expect(text).toContain("0 9 * * *");
        // One schedule should be reflected in the header count.
        expect(text).toMatch(/Schedules \(1\)/);
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("detail pane shows cron, flow, repo, and enabled state", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      seedSchedule(arkDir, {
        cron: "*/15 * * * *",
        summary: "detail-pane-target",
        flow: "bare",
      });

      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await openSchedulesTab(page);

        // A single-row list auto-selects the only schedule, so the
        // ScheduleDetail pane on the right renders immediately.
        await waitForText(page, "detail-pane-target", { timeoutMs: 10_000 });

        const text = await readTerminal(page);

        // DetailPanel fields from ScheduleDetail: Status, Cron, Flow,
        // Repo. The labels come from <KeyValue label="...">.
        expect(text).toContain("Status");
        expect(text).toContain("Cron");
        expect(text).toContain("Flow");
        expect(text).toContain("Repo");

        // New schedules default to enabled=true, so "enabled" should
        // render in the Status field. The row icon is green "●".
        expect(text).toContain("enabled");

        // The cron expression and flow should appear at least once
        // (either in the list row or the detail pane).
        expect(text).toContain("*/15 * * * *");
        expect(text).toContain("bare");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("pressing n opens the New Schedule form", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await openSchedulesTab(page);

        // Sanity: empty state visible before opening the form.
        await waitForText(page, "No schedules configured.", { timeoutMs: 5_000 });

        // Open the new-schedule form. `n` is the Schedules-tab hotkey
        // (see SchedulesTab.tsx useInput handler).
        await pressKey(page, "n");

        // NewScheduleForm renders a bold header "New Schedule" and
        // several FormTextField labels (Cron, Summary, Repo, ...).
        await waitForText(page, "New Schedule", { timeoutMs: 5_000 });

        const text = await readTerminal(page);
        expect(text).toContain("New Schedule");
        // Field labels should render as part of the form.
        expect(text).toContain("Cron");
        expect(text).toContain("Summary");
        // Default cron placeholder value from the form's useState.
        expect(text).toContain("*/30 * * * *");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("pressing Escape closes the New Schedule form", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await openSchedulesTab(page);

        await pressKey(page, "n");
        await waitForText(page, "New Schedule", { timeoutMs: 5_000 });

        // Escape is wired to `onCancel` in useFormNavigation, which
        // the SchedulesTab passes as `onDone` -> sets showCreate=false.
        await pressKey(page, "Escape");

        // After closing, the list view (with its "Schedules (N)"
        // SplitPane header) should render again. Use the parenthesised
        // count to distinguish it from the top tab bar label.
        await waitForText(page, /Schedules \(\d+\)/, { timeoutMs: 5_000 });
        await waitForText(page, "No schedules configured.", { timeoutMs: 5_000 });

        const text = await readTerminal(page);
        // The form's unique header "New Schedule " (note trailing
        // space in the source) should no longer be the active view --
        // the empty-state placeholder is the strongest signal.
        expect(text).toContain("No schedules configured.");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("status bar shows schedule-specific hints", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await openSchedulesTab(page);

        // getSchedulesHints() emits KeyHint entries for n:new,
        // e:enable/disable, x:delete, r:refresh. Each KeyHint renders
        // as "<key>:<label>" in the status bar.
        const text = await readTerminal(page);
        expect(text).toContain("n:new");
        expect(text).toContain("x:delete");
        expect(text).toContain("r:refresh");
        // enable/disable hint is present but may wrap; match the
        // distinctive "e:" prefix plus "enable" substring.
        expect(text).toMatch(/e:enable/);
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("digit navigation reaches Schedules from a different starting tab", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });

        // Start from a non-Schedules tab (Agents = index 1).
        await pressKey(page, "2");
        // Agents tab renders a builtin agent list -- "implementer"
        // is shipped in agents/implementer.yaml.
        await waitForText(page, "implementer", { timeoutMs: 10_000 });

        // Give the TUI a beat to drain the `2` keystroke before we
        // dispatch the next one. Without this small settle the second
        // digit can get coalesced / dropped during the tab rerender.
        await page.waitForTimeout(300);

        // Now navigate to Schedules.
        await pressKey(page, "8");
        await waitForText(page, /Schedules \(\d+\)/, { timeoutMs: 10_000 });
        await waitForText(page, "No schedules configured.", { timeoutMs: 5_000 });

        const text = await readTerminal(page);
        expect(text).toMatch(/Schedules \(\d+\)/);
        expect(text).toContain("No schedules configured.");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });
});
