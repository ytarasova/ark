/**
 * Branding smoke tests -- menu label, app name, dock icon.
 *
 * Verifies that main.js's `app.setName("Ark")` and the macOS menu template
 * (first submenu label = "Ark") are wired correctly. These are the most
 * common regressions when bumping Electron (the default "Electron" label
 * sneaks back in unless setName + a leading menu submenu override it).
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

test("app.getName() returns 'Ark'", async () => {
  if (!launched) throw new Error("launch helper did not run");
  const { app } = launched;

  const name = await app.evaluate(({ app }) => app.getName());
  expect(name).toBe("Ark");
});

test("macOS application menu first label is 'Ark'", async () => {
  if (!launched) throw new Error("launch helper did not run");
  const { app } = launched;

  const platform = await app.evaluate(() => process.platform);
  test.skip(platform !== "darwin", "Application menu is macOS-specific");

  const labels = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((i) => i.label) ?? []);

  expect(labels.length).toBeGreaterThan(0);
  // On macOS Electron always prepends an app-name submenu. If the name
  // is "Electron" (default), branding is broken. It must be "Ark".
  expect(labels[0]).toBe("Ark");
});

test("macOS dock is available (soft assertion in dev mode)", async () => {
  if (!launched) throw new Error("launch helper did not run");
  const { app } = launched;

  const platform = await app.evaluate(() => process.platform);
  test.skip(platform !== "darwin", "Dock API is macOS-specific");

  // Electron's dock API has evolved -- older Electron exposed `app.dock` as
  // an object with `getIcon()`, current Electron (33.x) exposes it as a
  // `Dock` instance without a `getIcon` method. What we actually care about
  // is: does the dock exist on macOS? That's the guarantee the packaged
  // build needs (if app.dock is undefined, setIcon/setBadge calls will all
  // throw, and no icon will render).
  //
  // In dev mode (`electron .` pointing at main.js) Electron uses its
  // default dock icon because we haven't called `app.dock.setIcon()`.
  // Packaged builds via electron-builder embed icon.icns into the .app
  // bundle, so Electron auto-picks it up from Info.plist.
  //
  // Set ARK_E2E_PACKAGED=1 when running against a packaged .app if you
  // want a stricter dock-API shape check in the future.
  const dockInfo = await app.evaluate(({ app }) => {
    if (!app.dock) return { present: false } as const;
    return {
      present: true,
      hasIsVisible: typeof app.dock.isVisible === "function",
      hasSetIcon: typeof app.dock.setIcon === "function",
    };
  });

  // app.dock must exist on macOS -- that is the only hard regression.
  expect(dockInfo.present).toBe(true);

  if (process.env.ARK_E2E_PACKAGED === "1") {
    // Packaged build: we need the icon-setter to be callable.
    expect(dockInfo).toMatchObject({ hasSetIcon: true });
  }
});
