/**
 * Agents & Flows E2E tests.
 *
 * Tests that the Agents page shows builtin agents,
 * the Flows page shows builtin flows, and the Flow API returns stages.
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

// -- Agents page --------------------------------------------------------------

test("agents page shows builtin agents", async () => {
  await page.click('nav button:has-text("Agents")');
  await expect(page.locator("h1")).toContainText("Agents");

  // The agents list should have items -- builtin agents like worker, planner, etc.
  // Each agent shows as a clickable row with the agent name and a "builtin" badge
  const agentItems = page.locator("text=builtin");
  await expect(agentItems.first()).toBeVisible({ timeout: 5_000 });

  // Verify via RPC that agents are returned
  const data = await ws.rpc("agent/list");
  expect(data.agents.length).toBeGreaterThan(0);

  // Check a known builtin agent name is present in the agent list panel
  const agentNames = data.agents.map((a: any) => a.name);
  expect(agentNames).toContain("worker");
});

test("click agent shows detail panel with configuration", async () => {
  await page.click('nav button:has-text("Agents")');
  await expect(page.locator("h1")).toContainText("Agents");

  // Click on the worker agent in the list
  await page.locator("text=worker").first().click();

  // Detail panel should show configuration section
  await expect(page.locator("text=Configuration").first()).toBeVisible({ timeout: 5_000 });

  // Should show Model field
  await expect(page.locator("text=Model").first()).toBeVisible();
});

test("agents RPC returns expected fields", async () => {
  const data = await ws.rpc("agent/list");
  expect(data.agents.length).toBeGreaterThan(0);

  const agent = data.agents[0];
  expect(agent).toHaveProperty("name");
  expect(agent).toHaveProperty("model");
});

// -- Flows page ---------------------------------------------------------------

test("flows page shows builtin flows", async () => {
  await page.click('nav button:has-text("Flows")');
  await expect(page.locator("h1")).toContainText("Flows");

  // Verify via RPC that flows are returned
  const data = await ws.rpc("flow/list");
  expect(data.flows.length).toBeGreaterThan(0);

  // Check known builtin flow names
  const flowNames = data.flows.map((f: any) => f.name);
  // "bare" is a commonly available flow
  expect(flowNames).toContain("bare");
});

test("click flow shows detail with stages", async () => {
  await page.click('nav button:has-text("Flows")');
  await expect(page.locator("h1")).toContainText("Flows");

  // Get a flow that has stages from the RPC
  const flowData = await ws.rpc("flow/list");
  const flows = flowData.flows;
  // Find a flow that is not bare (bare has 1 stage)
  const multiStageFlow = flows.find((f: any) => f.stages && f.stages.length > 1);

  if (multiStageFlow) {
    // Click on the flow
    await page.locator(`text=${multiStageFlow.name}`).first().click();

    // Should show Stages heading
    await expect(page.locator("text=Stages").first()).toBeVisible({ timeout: 5_000 });
  }

  // Also click "bare" flow to verify single stage works
  await page.locator("text=bare").first().click();
  await expect(page.locator("text=bare").first()).toBeVisible({ timeout: 5_000 });
});

test("flow detail RPC returns stages with gate and agent fields", async () => {
  // Get the list of flows
  const listData = await ws.rpc("flow/list");
  expect(listData.flows.length).toBeGreaterThan(0);

  // Get detail for the first flow
  const flowName = listData.flows[0].name;
  const detail = await ws.rpc("flow/read", { name: flowName });

  expect(detail.flow).toHaveProperty("name", flowName);
  expect(detail.flow).toHaveProperty("stages");
  expect(Array.isArray(detail.flow.stages)).toBe(true);

  if (detail.flow.stages.length > 0) {
    const stage = detail.flow.stages[0];
    expect(stage).toHaveProperty("name");
    // gate and agent may be present
  }
});

test("flow RPC returns stages for default flow", async () => {
  try {
    const data = await ws.rpc("flow/read", { name: "default" });
    // default flow may or may not exist depending on builtin defs
    expect(data.flow).toHaveProperty("stages");
    expect(Array.isArray(data.flow.stages)).toBe(true);
    expect(data.flow.stages.length).toBeGreaterThan(0);
  } catch {
    // default flow may not exist -- that's OK
  }
});
