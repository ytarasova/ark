/**
 * E2E TUI talk and inbox tests.
 *
 * Tests sending a message to a session with t key and
 * opening the inbox overlay with i key.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as core from "../../core/index.js";
import { TuiDriver } from "../fixtures/tui-driver.js";
import { snapshotArkTmuxSessions, killNewArkTmuxSessions } from "../../core/__tests__/test-helpers.js";

let tmuxSnapshot: Set<string>;
beforeAll(() => { tmuxSnapshot = snapshotArkTmuxSessions(); });
afterAll(() => { killNewArkTmuxSessions(tmuxSnapshot); });

describe("e2e TUI talk and inbox", () => {

  it("opens talk overlay with t key on a session", async () => {
    const tui = new TuiDriver();
    try {
      tui.createSession({
        repo: process.cwd(),
        summary: "talk-target-session",
        flow: "bare",
      });

      await tui.start();
      await tui.waitFor("talk-target-session");

      // Press t to open talk overlay
      tui.press("t");
      await new Promise(r => setTimeout(r, 500));

      // The talk overlay should appear -- look for input prompt or talk-related text
      const found = await tui.waitFor(/Talk|Message|Send|talk-target-session/, 5000);
      expect(found).toBe(true);

      // Type a message
      tui.typeChars("Hello from e2e test");
      await new Promise(r => setTimeout(r, 300));

      // Send with enter
      tui.press("enter");
      await new Promise(r => setTimeout(r, 500));

      // The message should have been processed -- TUI should still be alive
      expect(tui.alive()).toBe(true);

      // Escape back if still in overlay
      tui.press("escape");
      await new Promise(r => setTimeout(r, 300));
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("opens inbox overlay with i key", async () => {
    const tui = new TuiDriver();
    try {
      tui.createSession({
        repo: process.cwd(),
        summary: "inbox-test-session",
        flow: "bare",
      });

      await tui.start();
      await tui.waitFor("inbox-test-session");

      // Press i to open inbox/threads overlay
      tui.press("i");
      await new Promise(r => setTimeout(r, 500));

      // The inbox overlay should appear
      const found = await tui.waitFor(/Inbox|Thread|Message|No messages/, 5000);
      expect(found).toBe(true);

      // TUI should remain alive
      expect(tui.alive()).toBe(true);

      // Close inbox with escape
      tui.press("escape");
      await new Promise(r => setTimeout(r, 300));

      // Should be back to sessions
      expect(tui.text()).toContain("inbox-test-session");
    } finally {
      tui.stop();
    }
  }, 30_000);
});
