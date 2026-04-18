/**
 * Session view E2E tests.
 *
 * Tests the session list, detail panel, scrolling behavior, failed session
 * indicators, tab switching, and back navigation.
 *
 * Prerequisites: dev server running on localhost:5173 (`make dev`).
 */

import { test, expect } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Navigate to the sessions page via the sidebar. */
async function goToSessions(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.waitForSelector("nav", { timeout: 15_000 });
  // Click "Sessions" in the sidebar nav to make sure we are on the sessions page
  const sessionsBtn = page.locator('nav button:has-text("Sessions")');
  if (await sessionsBtn.isVisible()) {
    await sessionsBtn.click();
  }
}

// ---------------------------------------------------------------------------
// Session list
// ---------------------------------------------------------------------------

test.describe("Session list", () => {
  test("displays session list with session cards", async ({ page }) => {
    await goToSessions(page);

    // The session list panel should be visible (w-[300px] container)
    const listPanel = page.locator("div.w-\\[300px\\]");
    await expect(listPanel).toBeVisible({ timeout: 10_000 });

    // Should contain session cards (button elements inside the list)
    const sessionCards = listPanel.locator("button").filter({ has: page.locator("span") });
    // Wait for at least one session to appear (the server should have sessions)
    await expect(sessionCards.first()).toBeVisible({ timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// Session detail
// ---------------------------------------------------------------------------

test.describe("Session detail", () => {
  test("clicking a session opens the detail view", async ({ page }) => {
    await goToSessions(page);

    // Wait for session cards to load
    const listPanel = page.locator("div.w-\\[300px\\]");
    const firstCard = listPanel
      .locator("button")
      .filter({ has: page.locator("span") })
      .first();
    await expect(firstCard).toBeVisible({ timeout: 10_000 });

    // Click the first session card
    await firstCard.click();

    // The detail panel should appear with a scroll container
    // The container uses cn() resulting in "flex-1 min-h-0 overflow-y-auto px-6 py-6" for conversation tab
    const detailScroll = page.locator("div.flex-1.min-h-0.overflow-y-auto");
    await expect(detailScroll).toBeVisible({ timeout: 5_000 });

    // Tab bar should be visible with "Conversation" tab
    await expect(page.locator('button[role="tab"]:has-text("Conversation")')).toBeVisible();
  });

  test("detail panel scrolls independently from the session list", async ({ page }) => {
    await goToSessions(page);

    // Click the first session
    const listPanel = page.locator("div.w-\\[300px\\]");
    const firstCard = listPanel
      .locator("button")
      .filter({ has: page.locator("span") })
      .first();
    await expect(firstCard).toBeVisible({ timeout: 10_000 });
    await firstCard.click();

    // Wait for detail panel
    const detailScroll = page.locator("div.flex-1.min-h-0.overflow-y-auto");
    await expect(detailScroll).toBeVisible({ timeout: 5_000 });

    // Verify the detail panel has overflow-y-auto (independent scroll)
    const overflowY = await detailScroll.evaluate((el) => window.getComputedStyle(el).overflowY);
    expect(overflowY).toBe("auto");

    // The session list auto-collapses when a session is selected.
    // Expand it via the [ key, then verify it has its own scroll container.
    await page.keyboard.press("[");
    const expandedListPanel = page.locator("div.w-\\[300px\\]");
    await expect(expandedListPanel).toBeVisible({ timeout: 3_000 });
    const listScroll = expandedListPanel.locator("div.overflow-y-auto");
    await expect(listScroll).toBeVisible();
    const listOverflowY = await listScroll.evaluate((el) => window.getComputedStyle(el).overflowY);
    expect(listOverflowY).toBe("auto");
  });
});

// ---------------------------------------------------------------------------
// Failed session indicators
// ---------------------------------------------------------------------------

test.describe("Failed session indicators", () => {
  test("failed session card shows red stage dot in progress bar", async ({ page }) => {
    await goToSessions(page);

    const listPanel = page.locator("div.w-\\[300px\\]");
    await expect(listPanel).toBeVisible({ timeout: 10_000 });

    // Look for a stage progress segment with title containing "failed"
    const failedSegment = listPanel.locator('div[title*="failed"]');

    // Skip if no failed sessions exist in the current data
    const count = await failedSegment.count();
    if (count === 0) {
      test.skip(true, "No failed sessions with stage progress bars found -- skipping");
      return;
    }

    // Verify the failed segment is visible
    await expect(failedSegment.first()).toBeVisible();
  });

  test("failed session detail shows error card", async ({ page }) => {
    await goToSessions(page);

    const listPanel = page.locator("div.w-\\[300px\\]");
    await expect(listPanel).toBeVisible({ timeout: 10_000 });

    // Look for a failed session card -- failed sessions have a red status dot
    // The StageProgressBar segments with title containing "failed" indicate a failed session
    const failedSegment = listPanel.locator('div[title*="failed"]');
    const failedCount = await failedSegment.count();

    if (failedCount === 0) {
      test.skip(true, "No failed sessions found -- skipping");
      return;
    }

    // Click the session card that contains the failed stage segment
    const failedCard = failedSegment.first().locator("xpath=ancestor::button");
    await failedCard.click();

    // The detail panel should show the "Session Failed" error card
    await expect(page.locator("text=Session Failed")).toBeVisible({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------

test.describe("Tab switching", () => {
  test("switching between Conversation, Terminal, and Events tabs changes content", async ({ page }) => {
    await goToSessions(page);

    // Click the first session
    const listPanel = page.locator("div.w-\\[300px\\]");
    const firstCard = listPanel
      .locator("button")
      .filter({ has: page.locator("span") })
      .first();
    await expect(firstCard).toBeVisible({ timeout: 10_000 });
    await firstCard.click();

    // Wait for detail panel
    const detailScroll = page.locator("div.flex-1.min-h-0.overflow-y-auto");
    await expect(detailScroll).toBeVisible({ timeout: 5_000 });

    // -- Conversation tab (default) --
    const conversationTab = page.locator('button[role="tab"]:has-text("Conversation")');
    await expect(conversationTab).toBeVisible();
    await expect(conversationTab).toHaveAttribute("aria-selected", "true");

    // -- Switch to Terminal tab --
    const terminalTab = page.locator('button[role="tab"]:has-text("Terminal")');
    await terminalTab.click();
    await expect(terminalTab).toHaveAttribute("aria-selected", "true");
    // Conversation tab should no longer be selected
    await expect(conversationTab).toHaveAttribute("aria-selected", "false");
    // Terminal content should appear (either output or "No terminal output" empty state)
    await expect(
      detailScroll.locator("text=No terminal output available").or(detailScroll.locator("pre")).first(),
    ).toBeVisible({ timeout: 5_000 });

    // -- Switch to Events tab --
    const eventsTab = page.locator('button[role="tab"]:has-text("Events")');
    await eventsTab.click();
    await expect(eventsTab).toHaveAttribute("aria-selected", "true");
    await expect(terminalTab).toHaveAttribute("aria-selected", "false");
  });
});

// ---------------------------------------------------------------------------
// Back navigation
// ---------------------------------------------------------------------------

test.describe("Back navigation", () => {
  test("back button returns to the dashboard view", async ({ page }) => {
    await goToSessions(page);

    // Click the first session
    const listPanel = page.locator("div.w-\\[300px\\]");
    const firstCard = listPanel
      .locator("button")
      .filter({ has: page.locator("span") })
      .first();
    await expect(firstCard).toBeVisible({ timeout: 10_000 });
    await firstCard.click();

    // Wait for detail panel
    const detailScroll = page.locator("div.flex-1.min-h-0.overflow-y-auto");
    await expect(detailScroll).toBeVisible({ timeout: 5_000 });

    // Click the Back button
    const backButton = page.locator("button:has-text('Back')");
    await expect(backButton).toBeVisible();
    await backButton.click();

    // The detail panel should no longer be visible (replaced by dashboard)
    await expect(detailScroll).not.toBeVisible({ timeout: 5_000 });

    // The dashboard view should appear -- it contains session cards or welcome content
    // When no session is selected, the DashboardView renders
    // Verify by checking the detail scroll container is gone
    await expect(page.locator('button[role="tab"]:has-text("Conversation")')).not.toBeVisible();
  });
});
