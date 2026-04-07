/**
 * Tests for groups table — createGroup, getGroups, deleteGroup.
 * Verifies group persistence, union with session group_names,
 * and cascade unassignment on delete.
 */

import { describe, it, expect } from "bun:test";
import { getApp } from "../app.js";
import { withTestContext } from "./test-helpers.js";

withTestContext();

describe("groups table", () => {
  it("createGroup persists a group to the DB", () => {
    getApp().sessions.createGroup("alpha");
    const groups = getApp().sessions.getGroupNames();
    expect(groups).toContain("alpha");
  });

  it("createGroup is idempotent (INSERT OR IGNORE)", () => {
    getApp().sessions.createGroup("beta");
    getApp().sessions.createGroup("beta");
    const groups = getApp().sessions.getGroupNames();
    // Should appear only once — indexOf === lastIndexOf proves no duplicates
    expect(groups).toContain("beta");
    expect(groups.indexOf("beta")).toBe(groups.lastIndexOf("beta"));
  });

  it("getGroups returns groups from the groups table", () => {
    getApp().sessions.createGroup("group-a");
    getApp().sessions.createGroup("group-b");
    const groups = getApp().sessions.getGroupNames();
    expect(groups).toContain("group-a");
    expect(groups).toContain("group-b");
  });

  it("getGroups returns group_names from sessions", () => {
    getApp().sessions.create({ summary: "session with group", group_name: "session-group" });
    const groups = getApp().sessions.getGroupNames();
    expect(groups).toContain("session-group");
  });

  it("getGroups returns union of both groups table and session group_names", () => {
    getApp().sessions.createGroup("table-group");
    getApp().sessions.create({ summary: "s1", group_name: "session-group" });

    const groups = getApp().sessions.getGroupNames();
    expect(groups).toContain("table-group");
    expect(groups).toContain("session-group");
  });

  it("getGroups deduplicates when same name in both groups table and sessions", () => {
    getApp().sessions.createGroup("shared-name");
    getApp().sessions.create({ summary: "s1", group_name: "shared-name" });

    const groups = getApp().sessions.getGroupNames();
    expect(groups).toContain("shared-name");
    expect(groups.indexOf("shared-name")).toBe(groups.lastIndexOf("shared-name"));
  });

  it("getGroups returns sorted results", () => {
    getApp().sessions.createGroup("charlie");
    getApp().sessions.createGroup("alpha");
    getApp().sessions.createGroup("bravo");

    const groups = getApp().sessions.getGroupNames();
    const sorted = [...groups].sort();
    expect(groups).toEqual(sorted);
  });

  it("empty groups appear in getGroups", () => {
    // Create a group with no sessions assigned
    getApp().sessions.createGroup("empty-group");
    const groups = getApp().sessions.getGroupNames();
    expect(groups).toContain("empty-group");
  });

  it("deleteGroup removes the group from the groups table", () => {
    getApp().sessions.createGroup("to-delete");
    expect(getApp().sessions.getGroupNames()).toContain("to-delete");

    getApp().sessions.deleteGroup("to-delete");
    // Group should be gone unless a session still references it
    expect(getApp().sessions.getGroupNames()).not.toContain("to-delete");
  });

  it("deleteGroup unassigns sessions from the deleted group", () => {
    getApp().sessions.createGroup("cleanup-group");
    const session = getApp().sessions.create({ summary: "assigned", group_name: "cleanup-group" });

    getApp().sessions.deleteGroup("cleanup-group");

    // The session's group_name should now be null
    const db = getApp().db;
    const row = db.prepare("SELECT group_name FROM sessions WHERE id = ?").get(session.id) as { group_name: string | null } | undefined;
    expect(row.group_name).toBeNull();
  });

  it("deleteGroup removes group from getGroups even when sessions existed", () => {
    getApp().sessions.createGroup("full-delete");
    getApp().sessions.create({ summary: "s1", group_name: "full-delete" });

    getApp().sessions.deleteGroup("full-delete");

    // Both the group row and session's group_name are cleared
    const groups = getApp().sessions.getGroupNames();
    expect(groups).not.toContain("full-delete");
  });

  it("deleteGroup is safe for nonexistent groups", () => {
    // Should not throw
    getApp().sessions.deleteGroup("never-existed");
    expect(getApp().sessions.getGroupNames()).not.toContain("never-existed");
  });

  it("getGroups returns empty array when no groups exist", () => {
    const groups = getApp().sessions.getGroupNames();
    expect(groups).toEqual([]);
  });

  it("multiple sessions can share the same group_name", () => {
    getApp().sessions.create({ summary: "s1", group_name: "shared" });
    getApp().sessions.create({ summary: "s2", group_name: "shared" });

    const groups = getApp().sessions.getGroupNames();
    expect(groups).toContain("shared");
    expect(groups.indexOf("shared")).toBe(groups.lastIndexOf("shared")); // appears once despite two sessions
  });

  it("deleteGroup unassigns all sessions in the group", () => {
    getApp().sessions.createGroup("multi");
    const s1 = getApp().sessions.create({ summary: "s1", group_name: "multi" });
    const s2 = getApp().sessions.create({ summary: "s2", group_name: "multi" });

    getApp().sessions.deleteGroup("multi");

    const db = getApp().db;
    const r1 = db.prepare("SELECT group_name FROM sessions WHERE id = ?").get(s1.id) as { group_name: string | null } | undefined;
    const r2 = db.prepare("SELECT group_name FROM sessions WHERE id = ?").get(s2.id) as { group_name: string | null } | undefined;
    expect(r1.group_name).toBeNull();
    expect(r2.group_name).toBeNull();
  });
});
