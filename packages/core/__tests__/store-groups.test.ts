/**
 * Tests for groups table -- createGroup, getGroups, deleteGroup.
 * Verifies group persistence, union with session group_names,
 * and cascade unassignment on delete.
 */

import { describe, it, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

withTestContext();

describe("groups table", () => {
  it("createGroup persists a group to the DB", async () => {
    await getApp().sessions.createGroup("alpha");
    const groups = await getApp().sessions.getGroupNames();
    expect(groups).toContain("alpha");
  });

  it("createGroup is idempotent (INSERT OR IGNORE)", async () => {
    await getApp().sessions.createGroup("beta");
    await getApp().sessions.createGroup("beta");
    const groups = await getApp().sessions.getGroupNames();
    // Should appear only once -- indexOf === lastIndexOf proves no duplicates
    expect(groups).toContain("beta");
    expect(groups.indexOf("beta")).toBe(groups.lastIndexOf("beta"));
  });

  it("getGroups returns groups from the groups table", async () => {
    await getApp().sessions.createGroup("group-a");
    await getApp().sessions.createGroup("group-b");
    const groups = await getApp().sessions.getGroupNames();
    expect(groups).toContain("group-a");
    expect(groups).toContain("group-b");
  });

  it("getGroups returns group_names from sessions", async () => {
    await getApp().sessions.create({ summary: "session with group", group_name: "session-group" });
    const groups = await getApp().sessions.getGroupNames();
    expect(groups).toContain("session-group");
  });

  it("getGroups returns union of both groups table and session group_names", async () => {
    await getApp().sessions.createGroup("table-group");
    await getApp().sessions.create({ summary: "s1", group_name: "session-group" });

    const groups = await getApp().sessions.getGroupNames();
    expect(groups).toContain("table-group");
    expect(groups).toContain("session-group");
  });

  it("getGroups deduplicates when same name in both groups table and sessions", async () => {
    await getApp().sessions.createGroup("shared-name");
    await getApp().sessions.create({ summary: "s1", group_name: "shared-name" });

    const groups = await getApp().sessions.getGroupNames();
    expect(groups).toContain("shared-name");
    expect(groups.indexOf("shared-name")).toBe(groups.lastIndexOf("shared-name"));
  });

  it("getGroups returns sorted results", async () => {
    await getApp().sessions.createGroup("charlie");
    await getApp().sessions.createGroup("alpha");
    await getApp().sessions.createGroup("bravo");

    const groups = await getApp().sessions.getGroupNames();
    const sorted = [...groups].sort();
    expect(groups).toEqual(sorted);
  });

  it("empty groups appear in getGroups", async () => {
    // Create a group with no sessions assigned
    await getApp().sessions.createGroup("empty-group");
    const groups = await getApp().sessions.getGroupNames();
    expect(groups).toContain("empty-group");
  });

  it("deleteGroup removes the group from the groups table", async () => {
    await getApp().sessions.createGroup("to-delete");
    expect(await getApp().sessions.getGroupNames()).toContain("to-delete");

    await getApp().sessions.deleteGroup("to-delete");
    // Group should be gone unless a session still references it
    expect(await getApp().sessions.getGroupNames()).not.toContain("to-delete");
  });

  it("deleteGroup unassigns sessions from the deleted group", async () => {
    await getApp().sessions.createGroup("cleanup-group");
    const session = await getApp().sessions.create({ summary: "assigned", group_name: "cleanup-group" });

    await getApp().sessions.deleteGroup("cleanup-group");

    // The session's group_name should now be null
    const db = getApp().db;
    const row = (await db.prepare("SELECT group_name FROM sessions WHERE id = ?").get(session.id)) as
      | { group_name: string | null }
      | undefined;
    expect(row.group_name).toBeNull();
  });

  it("deleteGroup removes group from getGroups even when sessions existed", async () => {
    await getApp().sessions.createGroup("full-delete");
    await getApp().sessions.create({ summary: "s1", group_name: "full-delete" });

    await getApp().sessions.deleteGroup("full-delete");

    // Both the group row and session's group_name are cleared
    const groups = await getApp().sessions.getGroupNames();
    expect(groups).not.toContain("full-delete");
  });

  it("deleteGroup is safe for nonexistent groups", async () => {
    // Should not throw
    await getApp().sessions.deleteGroup("never-existed");
    expect(await getApp().sessions.getGroupNames()).not.toContain("never-existed");
  });

  it("getGroups returns empty array when no groups exist", async () => {
    const groups = await getApp().sessions.getGroupNames();
    expect(groups).toEqual([]);
  });

  it("multiple sessions can share the same group_name", async () => {
    await getApp().sessions.create({ summary: "s1", group_name: "shared" });
    await getApp().sessions.create({ summary: "s2", group_name: "shared" });

    const groups = await getApp().sessions.getGroupNames();
    expect(groups).toContain("shared");
    expect(groups.indexOf("shared")).toBe(groups.lastIndexOf("shared")); // appears once despite two sessions
  });

  it("deleteGroup unassigns all sessions in the group", async () => {
    await getApp().sessions.createGroup("multi");
    const s1 = await getApp().sessions.create({ summary: "s1", group_name: "multi" });
    const s2 = await getApp().sessions.create({ summary: "s2", group_name: "multi" });

    await getApp().sessions.deleteGroup("multi");

    const db = getApp().db;
    const r1 = (await db.prepare("SELECT group_name FROM sessions WHERE id = ?").get(s1.id)) as
      | { group_name: string | null }
      | undefined;
    const r2 = (await db.prepare("SELECT group_name FROM sessions WHERE id = ?").get(s2.id)) as
      | { group_name: string | null }
      | undefined;
    expect(r1.group_name).toBeNull();
    expect(r2.group_name).toBeNull();
  });
});
