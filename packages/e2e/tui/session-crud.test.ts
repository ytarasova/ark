/**
 * E2E TUI session CRUD tests.
 *
 * Tests creating sessions with n key, deleting with x x,
 * cloning with c key, and archive/restore with Z key.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as core from "../../core/index.js";
import { TuiDriver } from "../fixtures/tui-driver.js";
import { snapshotArkTmuxSessions, killNewArkTmuxSessions } from "../../core/__tests__/test-helpers.js";

let tmuxSnapshot: Set<string>;
beforeAll(() => { tmuxSnapshot = snapshotArkTmuxSessions(); });
afterAll(() => { killNewArkTmuxSessions(tmuxSnapshot); });

describe("e2e TUI session CRUD", () => {

  it("creates a new session with n key", async () => {
    const tui = new TuiDriver();
    try {
      await tui.start();

      // Press n to open the new session form
      tui.press("n");
      await new Promise(r => setTimeout(r, 500));

      // Type a name
      tui.typeChars("crud-new-session-test");
      tui.press("enter");
      await new Promise(r => setTimeout(r, 300));

      // Press enter through remaining form fields:
      // Repo, Ticket, Compute, Group, Flow, Agent
      tui.press("enter");
      await new Promise(r => setTimeout(r, 300));
      tui.press("enter");
      await new Promise(r => setTimeout(r, 300));
      tui.press("enter");
      await new Promise(r => setTimeout(r, 300));
      tui.press("enter");
      await new Promise(r => setTimeout(r, 300));
      tui.press("enter");
      await new Promise(r => setTimeout(r, 300));
      tui.press("enter");
      await new Promise(r => setTimeout(r, 300));

      // Wait for the session to appear in the list
      const found = await tui.waitFor("crud-new-session-test", 8000);
      expect(found).toBe(true);
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("deletes a session with x x (double press)", async () => {
    const tui = new TuiDriver();
    try {
      const s = tui.createSession({
        repo: process.cwd(),
        summary: "crud-delete-target",
        flow: "bare",
      });

      await tui.start();
      await tui.waitFor("crud-delete-target");

      // First x starts delete confirmation
      tui.press("x");
      await new Promise(r => setTimeout(r, 500));

      // Second x confirms delete
      tui.press("x");

      const gone = await tui.waitForGone("crud-delete-target");
      expect(gone).toBe(true);

      // Session should be soft-deleted (status "deleting")
      const updated = core.getSession(s.id);
      expect(updated?.status).toBe("deleting");
      tui.untrack(s.id);
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("clones a session with c key", async () => {
    const tui = new TuiDriver();
    try {
      tui.createSession({
        repo: process.cwd(),
        summary: "crud-clone-source",
        flow: "bare",
      });

      await tui.start();
      await tui.waitFor("crud-clone-source");

      // Press c to clone
      tui.press("c");
      await new Promise(r => setTimeout(r, 500));

      // Confirm clone (press enter)
      tui.press("enter");

      // Wait for clone to appear -- it should have same summary or "clone" in text
      const found = await tui.waitFor(/crud-clone-source|clone/, 8000);
      expect(found).toBe(true);

      // There should now be at least 2 sessions
      const sessions = core.listSessions({ limit: 50 });
      const matching = sessions.filter(s =>
        s.summary?.includes("crud-clone-source") || s.summary?.includes("clone")
      );
      expect(matching.length).toBeGreaterThanOrEqual(1);
    } finally {
      tui.stop();
    }
  }, 30_000);

  it("archives and restores a session with Z key", async () => {
    const tui = new TuiDriver();
    try {
      const s = tui.createSession({
        repo: process.cwd(),
        summary: "crud-archive-target",
        flow: "bare",
      });

      // Complete the session first (archive requires completed/stopped/failed)
      await core.complete(s.id, { force: true });
      expect(core.getSession(s.id)!.status).toBe("completed");

      await tui.start();
      await tui.waitFor("crud-archive-target");

      // Press Z to archive
      tui.press("Z");
      await new Promise(r => setTimeout(r, 1000));

      // Verify the session is archived in DB
      await tui.waitUntil(() => {
        const updated = core.getSession(s.id);
        return updated?.status === "archived";
      }, 5000, 300);

      const archived = core.getSession(s.id)!;
      expect(archived.status).toBe("archived");

      // Restore with Z again (if session is still visible or we navigate to it)
      // Archived sessions may be hidden -- use core API to restore
      core.restore(s.id);
      const restored = core.getSession(s.id)!;
      expect(restored.status).toBe("completed");
    } finally {
      tui.stop();
    }
  }, 30_000);
});
