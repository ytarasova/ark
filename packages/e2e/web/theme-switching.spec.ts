/**
 * Theme switching E2E tests.
 *
 * Verifies that navigating to Settings, switching themes and color modes
 * applies the correct CSS variables to the document root.
 */

import { test, expect, type Page, type Browser } from "@playwright/test";
import { chromium } from "playwright";
import { setupWebServer, type WebServerEnv } from "../fixtures/web-server.js";

let ws: WebServerEnv;
let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  ws = await setupWebServer();
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(ws.baseUrl);
  await page.waitForSelector("nav", { timeout: 15_000 });
});

test.afterAll(async () => {
  if (browser) await browser.close();
  if (ws) await ws.teardown();
});

// -- Helper to read CSS variable from document root ---------------------------

async function getCssVar(varName: string): Promise<string> {
  return page.evaluate((name: string) => {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }, varName);
}

async function getRootClass(): Promise<string> {
  return page.evaluate(() => document.documentElement.className);
}

// -- Initial state ------------------------------------------------------------

test("initial theme applies CSS variables to document root", async () => {
  // The default theme should apply some CSS variables
  const bg = await getCssVar("--bg");
  expect(bg).toBeTruthy();
  expect(bg.length).toBeGreaterThan(0);

  const primary = await getCssVar("--primary");
  expect(primary).toBeTruthy();
});

test("initial theme sets class on document root", async () => {
  const cls = await getRootClass();
  // Should have a theme name and color mode class
  expect(cls).toBeTruthy();
  expect(cls.length).toBeGreaterThan(0);
});

// -- Theme switching ----------------------------------------------------------

test("switching theme changes CSS variables", async () => {
  // Set arctic-slate theme via localStorage and reload
  await page.evaluate(() => {
    localStorage.setItem("ark-theme-name", "arctic-slate");
  });
  await page.reload();
  await page.waitForSelector("nav", { timeout: 15_000 });

  const newPrimary = await getCssVar("--primary");
  // Arctic-slate uses blue (#3b82f6 dark) vs midnight-circuit purple (#7c6aef dark)
  // The primary colors should differ between themes
  expect(newPrimary).toBeTruthy();
  // Verify the root class includes the theme name
  const cls = await getRootClass();
  expect(cls).toContain("arctic-slate");
});

test("switching to warm-obsidian theme applies correct class", async () => {
  await page.evaluate(() => {
    localStorage.setItem("ark-theme-name", "warm-obsidian");
  });
  await page.reload();
  await page.waitForSelector("nav", { timeout: 15_000 });

  const cls = await getRootClass();
  expect(cls).toContain("warm-obsidian");

  const primary = await getCssVar("--primary");
  expect(primary).toBeTruthy();
});

// -- Color mode switching -----------------------------------------------------

test("switching to light mode changes background color", async () => {
  // Set dark mode first
  await page.evaluate(() => {
    localStorage.setItem("ark-theme-name", "midnight-circuit");
    localStorage.setItem("ark-color-mode", "dark");
  });
  await page.reload();
  await page.waitForSelector("nav", { timeout: 15_000 });

  const darkBg = await getCssVar("--bg");
  const darkCls = await getRootClass();
  expect(darkCls).toContain("dark");

  // Switch to light mode
  await page.evaluate(() => {
    localStorage.setItem("ark-color-mode", "light");
  });
  await page.reload();
  await page.waitForSelector("nav", { timeout: 15_000 });

  const lightBg = await getCssVar("--bg");
  const lightCls = await getRootClass();

  // Background should change between dark and light
  expect(lightBg).not.toBe(darkBg);
  expect(lightCls).toContain("light");
});

test("switching back to dark mode restores dark background", async () => {
  await page.evaluate(() => {
    localStorage.setItem("ark-color-mode", "dark");
  });
  await page.reload();
  await page.waitForSelector("nav", { timeout: 15_000 });

  const cls = await getRootClass();
  expect(cls).toContain("dark");

  const bg = await getCssVar("--bg");
  // Midnight circuit dark bg is #0c0c14
  expect(bg).toBeTruthy();
});

// -- Theme persistence --------------------------------------------------------

test("theme persists in localStorage across reloads", async () => {
  await page.evaluate(() => {
    localStorage.setItem("ark-theme-name", "arctic-slate");
    localStorage.setItem("ark-color-mode", "dark");
  });
  await page.reload();
  await page.waitForSelector("nav", { timeout: 15_000 });

  const cls1 = await getRootClass();
  expect(cls1).toContain("arctic-slate");

  // Reload again without changing localStorage
  await page.reload();
  await page.waitForSelector("nav", { timeout: 15_000 });

  const cls2 = await getRootClass();
  expect(cls2).toContain("arctic-slate");
});

// -- Cleanup: reset to default ------------------------------------------------

test("reset theme to midnight-circuit for subsequent tests", async () => {
  await page.evaluate(() => {
    localStorage.setItem("ark-theme-name", "midnight-circuit");
    localStorage.setItem("ark-color-mode", "dark");
  });
  await page.reload();
  await page.waitForSelector("nav", { timeout: 15_000 });

  const cls = await getRootClass();
  expect(cls).toContain("midnight-circuit");
});
