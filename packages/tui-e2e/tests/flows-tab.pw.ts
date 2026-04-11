/**
 * Layer-one end-to-end tests for the Ark TUI's Flows tab.
 *
 * The Flows tab is a pure browse-and-inspect surface backed by the
 * `FlowStore` three-tier resolution (builtin > global > project). No
 * seeding is required -- the 9 builtin flows in `flows/definitions/`
 * are always present. These tests assert on what the TUI actually
 * renders in the xterm buffer via `readTerminal` / `waitForText`, the
 * same pattern used by `sessions.pw.ts` and `session-crud.pw.ts`.
 *
 * Constraints (mirroring the sibling ports):
 *   - Seed-before-boot pattern with `mkTempArkDir` and `rows: 40` so
 *     the detail pane always has room for the `default` flow's full
 *     9-stage SDLC listing without clipping.
 *   - Input is routed through `pressKey(page, ...)` which goes through
 *     xterm's paste pipeline -- the only reliable way to reach the
 *     pty's stdin without relying on Playwright keyboard focus.
 *   - No in-process AppContext: the TUI runs in its own pty subprocess
 *     with its own SQLite DB, so all assertions are on the rendered
 *     terminal buffer, not on app state.
 *
 * Layer-one use cases covered (8 tests):
 *   1. Pressing `3` navigates to the Flows tab and renders the header.
 *   2. Builtin flows appear in the left pane list.
 *   3. Selecting a flow shows its detail pane (stages section).
 *   4. Pressing `j` / `k` updates the list selection cursor.
 *   5. The `bare` flow detail pane shows its single `work` stage.
 *   6. The `default` flow detail pane shows the full 9-stage pipeline.
 *   7. The Flows status bar shows its navigation + tab hints.
 *   8. Pressing `1` returns focus to Sessions cleanly.
 */

import { test, expect } from "@playwright/test";
import { rmSync } from "node:fs";
import {
  startHarness,
  waitForText,
  waitForBuffer,
  readTerminal,
  pressKey,
  mkTempArkDir,
  type Harness,
} from "../harness.js";

// ── Small helper: navigate to the Flows tab and wait for it to render ────────
//
// The Flows left pane title is literally "Flows" (same string as the
// tab-bar label, but that's fine -- its presence tells us the tab
// switched). Wait for "stages" which only appears once a flow row has
// been rendered in the left pane -- that signals the list populated.

async function openFlowsTab(page: import("@playwright/test").Page): Promise<void> {
  await pressKey(page, "3");
  await waitForText(page, "Flows", { timeoutMs: 10_000 });
  // The TreeList renders each row as `  <name> <N> stages`, so
  // waiting on the literal word "stages" confirms at least one flow
  // row landed in the buffer (and we aren't just matching the tab-bar
  // label).
  await waitForText(page, "stages", { timeoutMs: 10_000 });
}

// Small async settle between keystrokes, matching the sibling tests.
async function settle(ms = 200): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ── Press `j` until the terminal buffer matches the target predicate ─────────
//
// The filesystem order of builtin flows is not alphabetical -- the
// FlowStore uses `readdirSync` which returns directory entries in
// whatever order the OS yields. On macOS / APFS this is insertion
// order, on other filesystems it varies. So we can't assume `bare`
// (or any specific flow) is the preselected row.
//
// This helper presses `j` up to `maxPresses` times, waiting for the
// predicate to match after each press. Returns as soon as the target
// is in the buffer. Fails loudly if the whole list was traversed.

async function pressJUntil(
  page: import("@playwright/test").Page,
  predicate: (text: string) => boolean,
  opts: { maxPresses?: number; settleMs?: number } = {},
): Promise<void> {
  const maxPresses = opts.maxPresses ?? 12;
  const settleMs = opts.settleMs ?? 150;
  // Check before pressing -- maybe the target is already selected.
  if (predicate(await readTerminal(page))) return;
  for (let i = 0; i < maxPresses; i++) {
    await pressKey(page, "j");
    await settle(settleMs);
    if (predicate(await readTerminal(page))) return;
  }
  const dump = await readTerminal(page);
  throw new Error(
    `pressJUntil: predicate never matched after ${maxPresses} presses\n` +
      `last terminal snapshot:\n${dump}`,
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe("Ark TUI flows tab", () => {
  test("pressing `3` switches to the Flows tab", async ({ page }) => {
    const arkDir = mkTempArkDir();
    let harness: Harness | null = null;
    try {
      harness = await startHarness({ arkDir, rows: 40 });
      await page.goto(harness.pageUrl);
      await waitForText(page, "Sessions", { timeoutMs: 15_000 });

      await openFlowsTab(page);

      const text = await readTerminal(page);
      expect(text).toContain("Flows");
      // The left pane uses `stages` as a suffix on every row -- if
      // flows rendered, the word must be present somewhere.
      expect(text).toMatch(/\d+\s+stages/);
    } finally {
      if (harness) await harness.stop();
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("builtin flows bare / default / quick appear in the list", async ({ page }) => {
    const arkDir = mkTempArkDir();
    let harness: Harness | null = null;
    try {
      harness = await startHarness({ arkDir, rows: 40 });
      await page.goto(harness.pageUrl);
      await waitForText(page, "Sessions", { timeoutMs: 15_000 });

      await openFlowsTab(page);

      // Wait for all three well-known builtins to land in the list.
      // They come from `flows/definitions/{bare,default,quick}.yaml`
      // which ship with the repo, so no seeding is required.
      await waitForText(page, "bare", { timeoutMs: 10_000 });
      await waitForText(page, "default", { timeoutMs: 10_000 });
      await waitForText(page, "quick", { timeoutMs: 10_000 });

      const text = await readTerminal(page);
      expect(text).toContain("bare");
      expect(text).toContain("default");
      expect(text).toContain("quick");
    } finally {
      if (harness) await harness.stop();
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("selecting a flow renders a Stages section in the detail pane", async ({ page }) => {
    const arkDir = mkTempArkDir();
    let harness: Harness | null = null;
    try {
      harness = await startHarness({ arkDir, rows: 40 });
      await page.goto(harness.pageUrl);
      await waitForText(page, "Sessions", { timeoutMs: 15_000 });

      await openFlowsTab(page);

      // The TreeList preselects the first item in the sorted list.
      // FlowStore sorts alphabetically, so `bare` is first -- its
      // detail loads asynchronously on selection change. Wait for
      // the "Stages" section header rendered by FlowDetail.
      await waitForText(page, "Stages", { timeoutMs: 10_000 });

      const text = await readTerminal(page);
      expect(text).toContain("Stages");
      // Stage rows render with `gate=<value>` suffix -- a reliable
      // fingerprint that the detail rendered a stage, not just a
      // "Loading..." placeholder.
      expect(text).toMatch(/gate=/);
    } finally {
      if (harness) await harness.stop();
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("j / k update the selection cursor in the flows list", async ({ page }) => {
    const arkDir = mkTempArkDir();
    let harness: Harness | null = null;
    try {
      harness = await startHarness({ arkDir, rows: 40 });
      await page.goto(harness.pageUrl);
      await waitForText(page, "Sessions", { timeoutMs: 15_000 });

      await openFlowsTab(page);
      // Wait for the preselected first flow's detail to load so we
      // have a stable starting point.
      await waitForText(page, "Stages", { timeoutMs: 10_000 });

      // Capture the detail pane's current flow name header. The
      // TreeList preselection is the alphabetically-first flow, and
      // the detail renders ` <name>` as a bold first line. We'll
      // assert the header changes after pressing `j`.
      const before = await readTerminal(page);

      // Press `j` a few times -- with 9 builtin flows in the list, a
      // couple of `j` presses is guaranteed to move the selection to
      // a different row whose detail pane then loads.
      await pressKey(page, "j");
      await settle(150);
      await pressKey(page, "j");
      await settle(150);

      // After moving, the FlowDetail useEffect reloads the flow
      // definition -- wait for the buffer to transition out of the
      // "before" snapshot by looking for a different gate signature.
      // At minimum we expect the buffer to differ because the row
      // cursor (`> `) moved and/or a different flow's stages rendered.
      await waitForBuffer(
        page,
        (text) => text !== before,
        { timeoutMs: 5_000 },
      );

      const after = await readTerminal(page);
      // Still on the Flows tab (did not accidentally navigate).
      expect(after).toContain("Flows");
      expect(after).toContain("Stages");

      // Press `k` to move back up -- should not error, buffer should
      // still contain the stages section of whichever flow is now
      // selected.
      await pressKey(page, "k");
      await settle(200);
      const final = await readTerminal(page);
      expect(final).toContain("Stages");
    } finally {
      if (harness) await harness.stop();
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("bare flow detail shows the single `work` stage", async ({ page }) => {
    const arkDir = mkTempArkDir();
    let harness: Harness | null = null;
    try {
      harness = await startHarness({ arkDir, rows: 40 });
      await page.goto(harness.pageUrl);
      await waitForText(page, "Sessions", { timeoutMs: 15_000 });

      await openFlowsTab(page);

      // Builtin flows are NOT sorted alphabetically in the TUI -- the
      // left pane renders them in filesystem readdir order, which
      // varies per platform. Navigate with `j` until the detail pane
      // shows `bare`'s unique signature rather than assuming position.
      //
      // `bare` has exactly one stage (`work`) with `[agent:worker]`
      // and `gate=manual`. That triple is distinctive -- only `bare`
      // pairs an agent:worker stage with manual gating among the 9
      // builtins. We look for the combined substring to avoid partial
      // matches from another flow whose buffer happens to still be in
      // the xterm viewport.
      await pressJUntil(page, (text) =>
        text.includes("1. work") &&
        text.includes("[agent:worker]") &&
        text.includes("gate=manual"),
      );

      const text = await readTerminal(page);
      expect(text).toContain("1. work");
      expect(text).toContain("[agent:worker]");
      expect(text).toContain("gate=manual");
    } finally {
      if (harness) await harness.stop();
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("default flow detail shows the full multi-stage SDLC pipeline", async ({ page }) => {
    const arkDir = mkTempArkDir();
    let harness: Harness | null = null;
    try {
      harness = await startHarness({ arkDir, rows: 40 });
      await page.goto(harness.pageUrl);
      await waitForText(page, "Sessions", { timeoutMs: 15_000 });

      await openFlowsTab(page);
      // Wait for the flow list to be populated before we start
      // moving the cursor.
      await waitForText(page, "default", { timeoutMs: 10_000 });

      // Navigate to the `default` flow row. As with `bare`, flow
      // ordering is filesystem-dependent, so step through with `j`
      // until the detail pane shows `default`'s unique signature.
      //
      // The `default` flow is the only builtin whose first stage is
      // `ticket-intake` -- that agent tag is a hard fingerprint.
      await pressJUntil(page, (text) =>
        text.includes("[agent:ticket-intake]") &&
        text.includes("1. intake"),
      );

      const text = await readTerminal(page);
      // `default` has 9 stages: intake -> plan -> audit -> implement
      // -> verify -> pr -> review -> close -> retro. The detail
      // panel is tall enough (rows: 40) to render all 9 even with
      // the tab bar and status rows on top and bottom. Match at
      // least three distinct stages spanning the pipeline to prove
      // we're looking at the multi-stage view, plus the first-stage
      // agent tag as the anchoring fingerprint.
      expect(text).toContain("[agent:ticket-intake]");
      expect(text).toContain("1. intake");
      // Middle-of-pipeline stages. Look for the type tags which are
      // less likely to collide with another flow's content than
      // bare stage names.
      expect(text).toContain("[agent:spec-planner]");
      expect(text).toContain("[agent:implementer]");
      expect(text).toContain("[agent:verifier]");
      // A late-pipeline stage to prove the detail panel rendered
      // more than just the first few rows. `default` is the only
      // builtin that references the `closer` agent.
      expect(text).toContain("[agent:closer]");
    } finally {
      if (harness) await harness.stop();
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("status bar shows flows-tab hints when Flows is active", async ({ page }) => {
    const arkDir = mkTempArkDir();
    let harness: Harness | null = null;
    try {
      harness = await startHarness({ arkDir, rows: 40 });
      await page.goto(harness.pageUrl);
      await waitForText(page, "Sessions", { timeoutMs: 15_000 });

      await openFlowsTab(page);

      // `getFlowsHints()` (in FlowsTab.tsx) emits:
      //   NAV_HINTS (j/k, f/b, g/G) + Tab:detail + GLOBAL_HINTS (?, q)
      // Those hints get flattened into the StatusBar's bottom row
      // and should all be present in the buffer once the tab renders.
      const text = await readTerminal(page);
      expect(text).toContain("j/k");
      expect(text).toContain("move");
      expect(text).toContain("Tab");
      expect(text).toContain("detail");
      expect(text).toContain("quit");
    } finally {
      if (harness) await harness.stop();
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("pressing `1` returns from Flows to Sessions cleanly", async ({ page }) => {
    const arkDir = mkTempArkDir();
    let harness: Harness | null = null;
    try {
      harness = await startHarness({ arkDir, rows: 40 });
      await page.goto(harness.pageUrl);
      await waitForText(page, "Sessions", { timeoutMs: 15_000 });

      // Navigate to Flows first, confirm we're there by waiting for
      // flows-specific content.
      await openFlowsTab(page);
      await waitForText(page, "Stages", { timeoutMs: 10_000 });

      // Press `1` to go back to Sessions. SessionDetail's empty-state
      // "Quick Start" onboarding view renders a literal CLI command
      // only when no session is selected -- which is exactly what
      // happens on an empty arkDir. That onboarding string is unique
      // to SessionsTab's right pane and is a reliable "Sessions body
      // mounted" signal, whereas the "Sessions" / "0 sessions"
      // strings appear even while on Flows (tab bar + status footer).
      await pressKey(page, "1");
      await waitForText(page, "ark session start --repo", {
        timeoutMs: 5_000,
      });

      const text = await readTerminal(page);
      expect(text).toContain("ark session start --repo");
      // The Sessions status filter row ("0 sessions" in the footer)
      // is also present -- a weaker signal (present regardless of
      // active tab) but combined with the onboarding marker above
      // it confirms SessionsTab is mounted.
      expect(text).toMatch(/\d+ sessions?/);
    } finally {
      if (harness) await harness.stop();
      rmSync(arkDir, { recursive: true, force: true });
    }
  });
});
