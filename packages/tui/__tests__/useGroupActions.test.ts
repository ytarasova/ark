/**
 * Tests for useGroupActions — verifies group create/delete wraps in async.run()
 * and deleteGroup stops running sessions before removing the group.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import {
  createGroup, deleteGroup, getGroups,
  startSession, getSession, updateSession, listSessions,
  AppContext, setApp, clearApp,
} from "../../core/index.js";
import { useGroupActions } from "../hooks/useGroupActions.js";
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
        try { await fn(); } catch {}
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
  await app.boot();
  setApp(app);
});

afterAll(async () => {
  if (app) await app.shutdown();
  clearApp();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("useGroupActions", () => {
  it("returns createGroup and deleteGroup functions", () => {
    const async = mockAsyncState();
    const actions = useGroupActions(async);

    expect(typeof actions.createGroup).toBe("function");
    expect(typeof actions.deleteGroup).toBe("function");
  });

  it("createGroup calls core.createGroup with the right name", () => {
    const async = mockAsyncState();
    const actions = useGroupActions(async);
    actions.createGroup("my-group");

    expect(async.ran.length).toBe(1);
    expect(async.ran[0].label).toBe("Creating group...");
    expect(getGroups()).toContain("my-group");
  });

  it("createGroup fires onDone callback", () => {
    const async = mockAsyncState();
    const actions = useGroupActions(async);
    let doneFired = false;
    actions.createGroup("callback-group", () => { doneFired = true; });

    expect(doneFired).toBe(true);
  });

  it("deleteGroup removes the group from the store", async () => {
    createGroup("doomed-group");
    expect(getGroups()).toContain("doomed-group");

    const async = mockAsyncState();
    const actions = useGroupActions(async);
    actions.deleteGroup("doomed-group", []);
    await async.flush();

    expect(getGroups()).not.toContain("doomed-group");
  });

  it("deleteGroup stops running sessions in the group before deleting", async () => {
    createGroup("busy-group");
    const s1 = startSession({ summary: "task-1", repo: ".", flow: "bare" });
    const s2 = startSession({ summary: "task-2", repo: ".", flow: "bare" });
    updateSession(s1.id, { group_name: "busy-group" });
    updateSession(s2.id, { group_name: "busy-group" });

    const sessions = listSessions();
    const async = mockAsyncState();
    const actions = useGroupActions(async);
    actions.deleteGroup("busy-group", sessions);
    await async.flush();

    // Sessions should be deleted
    expect(getSession(s1.id)).toBeNull();
    expect(getSession(s2.id)).toBeNull();
    // Group should be gone
    expect(getGroups()).not.toContain("busy-group");
  });

  it("deleteGroup fires onDone callback with count of deleted sessions", async () => {
    createGroup("count-group");
    const s1 = startSession({ summary: "c-1", repo: ".", flow: "bare" });
    const s2 = startSession({ summary: "c-2", repo: ".", flow: "bare" });
    updateSession(s1.id, { group_name: "count-group" });
    updateSession(s2.id, { group_name: "count-group" });

    const sessions = listSessions();
    const async = mockAsyncState();
    const actions = useGroupActions(async);
    let doneCount = -1;
    actions.deleteGroup("count-group", sessions, (count) => { doneCount = count; });
    await async.flush();

    expect(doneCount).toBe(2);
  });

  it("deleteGroup with no sessions in group still deletes the group", async () => {
    createGroup("empty-group");
    const s1 = startSession({ summary: "other", repo: ".", flow: "bare" });
    updateSession(s1.id, { group_name: "other-group" });

    const sessions = listSessions();
    const async = mockAsyncState();
    const actions = useGroupActions(async);
    actions.deleteGroup("empty-group", sessions);
    await async.flush();

    expect(getGroups()).not.toContain("empty-group");
    // Unrelated session should still exist
    expect(getSession(s1.id)).not.toBeNull();
  });

  it("deleteGroup runs with correct label", () => {
    const async = mockAsyncState();
    const actions = useGroupActions(async);
    actions.deleteGroup("label-group", []);

    expect(async.ran.length).toBe(1);
    expect(async.ran[0].label).toBe("Deleting group...");
  });
});
