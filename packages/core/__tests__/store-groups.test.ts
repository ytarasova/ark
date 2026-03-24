/**
 * Tests for groups table — createGroup, getGroups, deleteGroup.
 * Verifies group persistence, union with session group_names,
 * and cascade unassignment on delete.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import {
  createTestContext, setContext, resetContext,
  getDb, createGroup, getGroups, deleteGroup,
  type TestContext,
} from "../index.js";
import { createSession, updateSession } from "../store.js";

let ctx: TestContext;

beforeEach(() => {
  if (ctx) ctx.cleanup();
  ctx = createTestContext();
  setContext(ctx);
});

afterAll(() => {
  if (ctx) ctx.cleanup();
  resetContext();
});

describe("groups table", () => {
  it("createGroup persists a group to the DB", () => {
    createGroup("alpha");
    const groups = getGroups();
    expect(groups).toContain("alpha");
  });

  it("createGroup is idempotent (INSERT OR IGNORE)", () => {
    createGroup("beta");
    createGroup("beta");
    const groups = getGroups();
    // Should appear only once
    const count = groups.filter((g) => g === "beta").length;
    expect(count).toBe(1);
  });

  it("getGroups returns groups from the groups table", () => {
    createGroup("group-a");
    createGroup("group-b");
    const groups = getGroups();
    expect(groups).toContain("group-a");
    expect(groups).toContain("group-b");
  });

  it("getGroups returns group_names from sessions", () => {
    createSession({ summary: "session with group", group_name: "session-group" });
    const groups = getGroups();
    expect(groups).toContain("session-group");
  });

  it("getGroups returns union of both groups table and session group_names", () => {
    createGroup("table-group");
    createSession({ summary: "s1", group_name: "session-group" });

    const groups = getGroups();
    expect(groups).toContain("table-group");
    expect(groups).toContain("session-group");
  });

  it("getGroups deduplicates when same name in both groups table and sessions", () => {
    createGroup("shared-name");
    createSession({ summary: "s1", group_name: "shared-name" });

    const groups = getGroups();
    const count = groups.filter((g) => g === "shared-name").length;
    expect(count).toBe(1);
  });

  it("getGroups returns sorted results", () => {
    createGroup("charlie");
    createGroup("alpha");
    createGroup("bravo");

    const groups = getGroups();
    const sorted = [...groups].sort();
    expect(groups).toEqual(sorted);
  });

  it("empty groups appear in getGroups", () => {
    // Create a group with no sessions assigned
    createGroup("empty-group");
    const groups = getGroups();
    expect(groups).toContain("empty-group");
  });

  it("deleteGroup removes the group from the groups table", () => {
    createGroup("to-delete");
    expect(getGroups()).toContain("to-delete");

    deleteGroup("to-delete");
    // Group should be gone unless a session still references it
    expect(getGroups()).not.toContain("to-delete");
  });

  it("deleteGroup unassigns sessions from the deleted group", () => {
    createGroup("cleanup-group");
    const session = createSession({ summary: "assigned", group_name: "cleanup-group" });

    deleteGroup("cleanup-group");

    // The session's group_name should now be null
    const db = getDb();
    const row = db.prepare("SELECT group_name FROM sessions WHERE id = ?").get(session.id) as any;
    expect(row.group_name).toBeNull();
  });

  it("deleteGroup removes group from getGroups even when sessions existed", () => {
    createGroup("full-delete");
    createSession({ summary: "s1", group_name: "full-delete" });

    deleteGroup("full-delete");

    // Both the group row and session's group_name are cleared
    const groups = getGroups();
    expect(groups).not.toContain("full-delete");
  });

  it("deleteGroup is safe for nonexistent groups", () => {
    // Should not throw
    deleteGroup("never-existed");
    expect(getGroups()).not.toContain("never-existed");
  });

  it("getGroups returns empty array when no groups exist", () => {
    const groups = getGroups();
    expect(groups).toEqual([]);
  });

  it("multiple sessions can share the same group_name", () => {
    createSession({ summary: "s1", group_name: "shared" });
    createSession({ summary: "s2", group_name: "shared" });

    const groups = getGroups();
    const count = groups.filter((g) => g === "shared").length;
    expect(count).toBe(1); // appears once despite two sessions
  });

  it("deleteGroup unassigns all sessions in the group", () => {
    createGroup("multi");
    const s1 = createSession({ summary: "s1", group_name: "multi" });
    const s2 = createSession({ summary: "s2", group_name: "multi" });

    deleteGroup("multi");

    const db = getDb();
    const r1 = db.prepare("SELECT group_name FROM sessions WHERE id = ?").get(s1.id) as any;
    const r2 = db.prepare("SELECT group_name FROM sessions WHERE id = ?").get(s2.id) as any;
    expect(r1.group_name).toBeNull();
    expect(r2.group_name).toBeNull();
  });
});
