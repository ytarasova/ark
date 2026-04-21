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

// -- Destroy compute via API and verify removed from UI ----------------------

test("destroy compute target via API and verify removal", async () => {
  // Destroy via RPC (cascades infra teardown + DB row removal)
  const destroyData = await ws.rpc("compute/destroy", { name: "e2e-test-compute" });
  expect(destroyData.ok).toBe(true);

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

  // The form now uses RichSelect (Radix Popover) instead of native <select>.
  // Open the Compute picker, pick "local". Leave runtime as the default
  // "direct" -- local+direct is a persistent concrete target, which is the
  // simplest path that won't hit the template-lifecycle guard.
  await page
    .locator('button[aria-label="Select compute kind"]')
    .click()
    .catch(async () => {
      // Fallback: the RichSelect trigger may not have the aria-label in this
      // theme -- click the button inside the labeled Compute section instead.
      const computeSection = page.locator("text=Compute").first().locator("..");
      await computeSection.locator("button").first().click();
    });
  await page.locator('div[role="option"], button:has-text("local")').first().click();

  // Submit
  await page.click('button:has-text("Create Compute"), button:has-text("Create Template")');

  // Wait for the compute target to appear (may need reload)
  await page.waitForTimeout(1_000);
  await page.reload();
  await page.waitForSelector("nav", { timeout: 10_000 });
  await goToCompute();
  await expect(page.locator("text=e2e-ui-compute")).toBeVisible({ timeout: 10_000 });

  // Cleanup: destroy via RPC
  await ws.rpc("compute/destroy", { name: "e2e-ui-compute" });
});

// -- Unified template + concrete model --------------------------------------

test("compute/list returns is_template + cloned_from on every row", async () => {
  const data = await ws.rpc("compute/list");
  for (const t of data.targets) {
    expect(t).toHaveProperty("is_template");
    expect(t).toHaveProperty("cloned_from");
  }
});

test("compute/list filters: include=template returns only templates", async () => {
  // Create one template + one concrete and ensure the filter separates them.
  await ws.rpc("compute/create", {
    name: "e2e-filter-template",
    provider: "docker",
    is_template: true,
    config: { image: "alpine" },
  });
  await ws.rpc("compute/create", {
    name: "e2e-filter-concrete",
    provider: "docker",
    config: { image: "alpine" },
  });

  const templatesOnly = await ws.rpc("compute/list", { include: "template" });
  const concreteOnly = await ws.rpc("compute/list", { include: "concrete" });

  expect(templatesOnly.targets.some((t: any) => t.name === "e2e-filter-template")).toBe(true);
  expect(templatesOnly.targets.some((t: any) => t.name === "e2e-filter-concrete")).toBe(false);
  expect(concreteOnly.targets.some((t: any) => t.name === "e2e-filter-concrete")).toBe(true);
  expect(concreteOnly.targets.some((t: any) => t.name === "e2e-filter-template")).toBe(false);

  // Every row returned by include=template has is_template=true
  for (const t of templatesOnly.targets) expect(t.is_template).toBe(true);
  for (const t of concreteOnly.targets) expect(!!t.is_template).toBe(false);

  // Cleanup
  await ws.rpc("compute/destroy", { name: "e2e-filter-template" });
  await ws.rpc("compute/destroy", { name: "e2e-filter-concrete" });
});

test("provision on a template clones into a concrete row", async () => {
  // Create a docker template (docker doesn't need a live k8s cluster, so
  // this can run in isolation without cluster access).
  await ws.rpc("compute/create", {
    name: "e2e-prov-template",
    provider: "docker",
    is_template: true,
    config: { image: "alpine" },
  });

  // Provision it -- server should clone + mark the clone running (or at
  // least return the clone's name).
  const res = await ws.rpc("compute/provision", { name: "e2e-prov-template" });
  expect(res.ok).toBe(true);
  expect(res.name).toBeTruthy();
  expect(res.name).not.toBe("e2e-prov-template");
  expect(res.cloned_from).toBe("e2e-prov-template");

  // The clone should be visible in the concrete list with cloned_from set.
  const concrete = await ws.rpc("compute/list", { include: "concrete" });
  const clone = concrete.targets.find((t: any) => t.name === res.name);
  expect(clone).toBeTruthy();
  expect(clone.is_template).toBeFalsy();
  expect(clone.cloned_from).toBe("e2e-prov-template");

  // Cleanup clone + template. `compute/destroy` on a running concrete row
  // cascades infra teardown + DB row removal.
  await ws.rpc("compute/destroy", { name: res.name }).catch(() => {});
  await ws.rpc("compute/destroy", { name: "e2e-prov-template" });
});
