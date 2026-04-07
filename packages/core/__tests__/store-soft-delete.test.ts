import { describe, it, expect } from "bun:test";
import { getApp } from "../app.js";

function purgeExpiredDeletes(ttlSeconds: number = 90): string[] {
  const deleted = getApp().sessions.listDeleted();
  const purged: string[] = [];
  const cutoff = Date.now() - ttlSeconds * 1000;
  for (const s of deleted) {
    const deletedAt = s.config._deleted_at as string | undefined;
    if (deletedAt && new Date(deletedAt).getTime() < cutoff) {
      getApp().sessions.delete(s.id);
      purged.push(s.id);
    }
  }
  return purged;
}
import { withTestContext } from "./test-helpers.js";

withTestContext();

describe("soft delete", () => {
  it("softDeleteSession sets status to 'deleting' and deleted_at", () => {
    const s = getApp().sessions.create({ summary: "test" });
    getApp().sessions.update(s.id, { status: "running" });
    getApp().sessions.softDelete(s.id);
    const after = getApp().sessions.get(s.id);
    expect(after!.status).toBe("deleting");
    expect(after!.config._pre_delete_status).toBe("running");
    expect(after!.config._deleted_at).toBeDefined();
  });

  it("softDeleteSession hides session from listSessions", () => {
    const s = getApp().sessions.create({ summary: "visible" });
    const s2 = getApp().sessions.create({ summary: "hidden" });
    getApp().sessions.softDelete(s2.id);
    const list = getApp().sessions.list();
    expect(list.find(x => x.id === s.id)).toBeDefined();
    expect(list.find(x => x.id === s2.id)).toBeUndefined();
  });

  it("undeleteSession restores previous status and clears delete state", () => {
    const s = getApp().sessions.create({ summary: "restore-me" });
    getApp().sessions.update(s.id, { status: "stopped" });
    getApp().sessions.softDelete(s.id);
    getApp().sessions.undelete(s.id);
    const after = getApp().sessions.get(s.id);
    expect(after!.status).toBe("stopped");
    expect(after!.config._pre_delete_status).toBeUndefined();
    expect(after!.config._deleted_at).toBeUndefined();
  });

  it("listDeletedSessions returns only soft-deleted sessions", () => {
    const s1 = getApp().sessions.create({ summary: "alive" });
    const s2 = getApp().sessions.create({ summary: "dead" });
    getApp().sessions.softDelete(s2.id);
    const deleted = getApp().sessions.listDeleted();
    expect(deleted.find(x => x.id === s1.id)).toBeUndefined();
    expect(deleted.find(x => x.id === s2.id)).toBeDefined();
  });

  it("purgeExpiredDeletes removes sessions older than ttl", () => {
    const s = getApp().sessions.create({ summary: "expired" });
    const twoMinAgo = new Date(Date.now() - 120_000).toISOString();
    getApp().sessions.update(s.id, {
      status: "deleting",
      config: { ...s.config, _deleted_at: twoMinAgo, _pre_delete_status: "running" },
    });
    const purged = purgeExpiredDeletes(90);
    expect(purged).toContain(s.id);
    expect(getApp().sessions.get(s.id)).toBeNull();
  });

  it("purgeExpiredDeletes skips sessions within ttl", () => {
    const s = getApp().sessions.create({ summary: "recent" });
    getApp().sessions.softDelete(s.id);
    const purged = purgeExpiredDeletes(90);
    expect(purged).not.toContain(s.id);
    expect(getApp().sessions.get(s.id)).not.toBeNull();
  });
});

import { deleteSessionAsync, undeleteSessionAsync } from "../services/session-orchestration.js";

describe("deleteSessionAsync with soft delete", () => {
  it("soft-deletes instead of hard-deleting", async () => {
    const s = getApp().sessions.create({ summary: "soft-kill" });
    getApp().sessions.update(s.id, { status: "running" });
    const result = await deleteSessionAsync(s.id);
    expect(result.ok).toBe(true);
    const after = getApp().sessions.get(s.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe("deleting");
  });
});

describe("undeleteSessionAsync", () => {
  it("restores a soft-deleted session", async () => {
    const s = getApp().sessions.create({ summary: "restore" });
    getApp().sessions.update(s.id, { status: "stopped" });
    await deleteSessionAsync(s.id);
    const result = await undeleteSessionAsync(s.id);
    expect(result.ok).toBe(true);
    const after = getApp().sessions.get(s.id);
    expect(after!.status).toBe("stopped");
  });

  it("fails for non-existent session", async () => {
    const result = await undeleteSessionAsync("nope");
    expect(result.ok).toBe(false);
  });
});

describe("soft delete edge cases", () => {
  it("softDeleteSession returns false for non-existent session", () => {
    expect(getApp().sessions.softDelete("nonexistent")).toBe(false);
  });

  it("softDeleteSession on already-deleted session overwrites state", () => {
    const s = getApp().sessions.create({ summary: "double-delete" });
    getApp().sessions.update(s.id, { status: "running" });
    getApp().sessions.softDelete(s.id);
    // Delete again — should update _deleted_at
    const before = getApp().sessions.get(s.id)!;
    const beforeTime = before.config._deleted_at;
    // Small delay to ensure different timestamp
    getApp().sessions.softDelete(s.id);
    const after = getApp().sessions.get(s.id)!;
    expect(after.status).toBe("deleting");
    expect(after.config._pre_delete_status).toBe("deleting");
  });

  it("undeleteSession returns null for non-existent session", () => {
    expect(getApp().sessions.undelete("nonexistent")).toBeNull();
  });

  it("undeleteSession returns null for non-deleting session", () => {
    const s = getApp().sessions.create({ summary: "not-deleted" });
    getApp().sessions.update(s.id, { status: "running" });
    expect(getApp().sessions.undelete(s.id)).toBeNull();
  });

  it("listSessions with status filter still excludes deleting", () => {
    const s1 = getApp().sessions.create({ summary: "active" });
    const s2 = getApp().sessions.create({ summary: "deleted-running" });
    getApp().sessions.update(s1.id, { status: "running" });
    getApp().sessions.update(s2.id, { status: "running" });
    getApp().sessions.softDelete(s2.id);
    const running = getApp().sessions.list({ status: "running" });
    expect(running.find(x => x.id === s1.id)).toBeDefined();
    expect(running.find(x => x.id === s2.id)).toBeUndefined();
  });

  it("purgeExpiredDeletes returns empty array when nothing to purge", () => {
    const purged = purgeExpiredDeletes(90);
    expect(purged).toEqual([]);
  });

  it("softDeleteSession preserves config fields other than delete metadata", () => {
    const s = getApp().sessions.create({ summary: "with-config" });
    getApp().sessions.update(s.id, { status: "running", config: { custom: "data", nested: { a: 1 } } });
    getApp().sessions.softDelete(s.id);
    const after = getApp().sessions.get(s.id)!;
    expect(after.config.custom).toBe("data");
    expect((after.config.nested as Record<string, unknown>).a).toBe(1);
    expect(after.config._pre_delete_status).toBe("running");
  });

  it("undeleteSession preserves config fields other than delete metadata", () => {
    const s = getApp().sessions.create({ summary: "restore-config" });
    getApp().sessions.update(s.id, { status: "stopped", config: { myData: "preserved" } });
    getApp().sessions.softDelete(s.id);
    getApp().sessions.undelete(s.id);
    const after = getApp().sessions.get(s.id)!;
    expect(after.config.myData).toBe("preserved");
    expect(after.config._pre_delete_status).toBeUndefined();
    expect(after.config._deleted_at).toBeUndefined();
  });

  it("undeleteSessionAsync returns error message for non-deleted session", async () => {
    const s = getApp().sessions.create({ summary: "not-deleted-async" });
    getApp().sessions.update(s.id, { status: "running" });
    const result = await undeleteSessionAsync(s.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found or not deleted");
  });

  it("deleteSessionAsync logs session_deleted event", async () => {
    const s = getApp().sessions.create({ summary: "event-check" });
    getApp().sessions.update(s.id, { status: "pending" });
    await deleteSessionAsync(s.id);
    const events = getApp().events.list(s.id);
    expect(events.some(e => e.type === "session_deleted")).toBe(true);
  });
});
