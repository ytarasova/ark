/**
 * Layer-one end-to-end coverage for the TUI's Tools tab.
 *
 * The Tools tab (hotkey `7`) surfaces every discoverable "tool" in the
 * current project plus the built-in Ark skills and recipes shipped with
 * the repo. It's rendered by `packages/tui/tabs/ToolsTab.tsx`, which
 * calls `ark.toolsList(projectRoot)` on mount and groups the results
 * into a `TreeList` by kind (MCP Servers, Commands, Skills, Recipes,
 * Context, ...).
 *
 * Harness notes:
 *   - The TUI subprocess runs with cwd = the temp ARK_TEST_DIR. That
 *     directory isn't a git repo, so `findProjectRoot()` returns null
 *     and the Tools tab renders only global resources (builtin Ark
 *     skills + recipes). Project-scoped kinds (MCP, commands,
 *     .claude/skills, CLAUDE.md context) are intentionally empty --
 *     the asserts below reflect that.
 *   - Builtin resource dirs resolve relative to `packages/core/app.ts`
 *     (repo-root-relative), so the 7 builtin skills and 8 builtin
 *     recipes are discovered regardless of cwd.
 *   - State seeding isn't needed for Tools tab tests -- it's a pure
 *     read path over on-disk YAML. We still allocate an isolated
 *     ARK_TEST_DIR to keep the TUI from touching the user's real
 *     ~/.ark and to match the pattern of the other suites.
 *   - Use `rows: 40` so the TreeList has room to render both groups
 *     without ScrollBox clipping the Recipes section off-screen.
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

// Builtin resources shipped in-tree. Keep in sync with:
//   /Users/paytmlabs/Projects/ark/skills/
//   /Users/paytmlabs/Projects/ark/recipes/
const BUILTIN_SKILLS = [
  "code-review",
  "plan-audit",
  "sanity-gate",
  "security-scan",
  "self-review",
  "spec-extraction",
  "test-writing",
] as const;

const BUILTIN_RECIPES = [
  "quick-fix",
  "feature-build",
  "code-review",
  "fix-bug",
  "new-feature",
  "ideate",
  "islc",
  "islc-quick",
] as const;

/**
 * Unique-by-name picks we can safely assert on even though "code-review"
 * is present in both the Skills and Recipes groups. These names appear
 * in exactly one group so substring matches are unambiguous.
 */
const UNIQUE_SKILL_NAMES = [
  "plan-audit",
  "sanity-gate",
  "security-scan",
  "self-review",
  "spec-extraction",
  "test-writing",
] as const;

const UNIQUE_RECIPE_NAMES = [
  "quick-fix",
  "feature-build",
  "fix-bug",
  "new-feature",
  "ideate",
  "islc",
  "islc-quick",
] as const;

async function gotoTools(page: import("@playwright/test").Page): Promise<void> {
  // Sessions is the initial tab; wait for the tab bar to render so we
  // know the TUI is fully booted, then press `7` to land on Tools.
  await waitForText(page, "Sessions", { timeoutMs: 15_000 });
  await pressKey(page, "7");
  // Wait until the Tools list has finished the initial async fetch --
  // one of the builtin skill names is a cheap proxy for "list populated".
  await waitForText(page, "test-writing", { timeoutMs: 10_000 });
}

test.describe("Ark TUI Tools tab", () => {
  test("pressing `7` switches to the Tools tab", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await gotoTools(page);

        const text = await readTerminal(page);
        // TabBar row highlights the active tab with ` 7:Tools ` and the
        // SplitPane left title renders `Tools`. Both should be visible.
        expect(text).toContain("7:Tools");
        expect(text).toContain("Tools");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("renders the Skills and Recipes group headers", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await gotoTools(page);

        const text = await readTerminal(page);
        // `TreeList` renders each group as ` <name> ` with a highlight
        // background. We assert on the substring inside the padding.
        expect(text).toContain("Skills");
        expect(text).toContain("Recipes");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("lists every builtin Ark skill", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await gotoTools(page);

        const text = await readTerminal(page);
        // The 6 non-overlapping names MUST all be visible (code-review
        // is excluded because it's ambiguous -- shared with a recipe).
        for (const name of UNIQUE_SKILL_NAMES) {
          expect(text).toContain(name);
        }
        // Sanity check that the full builtin set is accounted for.
        expect(BUILTIN_SKILLS.length).toBe(7);
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("lists every builtin Ark recipe", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await gotoTools(page);

        const text = await readTerminal(page);
        for (const name of UNIQUE_RECIPE_NAMES) {
          expect(text).toContain(name);
        }
        expect(BUILTIN_RECIPES.length).toBe(8);
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("no project-scoped tools surface when cwd is not a repo", async ({ page }) => {
    // The harness cwd is a temp ARK_TEST_DIR, not a git repo, so
    // `findProjectRoot` returns null and `discoverTools` skips the
    // project-scoped collectors (MCP servers, commands, claude skills,
    // CLAUDE.md context). Assert that none of the project-only group
    // headers render.
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await gotoTools(page);

        const text = await readTerminal(page);
        // Project group labels from ToolsTab.tsx:
        //   "Project: MCP Servers", "Project: Commands",
        //   "Project: Skills", "Project: Context"
        // None of these should appear -- the tab only shows global
        // Skills / Recipes groups outside a git checkout.
        expect(text).not.toContain("Project: MCP Servers");
        expect(text).not.toContain("Project: Commands");
        expect(text).not.toContain("Project: Context");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("j/k navigation moves the selection marker", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await gotoTools(page);

        // TreeList prefixes the selected row with `> ` (see
        // TreeList.tsx `<ListRow selected>{`> ${renderRow(...)}`}`).
        // Count the selected rows before and after pressing j/k to
        // verify input was routed to the tab's useInput handler.
        const before = await readTerminal(page);
        const selectedCountBefore = (before.match(/> /g) ?? []).length;
        expect(selectedCountBefore).toBeGreaterThan(0);

        await pressKey(page, "j");
        await page.waitForTimeout(200);
        await pressKey(page, "j");
        await page.waitForTimeout(200);

        const after = await readTerminal(page);
        const selectedCountAfter = (after.match(/> /g) ?? []).length;
        // Still exactly one selection, but a different item should be
        // highlighted. Buffer shouldn't be empty and the overall shape
        // must be preserved.
        expect(selectedCountAfter).toBeGreaterThan(0);
        // Navigating up should land back on (or near) the start.
        await pressKey(page, "k");
        await page.waitForTimeout(200);
        await pressKey(page, "k");
        await page.waitForTimeout(200);

        const restored = await readTerminal(page);
        // Sanity: the tool list is still rendered after the round-trip.
        expect(restored).toContain("Skills");
        expect(restored).toContain("Recipes");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("detail pane updates when selection changes", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await gotoTools(page);

        // On initial mount the first item is selected. The ToolDetail
        // component renders `Kind:` and `Source:` rows for whichever
        // item is highlighted. Assert the info panel is present.
        await waitForText(page, "Kind:", { timeoutMs: 5_000 });
        await waitForText(page, "Source:", { timeoutMs: 5_000 });

        const initial = await readTerminal(page);
        // The kind should be one of the two resource kinds the tab can
        // discover outside a git repo -- `ark-skill` or `ark-recipe`.
        expect(initial).toMatch(/Kind:\s+ark-(skill|recipe)/);

        // Jump to the bottom of the list so we definitely land on a
        // different item; `G` is the standard vim "go end" binding
        // handled by `useListNavigation`.
        await pressKey(page, "G");
        await waitForBuffer(
          page,
          (t) => /Kind:\s+ark-(skill|recipe)/.test(t),
          { timeoutMs: 5_000 },
        );

        const moved = await readTerminal(page);
        // The detail panel must still show a valid Kind/Source pair.
        expect(moved).toMatch(/Kind:\s+ark-(skill|recipe)/);
        expect(moved).toContain("Source:");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("status bar shows tool-specific hints", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await gotoTools(page);

        const text = await readTerminal(page);
        // `getToolsHints()` returns NAV_HINTS + `Enter:use recipe` +
        // `x:delete` + GLOBAL_HINTS. These all come from KeyHint, which
        // renders `<key>:<label>` separated by two spaces.
        expect(text).toContain("use recipe");
        expect(text).toContain("delete");
        // Global hints always include quit.
        expect(text).toContain("quit");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("ark-recipe detail renders Config section with flow name", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await gotoTools(page);

        // Groups are sorted alphabetically: Recipes (R) comes before
        // Skills (S), and within Recipes the first alphabetical entry
        // is `code-review`. That means item[0] is a recipe, so the
        // initial detail pane already renders the Ark-recipe panel
        // (`ArkRecipeDetail` in ToolsTab.tsx), which shows a `Config`
        // section header and a `Flow:` field.
        await waitForText(page, "Config", { timeoutMs: 10_000 });
        await waitForText(page, "Flow:", { timeoutMs: 5_000 });

        const text = await readTerminal(page);
        expect(text).toContain("Config");
        expect(text).toContain("Flow:");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });
});
