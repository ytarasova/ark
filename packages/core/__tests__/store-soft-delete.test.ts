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
