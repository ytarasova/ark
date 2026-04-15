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

test("compute RPC returns array", async () => {
  const data = await ws.rpc("compute/list");
  expect(Array.isArray(data.targets)).toBe(true);
});

// -- Create compute via API and verify in UI ----------------------------------

test("create compute target via API and verify in UI", async () => {
  // Create a compute target via RPC
  const createData = await ws.rpc("compute/create", { name: "e2e-test-compute", provider: "docker", config: {} });
  expect(createData.compute).toBeTruthy();

  // Reload and go to Compute page
  await page.reload();
  await page.waitForSelector("nav", { timeout: 10_000 });
  await goToCompute();

  // The compute target should appear in the list
  await expect(page.locator("text=e2e-test-compute")).toBeVisible({ timeout: 10_000 });

  // Should show "docker" provider badge
  await expect(page.locator("text=docker").first()).toBeVisible();
});

test("click compute target shows detail panel", async () => {
  await goToCompute();

  // Click on the compute target we created
  await page.locator("text=e2e-test-compute").click();

  // Detail panel should show Details section
  await expect(page.locator("text=Details").first()).toBeVisible({ timeout: 5_000 });

  // Should show Provider field
  await expect(page.locator("text=Provider").first()).toBeVisible();
});

// -- Delete compute via API and verify removed from UI ------------------------

test("delete compute target via API and verify removal", async () => {
  // Delete via RPC
  const deleteData = await ws.rpc("compute/delete", { name: "e2e-test-compute" });
  expect(deleteData.ok).toBe(true);

  // Reload and verify the compute target is gone
  await page.reload();
  await page.waitForSelector("nav", { timeout: 10_000 });
  await goToCompute();

  // The compute target should no longer appear
  await expect(page.locator("text=e2e-test-compute")).not.toBeVisible({ timeout: 5_000 });
});

// -- Create compute via New Compute inline form (UI) --------------------------

test("create compute via New Compute inline form", async () => {
  await goToCompute();

  // Click New Compute button
  await page.click('button:has-text("New Compute")');

  // The inline form should appear in the right panel with title "New Compute Target"
  await expect(page.locator("text=New Compute Target")).toBeVisible({ timeout: 5_000 });

  // Fill in name
  const nameInput = page.locator('input[placeholder="my-compute"]');
  await expect(nameInput).toBeVisible();
  await nameInput.fill("e2e-ui-compute");

  // Select "docker" provider (local is a singleton and already exists)
  const providerSelect = page.locator("select", { has: page.locator('option[value="docker"]') }).first();
  await providerSelect.selectOption("docker");

  // Submit
  await page.click('button:has-text("Create Compute")');

  // Wait for the compute target to appear (may need reload)
  await page.waitForTimeout(1_000);
  await page.reload();
  await page.waitForSelector("nav", { timeout: 10_000 });
  await goToCompute();
  await expect(page.locator("text=e2e-ui-compute")).toBeVisible({ timeout: 10_000 });

  // Cleanup: delete via RPC
  await ws.rpc("compute/delete", { name: "e2e-ui-compute" });
});
