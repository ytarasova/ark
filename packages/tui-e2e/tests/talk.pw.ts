/**
 * Ported from packages/e2e/tui.deprecated/talk.test.ts.
 *
 * The legacy file covered two scenarios:
 *   1. Press `t` on a session to open the Talk (chat) overlay, type a
 *      message, and press Enter.
 *   2. Press the inbox key on the sessions list to open the Threads
 *      panel and verify the empty state renders, then Esc back.
 *
 * Three important translations from the legacy version:
 *
 *   • The Talk overlay only opens when the selected session's status is
 *     `running` or `waiting` (see SessionsTab.tsx -- the `t` handler is
 *     guarded by that check). `seedSession()` creates rows in `ready`
 *     status, so the harness has to flip the status to `waiting` in the
 *     SQLite DB before the TUI subprocess opens its connection. We do
 *     that with the `sqlite3` CLI against the harness's ARK_DIR/ark.db
 *     during the seed-before-boot phase.
 *
 *   • The legacy file claimed `i` opened the inbox. The actual hotkey
 *     in `packages/core/hotkeys.ts` is `T` (uppercase). We use `T`.
 *
 *   • Playwright's `page.keyboard.press()` does NOT reliably reach the
 *     pty: xterm.js's hidden textarea is not focused on page load, so
 *     keydown events get dropped before xterm's onData handler fires.
 *     The harness's `pressKey` helper has the same problem. We sidestep
 *     it by calling `term.paste(...)` from inside the page, which goes
 *     straight through xterm's onData callback into the WebSocket and
 *     into the pty -- the same path real keystrokes would take, just
 *     without depending on textarea focus. ESC is "\x1b" and Enter is
 *     "\r"; literal characters paste verbatim.
 *
 * What is intentionally NOT tested (no real agent runtime in the
 * harness): we never assert that the message is delivered, that an
 * agent responds, or that the message round-trips through the channel.
 * The Talk overlay's `send` calls `messageSend` which ultimately needs
 * a tmux `session_id` we don't have. We only verify the user-facing
 * surface: the overlay opens, accepts typed input, and the TUI stays
 * alive after Enter.
 */

import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import {
  startHarness,
  waitForText,
  readTerminal,
  seedSession,
  mkTempArkDir,
} from "../harness.js";

/**
 * Send characters into the TUI pty by routing through xterm's `paste`
 * method. Going through `__arkTerm.paste(...)` triggers the same
 * `term.onData -> ws.send -> pty.write` path as a real keystroke,
 * without requiring xterm's hidden textarea to be focused (which is
 * the failure mode of `page.keyboard.press()` in this harness).
 *
 * Use literal characters for letters/digits, "\r" for Enter, "\x1b"
 * for Escape, "\t" for Tab, etc.
 */
async function ptySend(page: Page, text: string): Promise<void> {
  await page.evaluate((s: string) => {
    (window as unknown as { __arkTerm: { paste: (s: string) => void } }).__arkTerm.paste(s);
  }, text);
}

/**
 * Force a seeded session into the `waiting` status by writing directly
 * to the SQLite DB. The TUI's hotkey gate for the talk overlay only
 * unlocks when status is `running` or `waiting`, and there is no CLI
 * command to set status arbitrarily, so we do this surgically.
 *
 * Must be called BEFORE startHarness() -- once the TUI subprocess opens
 * its WAL connection, a second writer trips SQLite "database is locked"
 * (or worse, races on the row).
 */
function setSessionStatus(arkDir: string, sessionId: string, status: string): void {
  execFileSync(
    "sqlite3",
    [`${arkDir}/ark.db`, `UPDATE sessions SET status='${status}' WHERE id='${sessionId}'`],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
  );
}

test.describe("Ark TUI talk + inbox", () => {
  test("pressing `t` on a waiting session opens the Talk overlay", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      const id = seedSession(arkDir, { summary: "talk-target-session", flow: "bare" });
      // Talk hotkey requires status running|waiting -- bump status pre-boot.
      setSessionStatus(arkDir, id, "waiting");

      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });
        await waitForText(page, "talk-target-session", { timeoutMs: 10_000 });

        // Open the Talk overlay. The selected session is the only row,
        // so no navigation is needed before pressing `t`.
        await ptySend(page, "t");

        // The TalkToSession component renders a header containing
        // "Chat:" plus the session summary, and the empty-state hint
        // "No messages yet." for fresh sessions. Either is enough to
        // confirm the overlay actually opened.
        await waitForText(page, /Chat:|No messages yet/, { timeoutMs: 10_000 });

        // Type a message into the chat input. The typed text should
        // appear in the rendered input row.
        const messageText = "hello-from-pw-talk";
        await ptySend(page, messageText);
        await waitForText(page, messageText, { timeoutMs: 5_000 });

        // Press Enter to fire the send handler. We do NOT assert the
        // message was delivered (no real agent / tmux session), only
        // that the TUI does not crash and the overlay can be dismissed.
        await ptySend(page, "\r");
        await page.waitForTimeout(500);

        // Escape closes the overlay -- the TUI should be back on the
        // sessions list with the row still visible.
        await ptySend(page, "\x1b");
        await waitForText(page, "talk-target-session", { timeoutMs: 5_000 });

        const buf = await readTerminal(page);
        expect(buf).toContain("Sessions");
        expect(buf).toContain("talk-target-session");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });

  test("pressing `T` opens the Threads inbox overlay", async ({ page }) => {
    const arkDir = mkTempArkDir();
    try {
      seedSession(arkDir, { summary: "inbox-test-session", flow: "bare" });

      const harness = await startHarness({ arkDir, rows: 40 });
      try {
        await page.goto(harness.pageUrl);
        await waitForText(page, "Sessions", { timeoutMs: 15_000 });
        await waitForText(page, "inbox-test-session", { timeoutMs: 10_000 });

        // The inbox hotkey is uppercase `T` (see core/hotkeys.ts -- the
        // legacy bun:test file claimed `i`, but that was wrong even
        // when it was written).
        await ptySend(page, "T");

        // ThreadsPanel renders a "Threads" title and either a message
        // list or the "No messages yet" empty state. Match either.
        await waitForText(page, /Threads|No messages yet/, { timeoutMs: 10_000 });

        // Close the inbox -- should pop back to the sessions list.
        await ptySend(page, "\x1b");
        await waitForText(page, "inbox-test-session", { timeoutMs: 5_000 });

        const buf = await readTerminal(page);
        expect(buf).toContain("inbox-test-session");
      } finally {
        await harness.stop();
      }
    } finally {
      rmSync(arkDir, { recursive: true, force: true });
    }
  });
});
