/**
 * High-level test helpers on top of the TUI browser harness.
 *
 * Each test typically:
 *   const harness = await startHarness();
 *   const page = await browser.newPage();
 *   await page.goto(harness.pageUrl);
 *   await waitForText(page, "Sessions");
 *   await page.keyboard.press("q");
 *   await harness.stop();
 *
 * `waitForText` polls the xterm buffer via window.__arkBuffer() so we
 * assert against the actual rendered cells, not HTML DOM selectors.
 */

import type { Page } from "@playwright/test";

export { startHarness, type Harness, type HarnessOpts } from "./server.js";

/** Read the full xterm buffer as a single string. */
export async function readTerminal(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __arkBuffer: () => string }).__arkBuffer());
}

/** Wait until the xterm buffer contains `needle`. Polls every 100ms. */
export async function waitForText(
  page: Page,
  needle: string | RegExp,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const timeout = opts.timeoutMs ?? 10_000;
  const poll = opts.pollMs ?? 100;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const text = await readTerminal(page);
    const matches = typeof needle === "string" ? text.includes(needle) : needle.test(text);
    if (matches) return;
    await page.waitForTimeout(poll);
  }
  const dump = await readTerminal(page);
  throw new Error(
    `waitForText: did not find ${typeof needle === "string" ? JSON.stringify(needle) : needle}\n` +
      `last terminal snapshot:\n${dump}`,
  );
}

/** Wait until a predicate against the terminal buffer returns true. */
export async function waitForBuffer(
  page: Page,
  predicate: (text: string) => boolean,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const timeout = opts.timeoutMs ?? 10_000;
  const poll = opts.pollMs ?? 100;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const text = await readTerminal(page);
    if (predicate(text)) return;
    await page.waitForTimeout(poll);
  }
  const dump = await readTerminal(page);
  throw new Error(`waitForBuffer predicate never satisfied\nlast terminal snapshot:\n${dump}`);
}

/** Type a literal string into the terminal. */
export async function typeText(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text);
}

/** Press a named key. Playwright's key names apply (Enter, Escape, ArrowDown, q, etc.). */
export async function pressKey(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key);
}
