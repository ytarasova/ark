import { describe, it, expect } from "bun:test";
import {
  createSession, getSession, listSessions, updateSession,
  softDeleteSession, undeleteSession, listDeletedSessions,
  purgeExpiredDeletes, deleteSession,
} from "../store.js";
import { withTestContext } from "./test-helpers.js";

withTestContext();

describe("soft delete", () => {
  it("softDeleteSession sets status to 'deleting' and deleted_at", () => {
    const s = createSession({ summary: "test" });
    updateSession(s.id, { status: "running" });
    softDeleteSession(s.id);
    const after = getSession(s.id);
    expect(after!.status).toBe("deleting");
    expect(after!.config._pre_delete_status).toBe("running");
    expect(after!.config._deleted_at).toBeDefined();
  });

  it("softDeleteSession hides session from listSessions", () => {
    const s = createSession({ summary: "visible" });
    const s2 = createSession({ summary: "hidden" });
    softDeleteSession(s2.id);
    const list = listSessions();
    expect(list.find(x => x.id === s.id)).toBeDefined();
    expect(list.find(x => x.id === s2.id)).toBeUndefined();
  });

  it("undeleteSession restores previous status and clears delete state", () => {
    const s = createSession({ summary: "restore-me" });
    updateSession(s.id, { status: "stopped" });
    softDeleteSession(s.id);
    undeleteSession(s.id);
    const after = getSession(s.id);
    expect(after!.status).toBe("stopped");
    expect(after!.config._pre_delete_status).toBeUndefined();
    expect(after!.config._deleted_at).toBeUndefined();
  });

  it("listDeletedSessions returns only soft-deleted sessions", () => {
    const s1 = createSession({ summary: "alive" });
    const s2 = createSession({ summary: "dead" });
    softDeleteSession(s2.id);
    const deleted = listDeletedSessions();
    expect(deleted.find(x => x.id === s1.id)).toBeUndefined();
    expect(deleted.find(x => x.id === s2.id)).toBeDefined();
  });

  it("purgeExpiredDeletes removes sessions older than ttl", () => {
    const s = createSession({ summary: "expired" });
    const twoMinAgo = new Date(Date.now() - 120_000).toISOString();
    updateSession(s.id, {
      status: "deleting",
      config: { ...s.config, _deleted_at: twoMinAgo, _pre_delete_status: "running" },
    });
    const purged = purgeExpiredDeletes(90);
    expect(purged).toContain(s.id);
    expect(getSession(s.id)).toBeNull();
  });

  it("purgeExpiredDeletes skips sessions within ttl", () => {
    const s = createSession({ summary: "recent" });
    softDeleteSession(s.id);
    const purged = purgeExpiredDeletes(90);
    expect(purged).not.toContain(s.id);
    expect(getSession(s.id)).not.toBeNull();
  });
});

import { deleteSessionAsync, undeleteSessionAsync } from "../services/session-orchestration.js";

describe("deleteSessionAsync with soft delete", () => {
  it("soft-deletes instead of hard-deleting", async () => {
    const s = createSession({ summary: "soft-kill" });
    updateSession(s.id, { status: "running" });
    const result = await deleteSessionAsync(s.id);
    expect(result.ok).toBe(true);
    const after = getSession(s.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe("deleting");
  });
});

describe("undeleteSessionAsync", () => {
  it("restores a soft-deleted session", async () => {
    const s = createSession({ summary: "restore" });
    updateSession(s.id, { status: "stopped" });
    await deleteSessionAsync(s.id);
    const result = await undeleteSessionAsync(s.id);
    expect(result.ok).toBe(true);
    const after = getSession(s.id);
    expect(after!.status).toBe("stopped");
  });

  it("fails for non-existent session", async () => {
    const result = await undeleteSessionAsync("nope");
    expect(result.ok).toBe(false);
  });
});

describe("soft delete edge cases", () => {
  it("softDeleteSession returns false for non-existent session", () => {
    expect(softDeleteSession("nonexistent")).toBe(false);
  });

  it("softDeleteSession on already-deleted session overwrites state", () => {
    const s = createSession({ summary: "double-delete" });
    updateSession(s.id, { status: "running" });
    softDeleteSession(s.id);
    // Delete again — should update _deleted_at
    const before = getSession(s.id)!;
    const beforeTime = before.config._deleted_at;
    // Small delay to ensure different timestamp
    softDeleteSession(s.id);
    const after = getSession(s.id)!;
    expect(after.status).toBe("deleting");
    expect(after.config._pre_delete_status).toBe("deleting");
  });

  it("undeleteSession returns null for non-existent session", () => {
    expect(undeleteSession("nonexistent")).toBeNull();
  });

  it("undeleteSession returns null for non-deleting session", () => {
    const s = createSession({ summary: "not-deleted" });
    updateSession(s.id, { status: "running" });
    expect(undeleteSession(s.id)).toBeNull();
  });

  it("listSessions with status filter still excludes deleting", () => {
    const s1 = createSession({ summary: "active" });
    const s2 = createSession({ summary: "deleted-running" });
    updateSession(s1.id, { status: "running" });
    updateSession(s2.id, { status: "running" });
    softDeleteSession(s2.id);
    const running = listSessions({ status: "running" });
    expect(running.find(x => x.id === s1.id)).toBeDefined();
    expect(running.find(x => x.id === s2.id)).toBeUndefined();
  });

  it("purgeExpiredDeletes returns empty array when nothing to purge", () => {
    const purged = purgeExpiredDeletes(90);
    expect(purged).toEqual([]);
  });

  it("softDeleteSession preserves config fields other than delete metadata", () => {
    const s = createSession({ summary: "with-config" });
    updateSession(s.id, { status: "running", config: { custom: "data", nested: { a: 1 } } });
    softDeleteSession(s.id);
    const after = getSession(s.id)!;
    expect(after.config.custom).toBe("data");
    expect((after.config.nested as any).a).toBe(1);
    expect(after.config._pre_delete_status).toBe("running");
  });

  it("undeleteSession preserves config fields other than delete metadata", () => {
    const s = createSession({ summary: "restore-config" });
    updateSession(s.id, { status: "stopped", config: { myData: "preserved" } });
    softDeleteSession(s.id);
    undeleteSession(s.id);
    const after = getSession(s.id)!;
    expect(after.config.myData).toBe("preserved");
    expect(after.config._pre_delete_status).toBeUndefined();
    expect(after.config._deleted_at).toBeUndefined();
  });

  it("undeleteSessionAsync returns error message for non-deleted session", async () => {
    const s = createSession({ summary: "not-deleted-async" });
    updateSession(s.id, { status: "running" });
    const result = await undeleteSessionAsync(s.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found or not deleted");
  });

  it("deleteSessionAsync logs session_deleted event", async () => {
    const { getEvents } = await import("../store.js");
    const s = createSession({ summary: "event-check" });
    updateSession(s.id, { status: "pending" });
    await deleteSessionAsync(s.id);
    const events = getEvents(s.id);
    expect(events.some(e => e.type === "session_deleted")).toBe(true);
  });
});
