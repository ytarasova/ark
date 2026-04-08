/**
 * Web UI E2E tests via Playwright.
 *
 * Launches `ark web` as a child process, then tests the Web UI
 * in a regular Chromium browser. No Electron needed -- works in CI.
 */

import { test, expect, type Page, type Browser } from "@playwright/test";
import { chromium } from "playwright";
import { join } from "path";
import { spawn, execFileSync, type ChildProcess } from "child_process";

let browser: Browser;
let page: Page;
let serverProcess: ChildProcess;
let serverPort: number;

const ARK_BIN = join(__dirname, "..", "..", "..", "ark");

test.beforeAll(async () => {
  // Build web frontend
  execFileSync("bun", ["run", join(__dirname, "..", "..", "web", "build.ts")], {
    cwd: join(__dirname, "..", "..", ".."),
    stdio: "pipe",
    timeout: 60_000,
  });

  // Find a free port
  serverPort = 18420 + Math.floor(Math.random() * 1000);

  // Launch ark web
  serverProcess = spawn(ARK_BIN, ["web", "--port", String(serverPort)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}` },
  });

  // Wait for server to be ready
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    try {
      const res = await fetch(`http://localhost:${serverPort}/api/status`);
      if (res.ok) break;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 300));
  }

  // Launch browser
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(`http://localhost:${serverPort}`);
  await page.waitForSelector("nav", { timeout: 10_000 });
});

test.afterAll(async () => {
  if (browser) await browser.close();
  if (serverProcess) serverProcess.kill();
});

// ── Sidebar navigation ─────────────────────────────────────────────────────

test("sidebar shows all navigation items", async () => {
  const navItems = page.locator("nav button");
  await expect(navItems).toHaveCount(9);
});

test("sidebar logo shows ark", async () => {
  await expect(page.locator("text=ark").first()).toBeVisible();
});

test("sessions view is shown by default", async () => {
  await expect(page.locator("h1")).toContainText("Sessions");
});

// ── Tab switching ──────────────────────────────────────────────────────────

test("click Agents navigates", async () => {
  await page.click("button:has-text('Agents')");
  await expect(page.locator("h1")).toContainText("Agents");
});

test("click Tools navigates", async () => {
  await page.click("button:has-text('Tools')");
  await expect(page.locator("h1")).toContainText("Tools");
});

test("click Flows navigates", async () => {
  await page.click("button:has-text('Flows')");
  await expect(page.locator("h1")).toContainText("Flows");
});

test("click Compute navigates", async () => {
  await page.click("button:has-text('Compute')");
  await expect(page.locator("h1")).toContainText("Compute");
});

test("click Schedules navigates", async () => {
  await page.click("button:has-text('Schedules')");
  await expect(page.locator("h1")).toContainText("Schedules");
});

test("click Memory navigates", async () => {
  await page.click("button:has-text('Memory')");
  await expect(page.locator("h1")).toContainText("Memory");
});

test("click Costs navigates", async () => {
  await page.click("button:has-text('Costs')");
  await expect(page.locator("h1")).toContainText("Costs");
});

test("click Sessions returns", async () => {
  await page.click("button:has-text('Sessions')");
  await expect(page.locator("h1")).toContainText("Sessions");
});

// ── Sessions page ──────────────────────────────────────────────────────────

test("sessions page shows search input", async () => {
  await expect(page.locator("input[placeholder*='Search']")).toBeVisible();
});

test("sessions page shows filter chips", async () => {
  await expect(page.locator("button:has-text('All')")).toBeVisible();
  await expect(page.locator("button:has-text('Running')")).toBeVisible();
  await expect(page.locator("button:has-text('Failed')")).toBeVisible();
});

test("sessions page shows New Session button", async () => {
  await expect(page.locator("button:has-text('New Session')")).toBeVisible();
});

// ── API health ─────────────────────────────────────────────────────────────

test("API status endpoint responds", async () => {
  const response = await page.evaluate(async () => {
    const res = await fetch("/api/status");
    return res.json();
  });
  expect(response).toHaveProperty("total");
});

test("API sessions endpoint responds", async () => {
  const sessions = await page.evaluate(async () => {
    const res = await fetch("/api/sessions");
    return res.json();
  });
  expect(Array.isArray(sessions)).toBe(true);
});

test("API agents endpoint responds", async () => {
  const agents = await page.evaluate(async () => {
    const res = await fetch("/api/agents");
    return res.json();
  });
  expect(Array.isArray(agents)).toBe(true);
  expect(agents.length).toBeGreaterThan(0);
});

test("API flows endpoint responds", async () => {
  const flows = await page.evaluate(async () => {
    const res = await fetch("/api/flows");
    return res.json();
  });
  expect(Array.isArray(flows)).toBe(true);
  expect(flows.length).toBeGreaterThan(0);
});

test("API compute endpoint responds", async () => {
  const computes = await page.evaluate(async () => {
    const res = await fetch("/api/compute");
    return res.json();
  });
  expect(Array.isArray(computes)).toBe(true);
});

// ── SSE connection ─────────────────────────────────────────────────────────

test("SSE event stream is connected", async () => {
  const connected = await page.evaluate(() => {
    return new Promise((resolve) => {
      const es = new EventSource("/api/events/stream");
      es.onopen = () => { es.close(); resolve(true); };
      es.onerror = () => { es.close(); resolve(false); };
      setTimeout(() => { es.close(); resolve(false); }, 5000);
    });
  });
  expect(connected).toBe(true);
});
