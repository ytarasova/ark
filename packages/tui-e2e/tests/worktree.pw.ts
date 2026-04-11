/**
 * Ported from packages/e2e/tui.deprecated/worktree.test.ts.
 *
 * The legacy file had two scenarios:
 *   1. "dispatch with real git repo creates worktree" -- requires a
 *      live `dispatch()` call against an isolated AppContext, which
 *      spawns a real Claude Code agent in tmux and produces a real
 *      git worktree. The browser harness has no in-process
 *      AppContext, and we don't want to launch real agents inside CI,
 *      so this scenario is SKIPPED.
 *   2. "W key shows worktree overlay for a session with worktree" --
 *      ported. Seeds a session against the harness's ARK_TEST_DIR,
 *      boots the TUI, presses W on the seeded row, asserts the
 *      "Finish Worktree" overlay renders, then Esc closes it.
 *
 * Plus two additional surface checks against the `ark worktree` CLI
 * (`list` and `cleanup --dry-run`) -- they don't go through the TUI
 * but they exercise the same worktree commands the legacy file
 * cared about, against the same isolated ARK_TEST_DIR.
 */

import { test, expect } from "@playwright/test";
import { rmSync } from "node:fs";
import {
  startHarness,
  waitForText,
  readTerminal,
  seedSession,
  mkTempArkDir,
  runArkCli,
} from "../harness.js";

test.describe("Ark TUI worktree", () => {
  test.skip(
    "dispatch with real git repo creates worktree (legacy scenario)",
    () => {
      // Requires a live dispatch() against an in-process AppContext +
      // a real Claude Code agent + a real git worktree. The browser
      // harness intentionally has no in-process AppContext (the TUI
      // owns the DB inside its own pty subprocess), so reproducing
      // this scenario would mean booting the full agent stack from a
      // Playwright test. Out of scope for the harness.
    },
  );

  test("W key opens the Finish Worktree overlay on a seeded session", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      // Seed a single session so it's preselected when the TUI opens.
      // `--repo .` resolves to the cwd of the spawned ark CLI, which
      // sets session.workdir -- the W handler requires `selected.workdir`
      // to be truthy before opening the overlay.
      seedSession(arkDir, { summary: "worktree-overlay-test", flow: "bare" });

      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });
        await waitForText(page, "worktree-overlay-test", { timeoutMs: 10_000 });

        // Press W -- worktreeFinish hotkey -- to open the overlay.
        // Write directly to the pty (bypassing xterm's keyboard event
        // pipeline) so the literal capital "W" reaches Ink's
        // useInput. The hotkey table is case-sensitive
        // (`input === "W"`) and routing through Playwright's
        // keyboard.press("W") doesn't reliably encode the shift
        // modifier into a capital byte across xterm/node-pty.
        harness.write("W");

        // The overlay renders "Finish Worktree" as its title with the
        // M / P / Esc choices below it. Wait for the title to appear.
        await waitForText(page, "Finish Worktree", { timeoutMs: 10_000 });

        const text = await readTerminal(page);
        expect(text).toContain("Finish Worktree");
        // Both action labels should be visible in the overlay body.
        expect(text).toMatch(/Merge/);
        expect(text).toMatch(/PR/);

        // Esc (0x1B) closes the overlay -- the seeded session row
        // should still be present afterwards. Write the literal byte
        // for the same reason we wrote "W" above.
        harness.write("\x1b");
        await page.waitForTimeout(500);

        const after = await readTerminal(page);
        expect(after).toContain("worktree-overlay-test");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("`ark worktree list` reports no worktrees for a freshly seeded session", async () => {
    // Surface check on the worktree CLI command. A freshly seeded
    // session has no actual worktree on disk (dispatch was never
    // called), so `worktree list` should report an empty result.
    const arkDir = mkTempArkDir();
    try {
      seedSession(arkDir, { summary: "worktree-list-test", flow: "bare" });

      const out = runArkCli(["worktree", "list"], { arkDir });
      // Either the "No sessions with active worktrees" empty-state
      // message or simply no row containing the seeded summary.
      expect(out).not.toContain("worktree-list-test");
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("`ark worktree cleanup --dry-run` runs without error on an empty arkdir", async () => {
    // Cleanup with --dry-run should never mutate state and should
    // exit zero whether or not orphaned worktrees exist.
    const arkDir = mkTempArkDir();
    try {
      const out = runArkCli(["worktree", "cleanup", "--dry-run"], { arkDir });
      // We don't assert on a specific message -- just that the
      // command exits cleanly. runArkCli throws on non-zero exit.
      expect(typeof out).toBe("string");
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });
});
