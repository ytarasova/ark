/**
 * CLI install menu smoke test.
 *
 * Verifies that the "Install CLI Tools..." menu item exists in the
 * application menu. Does NOT actually run the install (would require
 * sudo/admin privileges), just asserts the menu entry is present.
 *
 * On macOS: the item should be in the first (app name) submenu.
 * On Linux/Windows: the item should be in the "Tools" submenu.
 */

import { test, expect } from "@playwright/test";
import { launchArk, closeArk, type LaunchedArk } from "./helpers/electron.js";

let launched: LaunchedArk | undefined;

test.beforeEach(async () => {
  launched = await launchArk();
});

test.afterEach(async () => {
  await closeArk(launched);
  launched = undefined;
});

test("'Install CLI Tools...' menu item exists", async () => {
  if (!launched) throw new Error("launch helper did not run");
  const { app } = launched;

  const platform = await app.evaluate(() => process.platform);

  // Walk the menu tree and collect all submenu labels
  const allLabels = await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    if (!menu) return [];
    const labels: string[] = [];
    for (const item of menu.items) {
      if (item.submenu) {
        for (const sub of item.submenu.items) {
          if (sub.label) labels.push(sub.label);
        }
      }
    }
    return labels;
  });

  expect(allLabels).toContain("Install CLI Tools...");

  // On macOS, it should be under the app menu (first menu)
  if (platform === "darwin") {
    const appMenuLabels = await app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu();
      if (!menu || !menu.items[0]?.submenu) return [];
      return menu.items[0].submenu.items.map((i) => i.label);
    });
    expect(appMenuLabels).toContain("Install CLI Tools...");
  }

  // On non-macOS, it should be under "Tools" menu
  if (platform !== "darwin") {
    const toolsMenu = await app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu();
      if (!menu) return [];
      const tools = menu.items.find((i) => i.label === "Tools");
      if (!tools?.submenu) return [];
      return tools.submenu.items.map((i) => i.label);
    });
    expect(toolsMenu).toContain("Install CLI Tools...");
  }
});
