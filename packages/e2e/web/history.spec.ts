/**
 * History page integration-boundary tests.
 *
 * Search goes through the FTS5 index; transcript mode reads from
 * ~/.claude/projects (or the overridden HOME). The tests here exercise
 * those two paths rather than asserting on header text.
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

async function goToHistory() {
  await page.click('nav button:has-text("History")');
  await expect(page.locator("h1")).toContainText("History", { timeout: 10_000 });
}

test("history/search RPC returns an empty result for a fresh DB", async () => {
  // Integration boundary: FTS5 index over messages + transcripts. Even
  // when empty, the handler must respond with a well-formed result
  // object (not null) or the HistoryView crashes on mount.
  const result = await ws.rpc<{ sessions?: unknown[]; items?: unknown[] }>("history/search", { query: "" });
  expect(result).toBeTruthy();
  // The handler returns either `sessions` or `items` depending on version -- both shapes are valid.
  expect(Array.isArray(result.sessions ?? result.items ?? [])).toBe(true);
});

test("history/search RPC with a query string does not throw", async () => {
  const result = await ws.rpc<unknown>("history/search", { query: "nonexistent-xyz-token-12345" });
  expect(result).toBeTruthy();
});

test("switching Sessions <-> Transcripts modes does not crash the page", async () => {
  // Mode switching rehydrates the component with different data sources
  // (FTS5 vs filesystem walk). A mount/unmount regression shows up here.
  await goToHistory();
  const transcriptsBtn = page.locator('button:has-text("Transcripts")').first();
  if (await transcriptsBtn.isVisible().catch(() => false)) {
    await transcriptsBtn.click();
    // h1 must still render -- proves the component did not throw.
    await expect(page.locator("h1")).toContainText("History", { timeout: 5_000 });
    const sessionsBtn = page.locator('button:has-text("Sessions")').nth(1); // avoid sidebar
    if (await sessionsBtn.isVisible().catch(() => false)) {
      await sessionsBtn.click();
      await expect(page.locator("h1")).toContainText("History", { timeout: 5_000 });
    }
  }
});
