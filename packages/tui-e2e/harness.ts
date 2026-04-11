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
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

export { startHarness, mkTempArkDir, type Harness, type HarnessOpts } from "./server.js";

// ── State seeding via `ark` CLI ─────────────────────────────────────────────
//
// The harness spawns `ark tui` in a subprocess with an isolated ARK_DIR.
// Tests that need pre-existing state (sessions, compute, etc.) can't
// mutate an in-process AppContext because there isn't one -- the TUI
// owns the DB inside its own subprocess. Instead, invoke the CLI against
// the harness's ARK_DIR before `startHarness()` is called (or mid-test,
// since WAL-mode SQLite handles concurrent writes). The TUI polls for
// list updates so new rows show up automatically.

const __dirname = dirname(fileURLToPath(import.meta.url));

function findArkBinary(): string {
  const candidates = [
    resolve(__dirname, "..", "..", "ark"),
    resolve(__dirname, "..", "..", "ark-native"),
    "/usr/local/bin/ark",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`Could not find ark binary. Checked: ${candidates.join(", ")}`);
}

export interface RunArkCliOpts {
  /** ARK_DIR to target. Usually harness.arkDir. */
  arkDir: string;
  /** Extra env vars to merge on top of process.env + ARK_DIR. */
  env?: Record<string, string>;
  /** Timeout in milliseconds. Default 15_000. */
  timeoutMs?: number;
}

/**
 * Execute a one-shot `ark` CLI command against an isolated ARK_DIR.
 * Returns stdout as a string. Throws on non-zero exit.
 *
 * Typical usage: seed a session row before booting the harness.
 *
 *   const harness = await startHarness();
 *   runArkCli(["session", "start", "--repo", ".", "--summary", "demo", "--flow", "bare"],
 *             { arkDir: harness.arkDir });
 *   await page.goto(harness.pageUrl);
 *   await waitForText(page, "demo");
 */
export function runArkCli(args: string[], opts: RunArkCliOpts): string {
  const bin = findArkBinary();
  const timeout = opts.timeoutMs ?? 15_000;
  return execFileSync(bin, args, {
    // Ark reads ARK_TEST_DIR (not ARK_DIR) to redirect its state root.
    env: { ...process.env, ARK_TEST_DIR: opts.arkDir, ...(opts.env ?? {}) },
    encoding: "utf-8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Seed a session in the harness's ARK_DIR. Thin wrapper over
 * `ark session start --repo <cwd> --summary <summary> --flow <flow>`.
 * Returns the new session id parsed from the CLI output.
 */
export function seedSession(
  arkDir: string,
  opts: { summary: string; repo?: string; flow?: string; ticket?: string },
): string {
  const args = ["session", "start",
    "--repo", opts.repo ?? process.cwd(),
    "--summary", opts.summary,
    "--flow", opts.flow ?? "bare",
  ];
  if (opts.ticket) args.push("--ticket", opts.ticket);
  const out = runArkCli(args, { arkDir });
  // `ark session start` prints a line containing the new session id.
  // Match the `s-<hex>` pattern liberally.
  const match = out.match(/s-[0-9a-f]+/);
  return match?.[0] ?? "";
}

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

// ── Keystroke delivery ──────────────────────────────────────────────────────
//
// Playwright's `page.keyboard.press()` does NOT reliably reach the pty.
// xterm.js's hidden textarea is not focused by default, so keydown events
// get dropped before xterm's onData handler fires. We sidestep this by
// routing input through `term.paste()` inside the page, which goes
// straight through `term.onData -> ws.send -> pty.write` -- the same path
// a real keystroke would take, just without needing focus.

/**
 * Map Playwright-style key names to the byte sequences the pty expects.
 * Unknown keys fall back to the raw string (single-char keypresses work
 * as-is, e.g. `pressKey(page, "q")`).
 */
const KEY_SEQUENCES: Record<string, string> = {
  Enter: "\r",
  Escape: "\x1b",
  Tab: "\t",
  Backspace: "\x7f",
  Delete: "\x1b[3~",
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  Space: " ",
};

/** Write a string to the pty via xterm's paste pipeline (no focus required). */
async function writeToPty(page: Page, data: string): Promise<void> {
  await page.evaluate((s: string) => {
    const term = (window as unknown as { __arkTerm?: { paste: (s: string) => void } }).__arkTerm;
    if (!term) throw new Error("xterm not initialized on this page");
    term.paste(s);
  }, data);
}

/** Type a literal string into the terminal. */
export async function typeText(page: Page, text: string): Promise<void> {
  await writeToPty(page, text);
}

/**
 * Press a named key. Accepts Playwright-style names (`Enter`, `Escape`,
 * `ArrowDown`, `Tab`, ...) AND single-char literals (`q`, `W`, `3`).
 */
export async function pressKey(page: Page, key: string): Promise<void> {
  const seq = KEY_SEQUENCES[key] ?? key;
  await writeToPty(page, seq);
}
