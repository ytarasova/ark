/**
 * Session creation E2E tests.
 *
 * Tests the full new-session flow: navigating to Sessions page, opening
 * the New Session form, filling fields, creating, and verifying the
 * session appears in the list.
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

async function goToSessions() {
  await page.click('nav button:has-text("Sessions")');
  await expect(page.locator("h1")).toContainText("Sessions");
}

// -- Navigate to Sessions page ------------------------------------------------

test("sessions page is accessible from sidebar", async () => {
  await goToSessions();
  await expect(page.locator("h1")).toContainText("Sessions");
});

// -- Open New Session form ----------------------------------------------------

test("clicking New Session button opens the form", async () => {
  await goToSessions();
  await page.click('button:has-text("New Session")');
  await expect(page.locator("text=New Session").first()).toBeVisible({ timeout: 5_000 });
});

// -- Fill and submit the New Session form -------------------------------------

test("create session via form with flow, repo, and task description", async () => {
  await goToSessions();
  await page.click('button:has-text("New Session")');
  await expect(page.locator("text=New Session").first()).toBeVisible({ timeout: 5_000 });

  // Fill in the summary / task description
  const summaryInput = page.locator('textarea[placeholder="What should the agent work on?"]');
  await expect(summaryInput).toBeVisible();
  await summaryInput.fill("Test session from e2e creation spec");

  // Fill in the repo path. Repo is now a combobox-style popover picker:
  // click the trigger to open the popover, type the path in the search
  // input, then press Enter to commit.
  await page.locator('button:has-text("Select repository")').click();
  const repoInput = page.locator('input[placeholder="Type path or search..."]');
  await expect(repoInput).toBeVisible({ timeout: 5_000 });
  await repoInput.fill(ws.env.workdir);
  await repoInput.press("Enter");

  // Submit the form
  await page.click('button:has-text("Start Session")');

  // Verify session appears in the list
  await expect(page.locator("text=Test session from e2e creation spec")).toBeVisible({ timeout: 10_000 });
});

// -- Verify session shows in list with expected state -------------------------

test("newly created session appears with ready/pending status", async () => {
  // Create session via RPC for deterministic status
  const data = await ws.rpc("session/start", {
    summary: "Creation status check",
    repo: ws.env.workdir,
    flow: "bare",
  });
  expect(data.session).toBeTruthy();
  expect(data.session.status).toBe("ready");

  // Reload and verify in UI
  await page.reload();
  await page.waitForSelector("nav", { timeout: 10_000 });
  await goToSessions();

  await expect(page.locator("text=Creation status check")).toBeVisible({ timeout: 10_000 });
});

// -- Multiple sessions can be created sequentially ----------------------------

test("creating multiple sessions populates the list", async () => {
  await ws.rpc("session/start", { summary: "Multi A", repo: ws.env.workdir, flow: "bare" });
  await ws.rpc("session/start", { summary: "Multi B", repo: ws.env.workdir, flow: "bare" });

  await page.reload();
  await page.waitForSelector("nav", { timeout: 10_000 });
  await goToSessions();

  await expect(page.locator("text=Multi A")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("text=Multi B")).toBeVisible({ timeout: 10_000 });
});
