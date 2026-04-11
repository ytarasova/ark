/**
 * Layer-one end-to-end coverage of the Ark TUI Compute tab.
 *
 * What "layer-one" means here: we exercise the TUI's user-facing
 * behaviour without actually provisioning cloud compute. We rely on
 * two facts:
 *
 *   1. Every fresh ARK_TEST_DIR boots with a `local` compute row
 *      seeded by `seedLocalCompute()` in
 *      packages/core/repositories/schema.ts -- so the list is never
 *      empty on first render.
 *
 *   2. `ark compute create <name> --provider docker --image ...`
 *      only inserts a DB row (status=stopped). It does NOT talk to
 *      the Docker daemon, so seeding extra compute entries from the
 *      test is safe even on machines with no container runtime.
 *
 * Seeding must happen BEFORE `startHarness()` is called. Once the TUI
 * subprocess opens its SQLite connection, a second writer risks lock
 * contention -- the same pattern used by sessions.pw.ts and
 * session-crud.pw.ts.
 *
 * Input delivery uses the `pressKey` helper from harness.ts which
 * pipes straight to the pty via xterm's `term.paste`, bypassing the
 * focus-is-on-body problem with Playwright's native `keyboard.press`.
 */

import { test, expect } from "@playwright/test";
import { rmSync } from "node:fs";
import {
  startHarness,
  waitForText,
  waitForBuffer,
  readTerminal,
  runArkCli,
  pressKey,
  mkTempArkDir,
} from "../harness.js";

// Small async settle between keystrokes -- gives the React/Ink render
// loop a chance to process the input before we send the next one. The
// session-crud tests use the same helper for the same reason.
async function settle(ms = 200): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

test.describe("Ark TUI Compute tab", () => {
  test("pressing 4 switches to the Compute tab and renders the header", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        // The TUI lands on the Sessions tab by default.
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });

        await pressKey(page, "4");

        // The SplitPane renders " Compute " and " Details " as its
        // left/right titles when the Compute tab is active. The right
        // title is unique to this tab's default layout, so asserting
        // on it (as well as "Compute") distinguishes the tab body from
        // the tab bar label "4:Compute".
        await waitForText(page, "Details", { timeoutMs: 10_000 });
        const text = await readTerminal(page);
        expect(text).toContain("Compute");
        expect(text).toContain("Details");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("seeded local compute appears in the list with running status", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      // seedLocalCompute() runs inside initSchema() the first time the
      // DB is opened. Fire a cheap CLI call to force that bootstrap so
      // the row exists on disk before the TUI subprocess loads its
      // own connection. `compute list` only reads, so no writer race.
      runArkCli(["compute", "list"], { arkDir });

      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });

        await pressKey(page, "4");
        await waitForText(page, "Details", { timeoutMs: 10_000 });

        // The TreeList row renders `<icon> <name padded> <provider>`,
        // so both "local" (the name) and "local" (the provider) show
        // up -- a double occurrence of "local" is a strong signal the
        // seeded row is actually in the list.
        await waitForText(page, "local", { timeoutMs: 10_000 });

        // ComputeDetail shows "Status" as a KeyValue with the actual
        // status string ("running"). Assert on both the label and
        // the value to confirm the detail pane is rendering the
        // seeded compute, not an empty placeholder.
        await waitForBuffer(
          page,
          (text) => text.includes("Status") && text.includes("running"),
          { timeoutMs: 10_000 },
        );

        const text = await readTerminal(page);
        expect(text).toContain("local");
        expect(text).toContain("running");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("status bar includes compute-specific hints (provision / new)", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });

        await pressKey(page, "4");
        await waitForText(page, "Details", { timeoutMs: 10_000 });

        // getComputeHints() (tabs/ComputeTab.tsx) emits hints like
        // `Enter:provision`, `s:start/stop`, `t:test`, `n:new`,
        // `T:templates`. At the default 80-column harness width the
        // long labels get truncated by Ink's layout -- `provision`
        // becomes `provisi`, `start/stop` becomes `start/sto`, etc.
        // Assert on short, non-truncatable substrings instead:
        //   - `Enter` (appears verbatim as the hint's key)
        //   - `n:new` (short enough to survive truncation)
        //   - `t:test` (ditto; disambiguates from the Sessions tab's
        //     `t:talk` hint).
        // None of these substrings appear in the SessionsTab hint
        // set, so matching them proves we're on the Compute tab.
        await waitForBuffer(
          page,
          (text) =>
            text.includes("Enter") &&
            text.includes("n:new") &&
            text.includes("t:test"),
          { timeoutMs: 10_000 },
        );

        const text = await readTerminal(page);
        expect(text).toContain("Enter");
        expect(text).toContain("n:new");
        expect(text).toContain("t:test");
        // Sessions tab exposes `t:talk`, not `t:test`. If we see
        // `t:test` but NOT `t:talk` we know the tab switched.
        expect(text).not.toContain("t:talk");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("pressing n opens the new-compute provision form", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });

        await pressKey(page, "4");
        await waitForText(page, "Details", { timeoutMs: 10_000 });
        // Let the metrics poller settle before sending `n`. The Compute
        // tab kicks off a background fetch as soon as it mounts; if `n`
        // arrives mid-poll the incoming metrics re-render can stomp the
        // form. Waiting for the "Metrics" section to appear means the
        // first poll cycle has landed and subsequent polls won't repaint
        // the whole pane until the next interval.
        await waitForText(page, "Metrics", { timeoutMs: 15_000 });
        await settle(300);

        // Open the new-compute form. The form renders its own title
        // " New Compute " (NewComputeForm.tsx line 189). We don't
        // submit anything -- this test just verifies the form
        // replaced the Details pane.
        await pressKey(page, "n");
        await waitForText(page, "New Compute", { timeoutMs: 10_000 });

        const text = await readTerminal(page);
        expect(text).toContain("New Compute");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("pressing Escape from the new-compute form closes it", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });

        await pressKey(page, "4");
        await waitForText(page, "Details", { timeoutMs: 10_000 });
        // Wait for the metrics section to land before opening the
        // form -- same reasoning as the `pressing n opens` test. A
        // mid-poll `n` can race with a Metrics repaint that stomps
        // the form's right-pane slot.
        await waitForText(page, "Metrics", { timeoutMs: 15_000 });
        await settle(300);

        await pressKey(page, "n");
        await waitForText(page, "New Compute", { timeoutMs: 10_000 });

        // Escape triggers onDone() in NewComputeForm's useInput
        // handler, which clears showForm in App.tsx. The default
        // ComputeDetail should re-mount and render the " local "
        // header again.
        await pressKey(page, "Escape");

        // Wait for the form title to disappear AND for the detail
        // pane to come back. Checking for Status+running confirms the
        // default detail view re-rendered rather than getting stuck
        // on a blank overlay.
        await waitForBuffer(
          page,
          (text) => !text.includes("New Compute") && text.includes("Status"),
          { timeoutMs: 10_000 },
        );

        const text = await readTerminal(page);
        expect(text).not.toContain("New Compute");
        expect(text).toContain("Status");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("seeding a second compute via CLI renders the new row", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      // `ark compute create --provider docker` inserts a row with
      // status=stopped WITHOUT calling the Docker daemon -- it only
      // touches the DB. Safe to run on any host.
      runArkCli(
        ["compute", "create", "e2e-probe", "--provider", "docker", "--image", "ubuntu:22.04"],
        { arkDir },
      );

      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });

        await pressKey(page, "4");
        await waitForText(page, "Details", { timeoutMs: 10_000 });

        // TreeList groups by provider and sorts alphabetically, so
        // both the seeded `local` row and our new `e2e-probe` row
        // should be visible. Assert on the name we control, plus the
        // `docker` provider string (which is distinct from `local`).
        await waitForText(page, "e2e-probe", { timeoutMs: 10_000 });
        await waitForText(page, "docker", { timeoutMs: 10_000 });

        const text = await readTerminal(page);
        expect(text).toContain("local");
        expect(text).toContain("e2e-probe");
        expect(text).toContain("docker");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("j/k navigation updates selection between compute rows", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      // Need at least two rows to have a meaningful selection move.
      // Insert a docker-backed `zzz-probe` so it sorts after `local`
      // in TreeList's provider-alphabetical order.
      runArkCli(
        ["compute", "create", "zzz-probe", "--provider", "docker", "--image", "ubuntu:22.04"],
        { arkDir },
      );

      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });

        await pressKey(page, "4");
        await waitForText(page, "Details", { timeoutMs: 10_000 });
        await waitForText(page, "zzz-probe", { timeoutMs: 10_000 });

        // Detail pane initially shows the first row. The sort is by
        // provider then by name, so `docker` (zzz-probe) comes before
        // `local` (local) -- docker < local alphabetically. The
        // initial selection is 0, i.e. `zzz-probe`.
        await waitForBuffer(
          page,
          (text) => text.includes("zzz-probe") && text.includes("Status"),
          { timeoutMs: 10_000 },
        );

        // Move down one row with `j`. The detail pane should flip to
        // show `local` (the only other row).
        await pressKey(page, "j");
        await settle(300);

        await waitForBuffer(
          page,
          (text) => {
            // Detail header is ` <name>  <provider>`. Look for the
            // unique combo that only appears when `local` is selected.
            // `running` is a `local`-only hint (docker probe is
            // stopped), so its presence in the detail pane after the
            // move confirms the selection actually advanced.
            return text.includes("local") && text.includes("running");
          },
          { timeoutMs: 10_000 },
        );

        // Move back up with `k` and confirm we're on zzz-probe again.
        await pressKey(page, "k");
        await settle(300);

        await waitForBuffer(
          page,
          (text) => text.includes("zzz-probe") && text.includes("stopped"),
          { timeoutMs: 10_000 },
        );

        const text = await readTerminal(page);
        expect(text).toContain("zzz-probe");
        expect(text).toContain("stopped");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("pressing s on a running compute arms confirmation without crashing", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });

        await pressKey(page, "4");
        await waitForText(page, "Details", { timeoutMs: 10_000 });
        await waitForText(page, "local", { timeoutMs: 10_000 });

        // Arm the stop confirmation. ComputeTab's useInput path for
        // `s` on a running compute enters useConfirmation.confirm()
        // which sets `pending="stop"` and ALSO pushes "confirm" onto
        // the focus stack (ComputeTab.tsx lines 54-57). Once focus
        // owner != null, App.tsx swaps the bottom bar text to the
        // overlay hints (`Esc:cancel`) and the Compute-tab hint row
        // disappears. We exercise the same code path production uses
        // and assert on what's observable: the row is still there,
        // the tab didn't crash, and the overlay hint text is live.
        await pressKey(page, "s");
        await settle(400);

        const text = await readTerminal(page);
        // Row is still there (confirmation does NOT delete it).
        expect(text).toContain("local");
        // Status stays "running" -- the local provider rejects stop
        // ("Cannot stop the local compute") so the DB row doesn't
        // actually change. A fresh `running` in the detail pane
        // confirms no rogue state change happened.
        expect(text).toContain("running");
        // Focus pushed "confirm": the overlay bar text from
        // getOverlayHints("confirm") replaces the nav bar. That
        // contains `Esc:cancel` (see statusBarHints.tsx). Its
        // presence is the strongest signal that the confirmation
        // path armed correctly without blowing up the tab.
        expect(text).toContain("Esc");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("detail pane shows provider and status for the selected compute", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      runArkCli(
        ["compute", "create", "probe-detail", "--provider", "docker", "--image", "ubuntu:22.04"],
        { arkDir },
      );

      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });

        await pressKey(page, "4");
        await waitForText(page, "Details", { timeoutMs: 10_000 });
        await waitForText(page, "probe-detail", { timeoutMs: 10_000 });

        // TreeList sorts by provider then name. `docker` < `local`
        // alphabetically, so the first (default-selected) row is
        // `probe-detail` (docker provider). ComputeDetail renders:
        //   header:     " probe-detail  docker"
        //   KeyValue:   " Status  stopped"
        // All three strings ("probe-detail", "docker", "stopped")
        // must appear in the buffer when the docker row is selected.
        await waitForBuffer(
          page,
          (text) =>
            text.includes("probe-detail") &&
            text.includes("docker") &&
            text.includes("stopped"),
          { timeoutMs: 10_000 },
        );

        const text = await readTerminal(page);
        expect(text).toContain("probe-detail");
        expect(text).toContain("docker");
        expect(text).toContain("stopped");
        expect(text).toContain("Status");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });
});
