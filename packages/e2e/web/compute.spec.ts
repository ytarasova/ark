/**
 * Compute page E2E tests.
 *
 * Tests that the Compute page renders, compute targets can be created
 * via API and verified in the UI, and compute targets can be deleted.
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

async function goToCompute() {
  await page.click('nav button:has-text("Compute")');
  await expect(page.locator("h1")).toContainText("Compute");
}

// -- Compute page rendering ---------------------------------------------------

test("compute page shows title and New Compute button", async () => {
  await goToCompute();
  await expect(page.locator("h1")).toContainText("Compute");
  await expect(page.locator('button:has-text("New Compute")')).toBeVisible();
});

test("compute API returns array", async () => {
  const res = await fetch(`${ws.baseUrl}/api/compute`);
  expect(res.ok).toBe(true);
  const data = await res.json();
  expect(Array.isArray(data)).toBe(true);
});

// -- Create compute via API and verify in UI ----------------------------------

test("create compute target via API and verify in UI", async () => {
  // Create a compute target via API
  const createRes = await fetch(`${ws.baseUrl}/api/compute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "e2e-test-compute", provider: "local", config: {} }),
  });
  expect(createRes.ok).toBe(true);
  const createData = await createRes.json();
  expect(createData.ok).toBe(true);

  // Reload and go to Compute page
  await page.reload();
  await page.waitForSelector("nav", { timeout: 10_000 });
  await goToCompute();

  // The compute target should appear in the list
  await expect(page.locator("text=e2e-test-compute")).toBeVisible({ timeout: 10_000 });

  // Should show "local" provider badge
  await expect(page.locator("text=local").first()).toBeVisible();
});

test("click compute target shows detail panel", async () => {
  await goToCompute();

  // Click on the compute target we created
  await page.locator("text=e2e-test-compute").click();

  // Detail panel should show Details section
  await expect(page.locator("text=Details").first()).toBeVisible({ timeout: 5_000 });

  // Should show Provider field with "local" value
  await expect(page.locator("text=Provider").first()).toBeVisible();
});

// -- Delete compute via API and verify removed from UI ------------------------

test("delete compute target via API and verify removal", async () => {
  // Delete via API
  const deleteRes = await fetch(`${ws.baseUrl}/api/compute/e2e-test-compute/delete`, {
    method: "POST",
  });
  expect(deleteRes.ok).toBe(true);

  // Reload and verify the compute target is gone
  await page.reload();
  await page.waitForSelector("nav", { timeout: 10_000 });
  await goToCompute();

  // The compute target should no longer appear
  await expect(page.locator("text=e2e-test-compute")).not.toBeVisible({ timeout: 5_000 });
});

// -- Create compute via New Compute modal (UI) --------------------------------

test("create compute via New Compute modal", async () => {
  await goToCompute();

  // Click New Compute button
  await page.click('button:has-text("New Compute")');

  // The modal should open with title "New Compute Target"
  await expect(page.locator("text=New Compute Target")).toBeVisible({ timeout: 5_000 });

  // Fill in name
  const nameInput = page.locator('input[placeholder="my-compute"]');
  await expect(nameInput).toBeVisible();
  await nameInput.fill("e2e-ui-compute");

  // Provider defaults to "local" -- leave as-is

  // Submit
  await page.click('button:has-text("Create Compute")');

  // Wait for the compute target to appear (may need reload)
  await page.waitForTimeout(1_000);
  await page.reload();
  await page.waitForSelector("nav", { timeout: 10_000 });
  await goToCompute();
  await expect(page.locator("text=e2e-ui-compute")).toBeVisible({ timeout: 10_000 });

  // Cleanup: delete via API
  await fetch(`${ws.baseUrl}/api/compute/e2e-ui-compute/delete`, { method: "POST" });
});
