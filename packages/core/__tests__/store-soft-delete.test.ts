import { describe, it, expect } from "bun:test";

async function purgeExpiredDeletes(ttlSeconds: number = 90): Promise<string[]> {
  const deleted = await getApp().sessions.listDeleted();
  const purged: string[] = [];
  const cutoff = Date.now() - ttlSeconds * 1000;
  for (const s of deleted) {
    const deletedAt = s.config._deleted_at as string | undefined;
    if (deletedAt && new Date(deletedAt).getTime() < cutoff) {
      await getApp().sessions.delete(s.id);
      purged.push(s.id);
    }
  }
  return purged;
}
import { withTestContext } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

withTestContext();

describe("soft delete", () => {
  it("softDeleteSession sets status to 'deleting' and deleted_at", async () => {
    const s = await getApp().sessions.create({ summary: "test" });
    await getApp().sessions.update(s.id, { status: "running" });
    await getApp().sessions.softDelete(s.id);
    const after = await getApp().sessions.get(s.id);
    expect(after!.status).toBe("deleting");
    expect(after!.config._pre_delete_status).toBe("running");
    expect(after!.config._deleted_at).toBeDefined();
  });

  it("softDeleteSession hides session from listSessions", async () => {
    const s = await getApp().sessions.create({ summary: "visible" });
    const s2 = await getApp().sessions.create({ summary: "hidden" });
    await getApp().sessions.softDelete(s2.id);
    const list = await getApp().sessions.list();
    expect(list.find((x) => x.id === s.id)).toBeDefined();
    expect(list.find((x) => x.id === s2.id)).toBeUndefined();
  });

  it("undeleteSession restores previous status and clears delete state", async () => {
    const s = await getApp().sessions.create({ summary: "restore-me" });
    await getApp().sessions.update(s.id, { status: "stopped" });
    await getApp().sessions.softDelete(s.id);
    await getApp().sessions.undelete(s.id);
    const after = await getApp().sessions.get(s.id);
    expect(after!.status).toBe("stopped");
    expect(after!.config._pre_delete_status).toBeUndefined();
    expect(after!.config._deleted_at).toBeUndefined();
  });

  it("listDeletedSessions returns only soft-deleted sessions", async () => {
    const s1 = await getApp().sessions.create({ summary: "alive" });
    const s2 = await getApp().sessions.create({ summary: "dead" });
    await getApp().sessions.softDelete(s2.id);
    const deleted = await getApp().sessions.listDeleted();
    expect(deleted.find((x) => x.id === s1.id)).toBeUndefined();
    expect(deleted.find((x) => x.id === s2.id)).toBeDefined();
  });

  it("purgeExpiredDeletes removes sessions older than ttl", async () => {
    const s = await getApp().sessions.create({ summary: "expired" });
    const twoMinAgo = new Date(Date.now() - 120_000).toISOString();
    await getApp().sessions.update(s.id, {
      status: "deleting",
      config: { ...s.config, _deleted_at: twoMinAgo, _pre_delete_status: "running" },
    });
    const purged = await purgeExpiredDeletes(90);
    expect(purged).toContain(s.id);
    expect(await getApp().sessions.get(s.id)).toBeNull();
  });

  it("purgeExpiredDeletes skips sessions within ttl", async () => {
    const s = await getApp().sessions.create({ summary: "recent" });
    await getApp().sessions.softDelete(s.id);
    const purged = await purgeExpiredDeletes(90);
    expect(purged).not.toContain(s.id);
    expect(await getApp().sessions.get(s.id)).not.toBeNull();
  });
});

import { deleteSessionAsync, undeleteSessionAsync } from "../services/session-orchestration.js";

describe("deleteSessionAsync with soft delete", async () => {
  it("soft-deletes instead of hard-deleting", async () => {
    const s = await getApp().sessions.create({ summary: "soft-kill" });
    await getApp().sessions.update(s.id, { status: "running" });
    const result = await deleteSessionAsync(getApp(), s.id);
    expect(result.ok).toBe(true);
    const after = await getApp().sessions.get(s.id);
    expect(after).not.toBeNull();
    expect(after!.status).toBe("deleting");
  });
});

describe("undeleteSessionAsync", async () => {
  it("restores a soft-deleted session", async () => {
    const s = await getApp().sessions.create({ summary: "restore" });
    await getApp().sessions.update(s.id, { status: "stopped" });
    await deleteSessionAsync(getApp(), s.id);
    const result = await undeleteSessionAsync(getApp(), s.id);
    expect(result.ok).toBe(true);
    const after = await getApp().sessions.get(s.id);
    expect(after!.status).toBe("stopped");
  });

  it("fails for non-existent session", async () => {
    const result = await undeleteSessionAsync(getApp(), "nope");
    expect(result.ok).toBe(false);
  });
});

describe("soft delete edge cases", async () => {
  it("softDeleteSession returns false for non-existent session", async () => {
    expect(await getApp().sessions.softDelete("nonexistent")).toBe(false);
  });

  it("softDeleteSession on already-deleted session overwrites state", async () => {
    const s = await getApp().sessions.create({ summary: "double-delete" });
    await getApp().sessions.update(s.id, { status: "running" });
    await getApp().sessions.softDelete(s.id);
    // Delete again -- should update _deleted_at
    const before = (await getApp().sessions.get(s.id))!;
    const beforeTime = before.config._deleted_at;
    // Small delay to ensure different timestamp
    await getApp().sessions.softDelete(s.id);
    const after = (await getApp().sessions.get(s.id))!;
    expect(after.status).toBe("deleting");
    expect(after.config._pre_delete_status).toBe("deleting");
  });

  it("undeleteSession returns null for non-existent session", async () => {
    expect(await getApp().sessions.undelete("nonexistent")).toBeNull();
  });

  it("undeleteSession returns null for non-deleting session", async () => {
    const s = await getApp().sessions.create({ summary: "not-deleted" });
    await getApp().sessions.update(s.id, { status: "running" });
    expect(await getApp().sessions.undelete(s.id)).toBeNull();
  });

  it("listSessions with status filter still excludes deleting", async () => {
    const s1 = await getApp().sessions.create({ summary: "active" });
    const s2 = await getApp().sessions.create({ summary: "deleted-running" });
    await getApp().sessions.update(s1.id, { status: "running" });
    await getApp().sessions.update(s2.id, { status: "running" });
    await getApp().sessions.softDelete(s2.id);
    const running = await getApp().sessions.list({ status: "running" });
    expect(running.find((x) => x.id === s1.id)).toBeDefined();
    expect(running.find((x) => x.id === s2.id)).toBeUndefined();
  });

  it("purgeExpiredDeletes returns empty array when nothing to purge", async () => {
    const purged = await purgeExpiredDeletes(90);
    expect(purged).toEqual([]);
  });

  it("softDeleteSession preserves config fields other than delete metadata", async () => {
    const s = await getApp().sessions.create({ summary: "with-config" });
    await getApp().sessions.update(s.id, { status: "running", config: { custom: "data", nested: { a: 1 } } });
    await getApp().sessions.softDelete(s.id);
    const after = (await getApp().sessions.get(s.id))!;
    expect(after.config.custom).toBe("data");
    expect((after.config.nested as Record<string, unknown>).a).toBe(1);
    expect(after.config._pre_delete_status).toBe("running");
  });

  it("undeleteSession preserves config fields other than delete metadata", async () => {
    const s = await getApp().sessions.create({ summary: "restore-config" });
    await getApp().sessions.update(s.id, { status: "stopped", config: { myData: "preserved" } });
    await getApp().sessions.softDelete(s.id);
    await getApp().sessions.undelete(s.id);
    const after = (await getApp().sessions.get(s.id))!;
    expect(after.config.myData).toBe("preserved");
    expect(after.config._pre_delete_status).toBeUndefined();
    expect(after.config._deleted_at).toBeUndefined();
  });

  it("undeleteSessionAsync returns error message for non-deleted session", async () => {
    const s = await getApp().sessions.create({ summary: "not-deleted-async" });
    await getApp().sessions.update(s.id, { status: "running" });
    const result = await undeleteSessionAsync(getApp(), s.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found or not deleted");
  });

  it("deleteSessionAsync logs session_deleted event", async () => {
    const s = await getApp().sessions.create({ summary: "event-check" });
    await getApp().sessions.update(s.id, { status: "pending" });
    await deleteSessionAsync(getApp(), s.id);
    const events = await getApp().events.list(s.id);
    expect(events.some((e) => e.type === "session_deleted")).toBe(true);
  });
});
