/**
 * Tests for useGroupActions -- verifies the underlying group operations
 * that the hook delegates to via ArkClient protocol.
 *
 * Since the hook now uses useArkClient() (React context), we test the
 * core operations that the server handlers call. The hook itself is a
 * thin wrapper around ark.groupCreate/groupDelete/sessionStop/sessionDelete.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../../core/app.js";
import { startSession } from "../../core/services/session-orchestration.js";
import type { AsyncState } from "../hooks/useAsync.js";
import { withTestContext } from "../../core/__tests__/test-helpers.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockAsyncState() {
  const state: AsyncState & { ran: { label: string; fn: Function }[]; flush: () => Promise<void> } = {
    loading: false,
    label: null,
    error: null,
    ran: [],
    run(label: string, fn: (updateLabel: (msg: string) => void) => void | Promise<void>) {
      state.ran.push({ label, fn });
      try { fn(() => {}); } catch {} // Execute sync side-effects for testing
    },
    clearError() {},
    async flush() {
      for (const { fn } of state.ran) {
        try { await fn(() => {}); } catch {}
      }
    },
  };
  return state;
}

// ── Setup ────────────────────────────────────────────────────────────────────

withTestContext();

let app: AppContext;

beforeEach(async () => {
  app = AppContext.forTest();
  setApp(app);
  await app.boot();
});

afterAll(async () => {
  if (app) await app.shutdown();
  clearApp();
});

// ── Tests (core operations that the hook delegates to) ──────────────────────

describe("useGroupActions (core operations)", () => {
  it("createGroup adds group to store", () => {
    app.sessions.createGroup("my-group");
    expect(app.sessions.getGroups().map(g => g.name)).toContain("my-group");
  });

  it("deleteGroup removes the group from the store", () => {
    app.sessions.createGroup("doomed-group");
    expect(app.sessions.getGroups().map(g => g.name)).toContain("doomed-group");
    app.sessions.deleteGroup("doomed-group");
    expect(app.sessions.getGroups().map(g => g.name)).not.toContain("doomed-group");
  });

  it("delete sessions in a group then delete the group", () => {
    app.sessions.createGroup("busy-group");
    const s1 = startSession(app, { summary: "task-1", repo: ".", flow: "bare" });
    const s2 = startSession(app, { summary: "task-2", repo: ".", flow: "bare" });
    app.sessions.update(s1.id, { group_name: "busy-group" });
    app.sessions.update(s2.id, { group_name: "busy-group" });

    // Simulate what the hook does: delete sessions then delete group
    const sessions = app.sessions.list().filter(s => s.group_name === "busy-group");
    for (const s of sessions) {
      app.sessions.delete(s.id);
    }
    app.sessions.deleteGroup("busy-group");

    expect(app.sessions.get(s1.id)).toBeNull();
    expect(app.sessions.get(s2.id)).toBeNull();
    expect(app.sessions.getGroups().map(g => g.name)).not.toContain("busy-group");
  });

  it("deleteGroup with no sessions in group still deletes the group", () => {
    app.sessions.createGroup("empty-group");
    const s1 = startSession(app, { summary: "other", repo: ".", flow: "bare" });
    app.sessions.update(s1.id, { group_name: "other-group" });

    app.sessions.deleteGroup("empty-group");

    expect(app.sessions.getGroups().map(g => g.name)).not.toContain("empty-group");
    // Unrelated session should still exist
    expect(app.sessions.get(s1.id)).not.toBeNull();
  });

  it("async state wraps with correct labels", () => {
    const asyncState = mockAsyncState();

    // Simulate the hook's pattern
    asyncState.run("Creating group...", async () => {
      app.sessions.createGroup("label-test");
    });
    asyncState.run("Deleting group...", async () => {
      app.sessions.deleteGroup("label-test");
    });

    expect(asyncState.ran.length).toBe(2);
    expect(asyncState.ran[0].label).toBe("Creating group...");
    expect(asyncState.ran[1].label).toBe("Deleting group...");
  });
});
