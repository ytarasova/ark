/**
 * Tools page integration-boundary tests.
 *
 * The Tools page reflects on-disk files (skills/, recipes/, mcp-configs/)
 * through the `skill/list` and `recipe/list` RPC handlers. The value
 * worth testing is the disk → Store → RPC → DOM path. Header / nav
 * smoke tests belong in navigation.spec.ts (and already exist there).
 */

import { test, expect, type Page, type Browser } from "@playwright/test";
import { chromium } from "playwright";
import { readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
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

/** Read the names of every yaml/yml file in a builtin dir. */
function builtinNames(dirRelativeToRepo: string): string[] {
  const absDir = resolve(process.cwd(), "..", "..", dirRelativeToRepo);
  if (!existsSync(absDir)) return [];
  return readdirSync(absDir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => f.replace(/\.(yaml|yml)$/, ""));
}

test("skill/list RPC returns every builtin skill file on disk", async () => {
  const onDisk = builtinNames("skills");
  expect(onDisk.length).toBeGreaterThan(0);
  const result = await ws.rpc<{ skills?: Array<{ name: string }>; items?: Array<{ name: string }> }>("skill/list");
  const rows = result.skills ?? result.items ?? [];
  const rpcNames = rows.map((r) => r.name);
  // Every on-disk skill must be reflected in the RPC response.
  for (const name of onDisk) {
    expect(rpcNames).toContain(name);
  }
});

test("recipe/list RPC returns every builtin recipe file on disk", async () => {
  const onDisk = builtinNames("recipes");
  expect(onDisk.length).toBeGreaterThan(0);
  const result = await ws.rpc<{ recipes?: Array<{ name: string }>; items?: Array<{ name: string }> }>("recipe/list");
  const rows = result.recipes ?? result.items ?? [];
  const rpcNames = rows.map((r) => r.name);
  for (const name of onDisk) {
    expect(rpcNames).toContain(name);
  }
});

test("Tools page renders a skill name from skill/list when clicked", async () => {
  // Drives the disk → Store → RPC → DOM path end-to-end. A regression
  // in FileSkillStore, the RPC handler, or the Tools page list rendering
  // surfaces here.
  await page.click('nav button:has-text("Tools")');
  const onDisk = builtinNames("skills");
  // Pick a stable name that isn't also a recipe name to avoid ambiguity.
  const unique = onDisk.filter((n) => !builtinNames("recipes").includes(n));
  expect(unique.length).toBeGreaterThan(0);
  const target = unique[0];
  // The page should render the name somewhere in the document body.
  await expect(page.locator(`text=${target}`).first()).toBeVisible({ timeout: 10_000 });
});
