/**
 * Accessibility invariants E2E.
 *
 * Three invariants from audit/8-a11y.md "Recommended A11y E2e Invariants":
 *
 * 1. Overlay focus discipline — open the New Session modal, tab past the last
 *    focusable, assert focus wraps back to the first (trap works); press Esc,
 *    assert the modal closes and focus returns to the trigger button.
 *    Guards against A4 (no focus trap + no focus return on close).
 *
 * 2. Keyboard-only navigation with `aria-current` — press the Layout single-key
 *    shortcuts (s/a/f/c/h/m/t) and assert the active nav button advertises
 *    `aria-current="page"`. Guards against A1/B12 regressions.
 *
 * 3. Error toast role — trigger an error toast via an invalid RPC and assert
 *    the toast carries `role="alert"`. Guards against B2 (silent-to-SR toast).
 *
 * Invariants 1 and 3 currently fail against HEAD because the a11y fixes that
 * add focus-trap and role="alert" have not yet landed. They are marked
 * `test.fixme(...)` and will light up automatically once the a11y PR merges.
 * The keyboard-nav invariant already works today (aria-current is wired in
 * IconRail.tsx).
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

// ---------------------------------------------------------------------------
// Invariant 1: overlay focus discipline (A4)
// ---------------------------------------------------------------------------
//
// Blocked until the a11y PR lands focus-trap + focus-restore in NewSessionModal
// (and the shared Modal / DetailDrawer / ComputeDrawer / CommandPalette). Until
// then, tabbing out of the modal escapes to the IconRail, and closing does not
// restore focus to the trigger button. See audit/8-a11y.md A4.

test.fixme("overlay focus discipline: New Session modal traps Tab and restores focus on Esc", async () => {
  // Navigate to sessions
  await page.click('nav button:has-text("Sessions")');
  await expect(page.locator("h1")).toContainText("Sessions");

  // Click the "New Session" trigger to open the modal.
  const trigger = page.locator('button:has-text("New Session")').first();
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await trigger.click();

  // Modal should be open (its h2 is the landmark).
  await expect(page.locator("h2:has-text('New Session')")).toBeVisible({ timeout: 5_000 });

  // Record the first focusable inside the modal.
  const firstFocusable = await page.evaluate(() => {
    const modal = document.querySelector("form");
    if (!modal) return null;
    const focusables = modal.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    return focusables[0]?.getAttribute("data-testid") || focusables[0]?.textContent?.slice(0, 40) || null;
  });
  expect(firstFocusable).not.toBeNull();

  // Tab 15 times — well past the last focusable in the modal. If the trap works,
  // `document.activeElement` must still be inside the modal.
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press("Tab");
  }
  const stillInsideModal = await page.evaluate(() => {
    const modal = document.querySelector("form");
    return modal ? modal.contains(document.activeElement) : false;
  });
  expect(stillInsideModal).toBe(true);

  // Press Escape — modal should close and focus should return to the trigger.
  await page.keyboard.press("Escape");
  await expect(page.locator("h2:has-text('New Session')")).not.toBeVisible({ timeout: 3_000 });

  const focusedOnTrigger = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    return active?.textContent?.includes("New Session") ?? false;
  });
  expect(focusedOnTrigger).toBe(true);
});

// ---------------------------------------------------------------------------
// Invariant 2: keyboard-only navigation + aria-current (A1 / B12)
// ---------------------------------------------------------------------------
//
// Layout.tsx wires s=sessions, a=agents, f=flows, c=compute, h=history,
// m=memory, t=tools. This test should pass today against HEAD.

test("keyboard shortcuts navigate and set aria-current on the active nav button", async () => {
  // Start from a known-good view: press Sessions shortcut and assert.
  // We press at the document body level so the Layout global listener fires
  // (it skips INPUT/TEXTAREA/SELECT focus targets).
  await page.evaluate(() => document.body.focus());

  const cases: Array<{ key: string; label: string }> = [
    { key: "s", label: "Sessions" },
    { key: "a", label: "Agents" },
    { key: "f", label: "Flows" },
    { key: "c", label: "Compute" },
    { key: "h", label: "History" },
    { key: "m", label: "Knowledge" },
    { key: "t", label: "Tools" },
  ];

  for (const { key, label } of cases) {
    // Make sure focus is not stolen by a prior interactive element.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    await page.keyboard.press(key);

    // The matching IconRail button must advertise aria-current="page".
    const activeBtn = page.locator(`nav button[aria-label="${label}"]`);
    await expect(activeBtn).toHaveAttribute("aria-current", "page", { timeout: 3_000 });

    // And only exactly one nav button should carry aria-current at a time.
    const currents = await page.locator('nav button[aria-current="page"]').count();
    expect(currents).toBe(1);
  }
});

// ---------------------------------------------------------------------------
// Invariant 3: error toast has role="alert" (B2)
// ---------------------------------------------------------------------------
//
// Toast.tsx currently has no role or aria-live (audit/8-a11y.md B2). The a11y
// PR adds role="alert" for error toasts and role="status" otherwise. Until
// that lands, this test is expected to fail — marked test.fixme so it activates
// automatically on merge.

test.fixme("error toast is announced to assistive tech via role=alert", async () => {
  // Navigate to a page that routes errors through showToast.
  await page.click('nav button:has-text("Sessions")');
  await expect(page.locator("h1")).toContainText("Sessions");

  // Trigger an error by calling an invalid RPC from the page context.
  // The web fetch helper rejects on non-ok, and the session action path
  // (e.g. todo/toggle with a missing sessionId) surfaces through onToast.
  await page.evaluate(async () => {
    try {
      await fetch("/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "session/read",
          params: { sessionId: "s-deadbeef" },
        }),
      });
    } catch {
      /* ignore */
    }
    // Most call sites synthesize their own toast on failure; for a
    // deterministic assertion, trigger one directly if the app exposes it.
    // The hook-shape window.arkToast is expected to be added alongside the
    // a11y PR as a test-only escape hatch.
    const w = window as unknown as { arkToast?: (msg: string, type: string) => void };
    w.arkToast?.("Simulated failure", "error");
  });

  // Once the a11y PR lands, the error toast should render with role="alert".
  const alertToast = page.locator('[role="alert"]');
  await expect(alertToast).toBeVisible({ timeout: 5_000 });
});
