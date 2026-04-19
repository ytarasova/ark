import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { IDatabase } from "../../database.js";
import { SessionRepository } from "../session.js";
import { initSchema } from "../schema.js";
import type { SessionStatus, SessionConfig } from "../../../types/index.js";
import { SESSION_STATUSES } from "../../../types/index.js";

let db: IDatabase;
let repo: SessionRepository;

beforeEach(() => {
  db = new BunSqliteAdapter(new Database(":memory:"));
  initSchema(db);
  repo = new SessionRepository(db);
});

describe("SessionRepository", () => {
  // ── create ──────────────────────────────────────────────────────────────

  it("create returns session with correct defaults", () => {
    const s = repo.create({});
    // Session IDs are `s-<10 url-safe lowercase alphanumeric>` via nanoid.
    expect(s.id).toMatch(/^s-[0-9a-z]{10}$/);
    expect(s.status).toBe("pending");
    expect(s.flow).toBe("default");
    expect(s.config).toEqual({});
    expect(s.created_at).toBeTruthy();
    expect(s.updated_at).toBeTruthy();
  });

  it("create generates unique, collision-free IDs across a batch", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const s = repo.create({});
      expect(s.id).toMatch(/^s-[0-9a-z]{10}$/);
      expect(ids.has(s.id)).toBe(false);
      ids.add(s.id);
    }
    expect(ids.size).toBe(200);
  });

  it("create stores ticket, summary, repo and generates branch", () => {
    const s = repo.create({ ticket: "PROJ-123", summary: "Fix the bug", repo: "my/repo" });
    expect(s.ticket).toBe("PROJ-123");
    expect(s.summary).toBe("Fix the bug");
    expect(s.repo).toBe("my/repo");
    expect(s.branch).toBe("feat/proj-123-fix-the-bug");
  });

  it("create sanitizes special characters from branch name", () => {
    const s = repo.create({ ticket: "PROJ-456", summary: "Fix login, signup & OAuth" });
    expect(s.branch).toBe("feat/proj-456-fix-login-signup-oauth");
  });

  it("create with no ticket sets branch to null", () => {
    const s = repo.create({ summary: "No ticket work" });
    expect(s.branch).toBeNull();
  });

  it("create with custom flow and group_name", () => {
    const s = repo.create({ flow: "quick", group_name: "team-alpha" });
    expect(s.flow).toBe("quick");
    expect(s.group_name).toBe("team-alpha");
  });

  it("create stores config as JSON", () => {
    const s = repo.create({ config: { model_override: "opus" } });
    expect(s.config).toEqual({ model_override: "opus" });
  });

  it("create stores agent field", () => {
    const s = repo.create({ agent: "planner" });
    expect(s.agent).toBe("planner");
  });

  // ── get ─────────────────────────────────────────────────────────────────

  it("get returns null for nonexistent", () => {
    expect(repo.get("s-000000")).toBeNull();
  });

  it("get returns session with parsed config", () => {
    const created = repo.create({ config: { turns: 5 } });
    const fetched = repo.get(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.config.turns).toBe(5);
  });

  // ── list ────────────────────────────────────────────────────────────────

  it("list returns all created sessions", () => {
    repo.create({ summary: "first" });
    repo.create({ summary: "second" });
    const sessions = repo.list();
    expect(sessions.length).toBe(2);
    const summaries = sessions.map((s) => s.summary).sort();
    expect(summaries).toEqual(["first", "second"]);
  });

  it("list filters by status", () => {
    const s1 = repo.create({});
    repo.create({});
    repo.update(s1.id, { status: "running" as SessionStatus });
    const running = repo.list({ status: "running" });
    expect(running.length).toBe(1);
    expect(running[0].id).toBe(s1.id);
  });

  it("list filters by each user-facing status", () => {
    for (const status of SESSION_STATUSES) {
      const s = repo.create({});
      repo.update(s.id, { status: status as SessionStatus });
      const filtered = repo.list({ status: status as SessionStatus });
      expect(filtered.some((r) => r.id === s.id)).toBe(true);
    }
  });

  it("list filters by repo", () => {
    repo.create({ repo: "a/b" });
    repo.create({ repo: "c/d" });
    const result = repo.list({ repo: "a/b" });
    expect(result.length).toBe(1);
    expect(result[0].repo).toBe("a/b");
  });

  it("list filters by flow", () => {
    repo.create({ flow: "quick" });
    repo.create({ flow: "default" });
    const result = repo.list({ flow: "quick" });
    expect(result.length).toBe(1);
    expect(result[0].flow).toBe("quick");
  });

  it("list excludes archived sessions by default", () => {
    const s1 = repo.create({ summary: "active" });
    const s2 = repo.create({ summary: "old" });
    repo.update(s2.id, { status: "archived" as SessionStatus });
    const all = repo.list();
    expect(all.some((s) => s.id === s1.id)).toBe(true);
    expect(all.some((s) => s.id === s2.id)).toBe(false);
  });

  it("list returns archived sessions when status filter is archived", () => {
    const s1 = repo.create({ summary: "active" });
    const s2 = repo.create({ summary: "old" });
    repo.update(s2.id, { status: "archived" as SessionStatus });
    const archived = repo.list({ status: "archived" });
    expect(archived.some((s) => s.id === s2.id)).toBe(true);
    expect(archived.some((s) => s.id === s1.id)).toBe(false);
  });

  it("list excludes deleting sessions", () => {
    const s = repo.create({});
    repo.softDelete(s.id);
    expect(repo.list().length).toBe(0);
  });

  it("list respects limit", () => {
    repo.create({});
    repo.create({});
    repo.create({});
    const result = repo.list({ limit: 2 });
    expect(result.length).toBe(2);
  });

  // ── update ──────────────────────────────────────────────────────────────

  it("update changes fields and returns updated session", () => {
    const s = repo.create({});
    const updated = repo.update(s.id, { status: "running" as SessionStatus, stage: "plan" });
    expect(updated!.status).toBe("running");
    expect(updated!.stage).toBe("plan");
    // updated_at is refreshed (may be same ms in fast tests, so just check it exists)
    expect(updated!.updated_at).toBeTruthy();
  });

  it("update skips unknown columns", () => {
    const s = repo.create({});
    const updated = repo.update(s.id, { bogusField: "nope" } as Record<string, unknown>);
    expect(updated).not.toBeNull();
    // Should not throw, just silently ignore
  });

  it("update skips id and created_at", () => {
    const s = repo.create({});
    const updated = repo.update(s.id, { id: "s-hacked", created_at: "1999-01-01" } as Record<string, unknown>);
    expect(updated!.id).toBe(s.id);
    expect(updated!.created_at).toBe(s.created_at);
  });

  it("update handles config as JSON", () => {
    const s = repo.create({});
    const updated = repo.update(s.id, { config: { turns: 10 } as SessionConfig });
    expect(updated!.config).toEqual({ turns: 10 });
  });

  it("update returns null for nonexistent id", () => {
    // update always tries to return get(id) which will be null
    const result = repo.update("s-ffffff", { status: "running" as SessionStatus });
    expect(result).toBeNull();
  });

  // ── delete ──────────────────────────────────────────────────────────────

  it("delete removes session and returns true", () => {
    const s = repo.create({});
    expect(repo.delete(s.id)).toBe(true);
    expect(repo.get(s.id)).toBeNull();
  });

  it("delete returns false for nonexistent", () => {
    expect(repo.delete("s-nope00")).toBe(false);
  });

  it("delete also removes associated events", () => {
    const s = repo.create({});
    // Insert an event directly
    db.prepare("INSERT INTO events (track_id, type, created_at) VALUES (?, 'test', ?)").run(
      s.id,
      new Date().toISOString(),
    );
    repo.delete(s.id);
    const events = db.prepare("SELECT * FROM events WHERE track_id = ?").all(s.id);
    expect(events.length).toBe(0);
  });

  // ── softDelete / undelete ───────────────────────────────────────────────

  it("softDelete sets status to deleting and stores previous status", () => {
    const s = repo.create({});
    repo.update(s.id, { status: "running" as SessionStatus });
    expect(repo.softDelete(s.id)).toBe(true);
    const deleted = repo.get(s.id);
    expect(deleted!.status).toBe("deleting");
    expect(deleted!.config._pre_delete_status).toBe("running");
    expect(deleted!.config._deleted_at).toBeTruthy();
  });

  it("softDelete returns false for nonexistent", () => {
    expect(repo.softDelete("s-nope00")).toBe(false);
  });

  it("undelete restores previous status", () => {
    const s = repo.create({});
    repo.update(s.id, { status: "running" as SessionStatus });
    repo.softDelete(s.id);
    const restored = repo.undelete(s.id);
    expect(restored!.status).toBe("running");
    expect(restored!.config._pre_delete_status).toBeUndefined();
    expect(restored!.config._deleted_at).toBeUndefined();
  });

  it("undelete returns null if not deleting", () => {
    const s = repo.create({});
    expect(repo.undelete(s.id)).toBeNull();
  });

  // ── claim ───────────────────────────────────────────────────────────────

  it("claim succeeds when expected status matches", () => {
    const s = repo.create({});
    expect(repo.claim(s.id, "pending", "running")).toBe(true);
    expect(repo.get(s.id)!.status).toBe("running");
  });

  it("claim fails when expected status does not match", () => {
    const s = repo.create({});
    expect(repo.claim(s.id, "running", "completed")).toBe(false);
    expect(repo.get(s.id)!.status).toBe("pending");
  });

  it("claim with extra fields", () => {
    const s = repo.create({});
    repo.claim(s.id, "pending", "running", { agent: "implementer", stage: "code" });
    const updated = repo.get(s.id)!;
    expect(updated.status).toBe("running");
    expect(updated.agent).toBe("implementer");
    expect(updated.stage).toBe("code");
  });

  // ── purgeDeleted ────────────────────────────────────────────────────────

  it("purgeDeleted removes expired soft-deleted sessions", () => {
    const s = repo.create({});
    // Manually set _deleted_at to a very old time
    repo.update(s.id, {
      status: "deleting" as SessionStatus,
      config: { _pre_delete_status: "pending", _deleted_at: "2000-01-01T00:00:00.000Z" } as SessionConfig,
    });
    const purged = repo.purgeDeleted(1000); // 1 second TTL
    expect(purged).toBe(1);
    expect(repo.get(s.id)).toBeNull();
  });

  it("purgeDeleted skips recently deleted sessions", () => {
    const s = repo.create({});
    repo.softDelete(s.id);
    const purged = repo.purgeDeleted(999_999_999); // huge TTL
    expect(purged).toBe(0);
  });

  // ── channelPort ─────────────────────────────────────────────────────────

  it("channelPort returns deterministic port in range", () => {
    const port = repo.channelPort("s-abc123");
    expect(port).toBeGreaterThanOrEqual(19200);
    expect(port).toBeLessThan(29200);
    // Should be deterministic
    expect(repo.channelPort("s-abc123")).toBe(port);
  });

  // ── mergeConfig ─────────────────────────────────────────────────────────

  it("mergeConfig merges without replacing existing keys", () => {
    const s = repo.create({ config: { turns: 5, model_override: "opus" } });
    repo.mergeConfig(s.id, { turns: 10 });
    const updated = repo.get(s.id)!;
    expect(updated.config.turns).toBe(10);
    expect(updated.config.model_override).toBe("opus");
  });

  it("mergeConfig is no-op for nonexistent session", () => {
    // Should not throw
    repo.mergeConfig("s-nope00", { turns: 1 });
  });

  // ── search ──────────────────────────────────────────────────────────────

  it("search finds sessions by ticket", () => {
    repo.create({ ticket: "PROJ-999" });
    repo.create({ ticket: "OTHER-1" });
    const results = repo.search("PROJ");
    expect(results.length).toBe(1);
    expect(results[0].ticket).toBe("PROJ-999");
  });

  it("search finds sessions by summary", () => {
    repo.create({ summary: "Fix authentication bug" });
    const results = repo.search("authentication");
    expect(results.length).toBe(1);
  });

  it("search excludes deleting sessions", () => {
    const s = repo.create({ summary: "Searchable" });
    repo.softDelete(s.id);
    expect(repo.search("Searchable").length).toBe(0);
  });

  // ── getChildren ─────────────────────────────────────────────────────────

  it("getChildren returns child sessions", () => {
    const parent = repo.create({});
    const child = repo.create({});
    repo.update(child.id, { parent_id: parent.id });
    const children = repo.getChildren(parent.id);
    expect(children.length).toBe(1);
    expect(children[0].id).toBe(child.id);
  });

  // ── groups ──────────────────────────────────────────────────────────────

  it("createGroup and getGroups", () => {
    repo.createGroup("team-alpha");
    repo.createGroup("team-beta");
    const groups = repo.getGroups();
    expect(groups.length).toBe(2);
    expect(groups.map((g) => g.name)).toContain("team-alpha");
    expect(groups.map((g) => g.name)).toContain("team-beta");
  });

  it("createGroup is idempotent (INSERT OR IGNORE)", () => {
    repo.createGroup("dups");
    repo.createGroup("dups");
    expect(repo.getGroups().length).toBe(1);
  });

  it("deleteGroup removes group and unassigns sessions", () => {
    repo.createGroup("grp");
    const s = repo.create({ group_name: "grp" });
    repo.deleteGroup("grp");
    expect(repo.getGroups().length).toBe(0);
    expect(repo.get(s.id)!.group_name).toBeNull();
  });

  // ── getGroupNames ────────────────────────────────────────────────────────

  it("getGroupNames unions groups table and session group_names", () => {
    repo.createGroup("explicit-group");
    repo.create({ group_name: "session-only-group" });
    const names = repo.getGroupNames();
    expect(names).toContain("explicit-group");
    expect(names).toContain("session-only-group");
  });

  it("getGroupNames deduplicates when group exists in both sources", () => {
    repo.createGroup("shared");
    repo.create({ group_name: "shared" });
    const names = repo.getGroupNames();
    expect(names.filter((n) => n === "shared").length).toBe(1);
  });

  it("getGroupNames returns sorted results", () => {
    repo.createGroup("zebra");
    repo.createGroup("alpha");
    repo.create({ group_name: "middle" });
    const names = repo.getGroupNames();
    expect(names).toEqual([...names].sort());
  });

  // ── listDeleted ────────────────────────────────────────────────────────

  it("listDeleted returns only soft-deleted sessions", () => {
    const s1 = repo.create({ summary: "active" });
    const s2 = repo.create({ summary: "deleted" });
    repo.softDelete(s2.id);
    const deleted = repo.listDeleted();
    expect(deleted.length).toBe(1);
    expect(deleted[0].id).toBe(s2.id);
  });

  it("listDeleted returns empty when no deleted sessions", () => {
    repo.create({});
    expect(repo.listDeleted().length).toBe(0);
  });

  // ── isChannelPortAvailable ─────────────────────────────────────────────

  it("isChannelPortAvailable returns true when no running sessions", () => {
    const s = repo.create({});
    const port = repo.channelPort(s.id);
    expect(repo.isChannelPortAvailable(port)).toBe(true);
  });

  it("isChannelPortAvailable returns false when port is in use by running session", () => {
    const s = repo.create({});
    repo.update(s.id, { status: "running" as SessionStatus });
    const port = repo.channelPort(s.id);
    expect(repo.isChannelPortAvailable(port)).toBe(false);
  });

  it("isChannelPortAvailable excludes specified session from conflict check", () => {
    const s = repo.create({});
    repo.update(s.id, { status: "running" as SessionStatus });
    const port = repo.channelPort(s.id);
    expect(repo.isChannelPortAvailable(port, s.id)).toBe(true);
  });

  // ── tenant isolation ───────────────────────────────────────────────────

  it("setTenant/getTenant manages tenant context", () => {
    expect(repo.getTenant()).toBe("default");
    repo.setTenant("tenant-a");
    expect(repo.getTenant()).toBe("tenant-a");
  });

  it("sessions are isolated by tenant", () => {
    repo.setTenant("tenant-a");
    const s1 = repo.create({ summary: "tenant-a session" });
    repo.setTenant("tenant-b");
    const s2 = repo.create({ summary: "tenant-b session" });
    expect(repo.get(s1.id)).toBeNull();
    expect(repo.get(s2.id)!.summary).toBe("tenant-b session");
    repo.setTenant("tenant-a");
    expect(repo.get(s1.id)!.summary).toBe("tenant-a session");
    expect(repo.get(s2.id)).toBeNull();
  });

  // ── list filters (group_name, groupPrefix, parent_id) ──────────────────

  it("list filters by group_name", () => {
    repo.create({ group_name: "alpha" });
    repo.create({ group_name: "beta" });
    const result = repo.list({ group_name: "alpha" });
    expect(result.length).toBe(1);
    expect(result[0].group_name).toBe("alpha");
  });

  it("list filters by groupPrefix", () => {
    repo.create({ group_name: "team-frontend" });
    repo.create({ group_name: "team-backend" });
    repo.create({ group_name: "other" });
    const result = repo.list({ groupPrefix: "team-" });
    expect(result.length).toBe(2);
    expect(result.every((s) => s.group_name!.startsWith("team-"))).toBe(true);
  });

  it("list filters by parent_id", () => {
    const parent = repo.create({});
    const child = repo.create({});
    repo.update(child.id, { parent_id: parent.id });
    repo.create({});
    const result = repo.list({ parent_id: parent.id });
    expect(result.length).toBe(1);
    expect(result[0].id).toBe(child.id);
  });

  // ── generateId ─────────────────────────────────────────────────────────

  it("generateId returns properly formatted IDs", () => {
    const id = repo.generateId();
    expect(id).toMatch(/^s-[0-9a-z]{10}$/);
  });

  // ── channelPort with setChannelBounds ──────────────────────────────────

  it("channelPort respects setChannelBounds", () => {
    repo.setChannelBounds(30000, 100);
    const port = repo.channelPort("s-abc123");
    expect(port).toBeGreaterThanOrEqual(30000);
    expect(port).toBeLessThan(30100);
  });

  // ── search ─────────────────────────────────────────────────────────────

  it("search finds sessions by id", () => {
    const s = repo.create({});
    const results = repo.search(s.id);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe(s.id);
  });

  it("search finds sessions by repo", () => {
    repo.create({ repo: "/tmp/my-project" });
    const results = repo.search("my-project");
    expect(results.length).toBe(1);
  });

  it("search respects limit option", () => {
    for (let i = 0; i < 5; i++) repo.create({ summary: `searchable-${i}` });
    const results = repo.search("searchable", { limit: 3 });
    expect(results.length).toBe(3);
  });

  // ── create edge cases ──────────────────────────────────────────────────

  it("create stores workdir and compute_name", () => {
    const s = repo.create({ workdir: "/tmp/work", compute_name: "docker-1" });
    expect(s.workdir).toBe("/tmp/work");
    expect(s.compute_name).toBe("docker-1");
  });

  it("create stores user_id", () => {
    const s = repo.create({ user_id: "user-123" });
    expect(s.user_id).toBe("user-123");
  });
});
