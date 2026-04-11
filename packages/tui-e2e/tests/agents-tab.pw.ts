/**
 * Layer-one end-to-end tests for the Ark TUI's Agents tab.
 *
 * These tests boot `ark tui` through the browser harness (xterm.js in a
 * headless Chromium), switch to the Agents tab by pressing `2`, and
 * assert on the rendered terminal buffer. No in-process AppContext --
 * we only observe what the TUI actually paints.
 *
 * Seed-before-boot note: the Agents tab reads from the file-backed
 * AgentStore / RuntimeStore, which pulls from the builtin `agents/` and
 * `runtimes/` directories relative to the repo root. The CLI spawns
 * with cwd = arkDir (a fresh temp dir) so the *project* tier resolves
 * to nothing; *builtin* tier still shows up because it ships with the
 * binary. We don't need to seed anything on disk to see the builtin
 * roles and runtimes.
 *
 * Critical constraints:
 *   - SQLite locks if we try to mutate after the TUI opens the DB, so
 *     any CLI seeding must happen BEFORE `startHarness()`.
 *   - `mkTempArkDir()` + manual cleanup in outer finally. Don't rely on
 *     harness ownership: caller-allocated arkDir is NOT deleted by
 *     `harness.stop()`.
 *   - Taller viewport (rows: 40) so the detail pane + status bar fit.
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
} from "../harness.js";

/** Switch from the default Sessions tab to the Agents tab. */
async function gotoAgentsTab(page: import("@playwright/test").Page): Promise<void> {
  // Wait for first paint (Sessions tab).
  await waitForText(page, "Sessions", { timeoutMs: 15_000 });
  // Press `2` to switch tabs (see packages/tui/App.tsx input handler).
  await pressKey(page, "2");
  // The Agents left-pane header title is literally "Agents". Wait until
  // a builtin agent role shows up to confirm the tab's data has loaded.
  // `implementer` is a core builtin and should always be present.
  await waitForText(page, "implementer", { timeoutMs: 10_000 });
}

test.describe("Ark TUI agents tab", () => {
  test("switching to Agents tab renders the header", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await gotoAgentsTab(page);

        const text = await readTerminal(page);
        // The tab-bar label "Agents" is always rendered; the left pane
        // title is also "Agents". Either proves we made it onto the tab.
        expect(text).toContain("Agents");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("builtin agent roles appear in the list", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await gotoAgentsTab(page);

        const text = await readTerminal(page);
        // Twelve builtin agents live in /agents/*.yaml. We assert on a
        // representative subset that all ship in the binary. At least 3
        // of these names must be visible in the rendered buffer.
        const candidates = [
          "closer",
          "documenter",
          "implementer",
          "plan-auditor",
          "planner",
          "retro",
          "reviewer",
          "spec-planner",
          "task-implementer",
          "ticket-intake",
          "verifier",
          "worker",
        ];
        const found = candidates.filter((name) => text.includes(name));
        expect(found.length).toBeGreaterThanOrEqual(3);
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("runtimes list shows builtin runtime entries", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await gotoAgentsTab(page);

        // The Runtimes group populates asynchronously via
        // `ark.runtimeList()` (useEffect in AgentsTab). Wait for the
        // group header + at least one builtin runtime row.
        await waitForText(page, "Runtimes", { timeoutMs: 10_000 });
        await waitForBuffer(
          page,
          (text) => {
            const needles = ["claude", "codex", "gemini"];
            return needles.some((n) => text.includes(n));
          },
          { timeoutMs: 10_000 },
        );

        const text = await readTerminal(page);
        expect(text).toContain("Runtimes");
        // At least one of the shipped runtimes should appear.
        const runtimeNames = ["claude", "claude-max", "codex", "gemini", "goose"];
        const foundRuntimes = runtimeNames.filter((n) => text.includes(n));
        expect(foundRuntimes.length).toBeGreaterThanOrEqual(1);
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("detail pane shows runtime / model / max turns config", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await gotoAgentsTab(page);

        // The list is sorted alphabetically within the "Roles" group,
        // so the first selected row is "closer". The detail panel
        // renders the Config section with these exact labels (see
        // AgentDetail in AgentsTab.tsx):
        //   Source: ... / Runtime: ... / Model: ... / Max turns: ... /
        //   Permission: ...
        await waitForText(page, "Runtime:", { timeoutMs: 10_000 });

        const text = await readTerminal(page);
        // All four Config labels should be rendered. These are stable
        // TUI copy that AgentDetail writes for every selected role.
        expect(text).toContain("Runtime:");
        expect(text).toContain("Model:");
        expect(text).toContain("Max turns:");
        expect(text).toContain("Permission:");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("detail pane shows a Tools section for the selected agent", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await gotoAgentsTab(page);

        // The list loads async (Ink shows "Loading..." in the tab bar
        // while agents are read). Wait for at least one known agent row
        // to appear before checking the detail pane, otherwise nothing
        // is selected and the detail pane stays empty.
        await waitForText(page, "closer", { timeoutMs: 15_000 });

        // Every builtin role declares a `tools:` list in its yaml, so
        // the detail pane should render the `Tools (<count>)` section
        // header (see AgentDetail sections array).
        await waitForText(page, /Tools \(\d+\)/, { timeoutMs: 15_000 });

        const text = await readTerminal(page);
        expect(text).toMatch(/Tools \(\d+\)/);
        // At least one of the common Claude tools should appear in the
        // detail pane list body. implementer declares Bash / Read /
        // Write / Edit / Glob / Grep / WebSearch.
        const anyTool = ["Bash", "Read", "Write", "Edit", "Glob", "Grep"].some(
          (t) => text.includes(t),
        );
        expect(anyTool).toBe(true);
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("detail pane shows MCP Servers, Skills, and Context sections", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await gotoAgentsTab(page);

        // AgentDetail always renders these section headers (with a
        // count, even if zero). They're load-bearing TUI copy.
        await waitForBuffer(
          page,
          (text) =>
            /MCP Servers \(\d+\)/.test(text) &&
            /Skills \(\d+\)/.test(text) &&
            /Context \(\d+\)/.test(text),
          { timeoutMs: 10_000 },
        );

        const text = await readTerminal(page);
        expect(text).toMatch(/MCP Servers \(\d+\)/);
        expect(text).toMatch(/Skills \(\d+\)/);
        expect(text).toMatch(/Context \(\d+\)/);
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("j/k navigation moves the selection to another agent", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await gotoAgentsTab(page);

        // Wait for the detail pane to render initial config. On first
        // load, `closer` is the selected row (roles are sorted alpha),
        // so "closer" should appear both in the list AND as the detail
        // pane bold title.
        await waitForText(page, "Runtime:", { timeoutMs: 10_000 });

        // Grab a snapshot so we can detect change after moving selection.
        const before = await readTerminal(page);

        // Press `j` five times to advance selection well past `closer`.
        for (let i = 0; i < 5; i++) {
          await pressKey(page, "j");
          await page.waitForTimeout(80);
        }

        // Wait until the buffer differs from the initial snapshot --
        // the detail pane re-renders with the newly-selected agent's
        // name / description / tools. The exact new selection depends
        // on how many builtin roles are present, which is stable but
        // we don't hard-code the index here.
        await waitForBuffer(
          page,
          (text) => text !== before && text.includes("Runtime:"),
          { timeoutMs: 10_000 },
        );

        const after = await readTerminal(page);
        // Sanity: still on the Agents tab and detail pane still shows
        // Config labels (so navigation didn't crash the tab).
        expect(after).toContain("Runtime:");
        expect(after).toContain("Model:");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("Tab key toggles pane focus without crashing the tab", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await gotoAgentsTab(page);

        // Record that the detail pane is painting first.
        await waitForText(page, "Runtime:", { timeoutMs: 10_000 });

        // Tab flips the active pane left <-> right. The Agents tab
        // shouldn't crash or lose content when the right pane becomes
        // active. Press Tab twice so we end up back on the left pane,
        // which is the default state the other assertions expect.
        await pressKey(page, "Tab");
        await page.waitForTimeout(150);
        await pressKey(page, "Tab");
        await page.waitForTimeout(150);

        const text = await readTerminal(page);
        // Still showing the Agents left pane title + detail Config.
        expect(text).toContain("Agents");
        expect(text).toContain("Runtime:");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("status / hint bar shows Agents-tab shortcuts", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await gotoAgentsTab(page);

        const text = await readTerminal(page);
        // The bottom hint row always has q:quit (global hint), and the
        // Agents tab's `getAgentsHints()` adds n:new, e:edit, c:copy,
        // x:delete. Playwright-level we're just looking for these
        // substrings anywhere in the buffer -- enough to prove the
        // status bar is wired for the Agents tab.
        expect(text).toContain("quit");
        const tabHints = ["n:new", "e:edit", "c:copy", "x:delete"];
        const foundHints = tabHints.filter((h) => text.includes(h));
        // At least two of the four should be visible. If fewer than
        // two are present, the hint bar isn't rendering the Agents tab
        // hints at all.
        expect(foundHints.length).toBeGreaterThanOrEqual(2);
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("ArrowDown navigation also moves the selection", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await gotoAgentsTab(page);

        await waitForText(page, "Runtime:", { timeoutMs: 10_000 });
        const before = await readTerminal(page);

        // useListNavigation handles both j/k AND ArrowDown/ArrowUp.
        // Press ArrowDown a few times to cover the alternative path.
        for (let i = 0; i < 3; i++) {
          await pressKey(page, "ArrowDown");
          await page.waitForTimeout(80);
        }

        await waitForBuffer(
          page,
          (text) => text !== before && text.includes("Runtime:"),
          { timeoutMs: 10_000 },
        );
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });
});
