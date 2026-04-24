import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { DatabaseAdapter } from "../../database.js";
import { SessionRepository } from "../session.js";
import { initSchema } from "../schema.js";
import type { SessionStatus, SessionConfig } from "../../../types/index.js";
import { SESSION_STATUSES } from "../../../types/index.js";

let db: DatabaseAdapter;
let repo: SessionRepository;

beforeEach(async () => {
  db = new BunSqliteAdapter(new Database(":memory:"));
  await initSchema(db);
  repo = new SessionRepository(db);
});

describe("SessionRepository", async () => {
  // -- create -----------------------------------------------------------

  it("create returns session with correct defaults", async () => {
    const s = await repo.create({});
    // Session IDs are `s-<10 url-safe lowercase alphanumeric>` via nanoid.
    expect(s.id).toMatch(/^s-[0-9a-z]{10}$/);
    expect(s.status).toBe("pending");
    expect(s.flow).toBe("default");
    expect(s.config).toEqual({});
    expect(s.created_at).toBeTruthy();
    expect(s.updated_at).toBeTruthy();
  });

  it("create generates unique, collision-free IDs across a batch", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const s = await repo.create({});
      expect(s.id).toMatch(/^s-[0-9a-z]{10}$/);
      expect(ids.has(s.id)).toBe(false);
      ids.add(s.id);
    }
    expect(ids.size).toBe(200);
  });

  it("create stores ticket, summary, repo and generates branch", async () => {
    const s = await repo.create({ ticket: "PROJ-123", summary: "Fix the bug", repo: "my/repo" });
    expect(s.ticket).toBe("PROJ-123");
    expect(s.summary).toBe("Fix the bug");
    expect(s.repo).toBe("my/repo");
    expect(s.branch).toBe("feat/proj-123-fix-the-bug");
  });

  it("create sanitizes special characters from branch name", async () => {
    const s = await repo.create({ ticket: "PROJ-456", summary: "Fix login, signup & OAuth" });
    expect(s.branch).toBe("feat/proj-456-fix-login-signup-oauth");
  });

  it("create with no ticket sets branch to null", async () => {
    const s = await repo.create({ summary: "No ticket work" });
    expect(s.branch).toBeNull();
  });

  it("create with custom flow and group_name", async () => {
    const s = await repo.create({ flow: "quick", group_name: "team-alpha" });
    expect(s.flow).toBe("quick");
    expect(s.group_name).toBe("team-alpha");
  });

  it("create stores config as JSON", async () => {
    const s = await repo.create({ config: { turns: 7 } });
    expect(s.config).toEqual({ turns: 7 });
  });

  it("create stores agent field", async () => {
    const s = await repo.create({ agent: "planner" });
    expect(s.agent).toBe("planner");
  });

  // -- get --------------------------------------------------------------

  it("get returns null for nonexistent", async () => {
    expect(await repo.get("s-000000")).toBeNull();
  });

  it("get returns session with parsed config", async () => {
    const created = await repo.create({ config: { turns: 5 } });
    const fetched = await repo.get(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.config.turns).toBe(5);
  });

  // -- list -------------------------------------------------------------

  it("list returns all created sessions", async () => {
    await repo.create({ summary: "first" });
    await repo.create({ summary: "second" });
    const sessions = await repo.list();
    expect(sessions.length).toBe(2);
    const summaries = sessions.map((s) => s.summary).sort();
    expect(summaries).toEqual(["first", "second"]);
  });

  it("list filters by status", async () => {
    const s1 = await repo.create({});
    await repo.create({});
    await repo.update(s1.id, { status: "running" as SessionStatus });
    const running = await repo.list({ status: "running" });
    expect(running.length).toBe(1);
    expect(running[0].id).toBe(s1.id);
  });

  it("list filters by each user-facing status", async () => {
    for (const status of SESSION_STATUSES) {
      const s = await repo.create({});
      await repo.update(s.id, { status: status as SessionStatus });
      const filtered = await repo.list({ status: status as SessionStatus });
      expect(filtered.some((r) => r.id === s.id)).toBe(true);
    }
  });

  it("list filters by repo", async () => {
    await repo.create({ repo: "a/b" });
    await repo.create({ repo: "c/d" });
    const result = await repo.list({ repo: "a/b" });
    expect(result.length).toBe(1);
    expect(result[0].repo).toBe("a/b");
  });

  it("list filters by flow", async () => {
    await repo.create({ flow: "quick" });
    await repo.create({ flow: "default" });
    const result = await repo.list({ flow: "quick" });
    expect(result.length).toBe(1);
    expect(result[0].flow).toBe("quick");
  });

  it("list excludes archived sessions by default", async () => {
    const s1 = await repo.create({ summary: "active" });
    const s2 = await repo.create({ summary: "old" });
    await repo.update(s2.id, { status: "archived" as SessionStatus });
    const all = await repo.list();
    expect(all.some((s) => s.id === s1.id)).toBe(true);
    expect(all.some((s) => s.id === s2.id)).toBe(false);
  });

  it("list returns archived sessions when status filter is archived", async () => {
    const s1 = await repo.create({ summary: "active" });
    const s2 = await repo.create({ summary: "old" });
    await repo.update(s2.id, { status: "archived" as SessionStatus });
    const archived = await repo.list({ status: "archived" });
    expect(archived.some((s) => s.id === s2.id)).toBe(true);
    expect(archived.some((s) => s.id === s1.id)).toBe(false);
  });

  it("list excludes deleting sessions", async () => {
    const s = await repo.create({});
    await repo.softDelete(s.id);
    expect((await repo.list()).length).toBe(0);
  });

  it("list respects limit", async () => {
    await repo.create({});
    await repo.create({});
    await repo.create({});
    const result = await repo.list({ limit: 2 });
    expect(result.length).toBe(2);
  });

  it("list filters by group_name", async () => {
    await repo.create({ group_name: "team-alpha", summary: "alpha-work" });
    await repo.create({ group_name: "team-beta", summary: "beta-work" });
    await repo.create({ summary: "ungrouped" });
    const result = await repo.list({ group_name: "team-alpha" });
    expect(result.length).toBe(1);
    expect(result[0].group_name).toBe("team-alpha");
  });

  it("list filters by groupPrefix", async () => {
    await repo.create({ group_name: "team-alpha-1" });
    await repo.create({ group_name: "team-alpha-2" });
    await repo.create({ group_name: "team-beta" });
    const result = await repo.list({ groupPrefix: "team-alpha" });
    expect(result.length).toBe(2);
    expect(result.every((s) => s.group_name!.startsWith("team-alpha"))).toBe(true);
  });

  it("list filters by parent_id", async () => {
    const parent = await repo.create({ summary: "parent" });
    const child1 = await repo.create({});
    const child2 = await repo.create({});
    await repo.create({});
    await repo.update(child1.id, { parent_id: parent.id });
    await repo.update(child2.id, { parent_id: parent.id });
    const result = await repo.list({ parent_id: parent.id });
    expect(result.length).toBe(2);
    expect(result.every((s) => s.parent_id === parent.id)).toBe(true);
  });

  it("list combines multiple filters", async () => {
    await repo.create({ repo: "my/repo", group_name: "team-a" });
    const match = await repo.create({ repo: "my/repo", group_name: "team-b" });
    await repo.update(match.id, { status: "running" as SessionStatus });
    await repo.create({ repo: "other/repo", group_name: "team-b" });
    const result = await repo.list({ repo: "my/repo", status: "running" as SessionStatus });
    expect(result.length).toBe(1);
    expect(result[0].id).toBe(match.id);
  });

  it("list returns sessions ordered by created_at descending", async () => {
    const s1 = await repo.create({ summary: "first" });
    await repo.update(s1.id, { status: "running" as SessionStatus });
    (await db.prepare("UPDATE sessions SET created_at = '2024-01-01T00:00:00.000Z' WHERE id = ?")).run(s1.id);
    const s2 = await repo.create({ summary: "second" });
    (await db.prepare("UPDATE sessions SET created_at = '2024-01-02T00:00:00.000Z' WHERE id = ?")).run(s2.id);
    const s3 = await repo.create({ summary: "third" });
    (await db.prepare("UPDATE sessions SET created_at = '2024-01-03T00:00:00.000Z' WHERE id = ?")).run(s3.id);
    const result = await repo.list();
    expect(result[0].id).toBe(s3.id);
    expect(result[result.length - 1].id).toBe(s1.id);
  });

  it("list with no filters returns empty array when no sessions exist", async () => {
    const result = await repo.list();
    expect(result).toEqual([]);
  });

  // -- update -----------------------------------------------------------

  it("update changes fields and returns updated session", async () => {
    const s = await repo.create({});
    const updated = await repo.update(s.id, { status: "running" as SessionStatus, stage: "plan" });
    expect(updated!.status).toBe("running");
    expect(updated!.stage).toBe("plan");
    // updated_at is refreshed (may be same ms in fast tests, so just check it exists)
    expect(updated!.updated_at).toBeTruthy();
  });

  it("update skips unknown columns", async () => {
    const s = await repo.create({});
    const updated = await repo.update(s.id, { bogusField: "nope" } as Record<string, unknown>);
    expect(updated).not.toBeNull();
    // Should not throw, just silently ignore
  });

  it("update skips id and created_at", async () => {
    const s = await repo.create({});
    const updated = await repo.update(s.id, { id: "s-hacked", created_at: "1999-01-01" } as Record<string, unknown>);
    expect(updated!.id).toBe(s.id);
    expect(updated!.created_at).toBe(s.created_at);
  });

  it("update handles config as JSON", async () => {
    const s = await repo.create({});
    const updated = await repo.update(s.id, { config: { turns: 10 } as SessionConfig });
    expect(updated!.config).toEqual({ turns: 10 });
  });

  it("update returns null for nonexistent id", async () => {
    // update always tries to return get(id) which will be null
    const result = await repo.update("s-ffffff", { status: "running" as SessionStatus });
    expect(result).toBeNull();
  });

  // -- delete -----------------------------------------------------------

  it("delete removes session and returns true", async () => {
    const s = await repo.create({});
    expect(await repo.delete(s.id)).toBe(true);
    expect(await repo.get(s.id)).toBeNull();
  });

  it("delete returns false for nonexistent", async () => {
    expect(await repo.delete("s-nope00")).toBe(false);
  });

  it("delete also removes associated events", async () => {
    const s = await repo.create({});
    // Insert an event directly
    await db
      .prepare("INSERT INTO events (track_id, type, created_at) VALUES (?, 'test', ?)")
      .run(s.id, new Date().toISOString());
    await repo.delete(s.id);
    const events = await db.prepare("SELECT * FROM events WHERE track_id = ?").all(s.id);
    expect(events.length).toBe(0);
  });

  // -- softDelete / undelete --------------------------------------------

  it("softDelete sets status to deleting and stores previous status", async () => {
    const s = await repo.create({});
    await repo.update(s.id, { status: "running" as SessionStatus });
    expect(await repo.softDelete(s.id)).toBe(true);
    const deleted = await repo.get(s.id);
    expect(deleted!.status).toBe("deleting");
    expect(deleted!.config._pre_delete_status).toBe("running");
    expect(deleted!.config._deleted_at).toBeTruthy();
  });

  it("softDelete returns false for nonexistent", async () => {
    expect(await repo.softDelete("s-nope00")).toBe(false);
  });

  it("undelete restores previous status", async () => {
    const s = await repo.create({});
    await repo.update(s.id, { status: "running" as SessionStatus });
    await repo.softDelete(s.id);
    const restored = await repo.undelete(s.id);
    expect(restored!.status).toBe("running");
    expect(restored!.config._pre_delete_status).toBeUndefined();
    expect(restored!.config._deleted_at).toBeUndefined();
  });

  it("undelete returns null if not deleting", async () => {
    const s = await repo.create({});
    expect(await repo.undelete(s.id)).toBeNull();
  });

  // -- claim ------------------------------------------------------------

  it("claim succeeds when expected status matches", async () => {
    const s = await repo.create({});
    expect(await repo.claim(s.id, "pending", "running")).toBe(true);
    expect((await repo.get(s.id))!.status).toBe("running");
  });

  it("claim fails when expected status does not match", async () => {
    const s = await repo.create({});
    expect(await repo.claim(s.id, "running", "completed")).toBe(false);
    expect((await repo.get(s.id))!.status).toBe("pending");
  });

  it("claim with extra fields", async () => {
    const s = await repo.create({});
    await repo.claim(s.id, "pending", "running", { agent: "implementer", stage: "code" });
    const updated = (await repo.get(s.id))!;
    expect(updated.status).toBe("running");
    expect(updated.agent).toBe("implementer");
    expect(updated.stage).toBe("code");
  });

  it("claim JSON-ifies config like update does", async () => {
    const s = await repo.create({});
    await repo.claim(s.id, "pending", "running", {
      config: { launch_pid: 4242, attachments: [{ name: "x" }] } as SessionConfig,
    });
    const updated = (await repo.get(s.id))!;
    expect(updated.status).toBe("running");
    expect(updated.config.launch_pid).toBe(4242);
    expect((updated.config as any).attachments[0].name).toBe("x");
  });

  it("claim ignores caller-supplied status in extra (fixed by `next`)", async () => {
    const s = await repo.create({});
    // Caller sneaks `status: "completed"` into `extra`; the claim must still
    // land `running` because that's what `next` specifies.
    await repo.claim(s.id, "pending", "running", {
      status: "completed" as SessionStatus,
      agent: "planner",
    });
    const updated = (await repo.get(s.id))!;
    expect(updated.status).toBe("running");
    expect(updated.agent).toBe("planner");
  });

  it("claim drops unknown columns like update does", async () => {
    const s = await repo.create({});
    // `totally_made_up` is not in SESSION_COLUMNS, so the claim should land
    // without error and silently skip it (parity with update()).
    await repo.claim(s.id, "pending", "running", { totally_made_up: "ignore" } as unknown as Partial<
      Awaited<ReturnType<typeof repo.get>>
    >);
    expect((await repo.get(s.id))!.status).toBe("running");
  });

  // -- purgeDeleted -----------------------------------------------------

  it("purgeDeleted removes expired soft-deleted sessions", async () => {
    const s = await repo.create({});
    // Manually set _deleted_at to a very old time
    await repo.update(s.id, {
      status: "deleting" as SessionStatus,
      config: { _pre_delete_status: "pending", _deleted_at: "2000-01-01T00:00:00.000Z" } as SessionConfig,
    });
    const purged = await repo.purgeDeleted(1000); // 1 second TTL
    expect(purged).toBe(1);
    expect(await repo.get(s.id)).toBeNull();
  });

  it("purgeDeleted skips recently deleted sessions", async () => {
    const s = await repo.create({});
    await repo.softDelete(s.id);
    const purged = await repo.purgeDeleted(999_999_999); // huge TTL
    expect(purged).toBe(0);
  });

  // -- channelPort ------------------------------------------------------

  it("channelPort returns deterministic port in range", () => {
    const port = repo.channelPort("s-abc123");
    expect(port).toBeGreaterThanOrEqual(19200);
    expect(port).toBeLessThan(29200);
    // Should be deterministic
    expect(repo.channelPort("s-abc123")).toBe(port);
  });

  // -- mergeConfig ------------------------------------------------------

  it("mergeConfig merges without replacing existing keys", async () => {
    const s = await repo.create({ config: { turns: 5, completion_summary: "orig" } });
    await repo.mergeConfig(s.id, { turns: 10 });
    const updated = (await repo.get(s.id))!;
    expect(updated.config.turns).toBe(10);
    expect(updated.config.completion_summary).toBe("orig");
  });

  it("mergeConfig is no-op for nonexistent session", async () => {
    // Should not throw
    await repo.mergeConfig("s-nope00", { turns: 1 });
  });

  // -- search -----------------------------------------------------------

  it("search finds sessions by ticket", async () => {
    await repo.create({ ticket: "PROJ-999" });
    await repo.create({ ticket: "OTHER-1" });
    const results = await repo.search("PROJ");
    expect(results.length).toBe(1);
    expect(results[0].ticket).toBe("PROJ-999");
  });

  it("search finds sessions by summary", async () => {
    await repo.create({ summary: "Fix authentication bug" });
    const results = await repo.search("authentication");
    expect(results.length).toBe(1);
  });

  it("search excludes deleting sessions", async () => {
    const s = await repo.create({ summary: "Searchable" });
    await repo.softDelete(s.id);
    expect((await repo.search("Searchable")).length).toBe(0);
  });

  // -- getChildren ------------------------------------------------------

  it("getChildren returns child sessions", async () => {
    const parent = await repo.create({});
    const child = await repo.create({});
    await repo.update(child.id, { parent_id: parent.id });
    const children = await repo.getChildren(parent.id);
    expect(children.length).toBe(1);
    expect(children[0].id).toBe(child.id);
  });

  // -- groups -----------------------------------------------------------

  it("createGroup and getGroups", async () => {
    await repo.createGroup("team-alpha");
    await repo.createGroup("team-beta");
    const groups = await repo.getGroups();
    expect(groups.length).toBe(2);
    expect(groups.map((g) => g.name)).toContain("team-alpha");
    expect(groups.map((g) => g.name)).toContain("team-beta");
  });

  it("createGroup is idempotent (INSERT OR IGNORE)", async () => {
    await repo.createGroup("dups");
    await repo.createGroup("dups");
    expect((await repo.getGroups()).length).toBe(1);
  });

  it("deleteGroup removes group and unassigns sessions", async () => {
    await repo.createGroup("grp");
    const s = await repo.create({ group_name: "grp" });
    await repo.deleteGroup("grp");
    expect((await repo.getGroups()).length).toBe(0);
    expect((await repo.get(s.id))!.group_name).toBeNull();
  });

  // -- getGroupNames ----------------------------------------------------

  it("getGroupNames unions groups table and session group_names", async () => {
    await repo.createGroup("explicit-group");
    await repo.create({ group_name: "session-only-group" });
    const names = await repo.getGroupNames();
    expect(names).toContain("explicit-group");
    expect(names).toContain("session-only-group");
  });

  it("getGroupNames deduplicates when group exists in both sources", async () => {
    await repo.createGroup("shared");
    await repo.create({ group_name: "shared" });
    const names = await repo.getGroupNames();
    expect(names.filter((n) => n === "shared").length).toBe(1);
  });

  it("getGroupNames returns sorted results", async () => {
    await repo.createGroup("zebra");
    await repo.createGroup("alpha");
    await repo.create({ group_name: "middle" });
    const names = await repo.getGroupNames();
    expect(names).toEqual([...names].sort());
  });

  // -- listDeleted -----------------------------------------------------

  it("listDeleted returns only soft-deleted sessions", async () => {
    const s1 = await repo.create({ summary: "active" });
    const s2 = await repo.create({ summary: "deleted" });
    await repo.softDelete(s2.id);
    const deleted = await repo.listDeleted();
    expect(deleted.length).toBe(1);
    expect(deleted[0].id).toBe(s2.id);
  });

  it("listDeleted returns empty when no deleted sessions", async () => {
    await repo.create({});
    expect((await repo.listDeleted()).length).toBe(0);
  });

  // -- isChannelPortAvailable ------------------------------------------

  it("isChannelPortAvailable returns true when no running sessions", async () => {
    const s = await repo.create({});
    const port = repo.channelPort(s.id);
    expect(await repo.isChannelPortAvailable(port)).toBe(true);
  });

  it("isChannelPortAvailable returns false when port is in use by running session", async () => {
    const s = await repo.create({});
    await repo.update(s.id, { status: "running" as SessionStatus });
    const port = repo.channelPort(s.id);
    expect(await repo.isChannelPortAvailable(port)).toBe(false);
  });

  it("isChannelPortAvailable excludes specified session from conflict check", async () => {
    const s = await repo.create({});
    await repo.update(s.id, { status: "running" as SessionStatus });
    const port = repo.channelPort(s.id);
    expect(await repo.isChannelPortAvailable(port, s.id)).toBe(true);
  });

  // -- tenant isolation ------------------------------------------------

  it("setTenant/getTenant manages tenant context", () => {
    expect(repo.getTenant()).toBe("default");
    repo.setTenant("tenant-a");
    expect(repo.getTenant()).toBe("tenant-a");
  });

  it("sessions are isolated by tenant", async () => {
    repo.setTenant("tenant-a");
    const s1 = await repo.create({ summary: "tenant-a session" });
    repo.setTenant("tenant-b");
    const s2 = await repo.create({ summary: "tenant-b session" });
    expect(await repo.get(s1.id)).toBeNull();
    expect((await repo.get(s2.id))!.summary).toBe("tenant-b session");
    repo.setTenant("tenant-a");
    expect((await repo.get(s1.id))!.summary).toBe("tenant-a session");
    expect(await repo.get(s2.id)).toBeNull();
  });

  // -- list filters (group_name, groupPrefix, parent_id) ---------------

  it("list filters by group_name", async () => {
    await repo.create({ group_name: "alpha" });
    await repo.create({ group_name: "beta" });
    const result = await repo.list({ group_name: "alpha" });
    expect(result.length).toBe(1);
    expect(result[0].group_name).toBe("alpha");
  });

  it("list filters by groupPrefix", async () => {
    await repo.create({ group_name: "team-frontend" });
    await repo.create({ group_name: "team-backend" });
    await repo.create({ group_name: "other" });
    const result = await repo.list({ groupPrefix: "team-" });
    expect(result.length).toBe(2);
    expect(result.every((s) => s.group_name!.startsWith("team-"))).toBe(true);
  });

  it("list filters by parent_id", async () => {
    const parent = await repo.create({});
    const child = await repo.create({});
    await repo.update(child.id, { parent_id: parent.id });
    await repo.create({});
    const result = await repo.list({ parent_id: parent.id });
    expect(result.length).toBe(1);
    expect(result[0].id).toBe(child.id);
  });

  // -- generateId ------------------------------------------------------

  it("generateId returns properly formatted IDs", async () => {
    const id = await repo.generateId();
    expect(id).toMatch(/^s-[0-9a-z]{10}$/);
  });

  // -- channelPort with setChannelBounds -------------------------------

  it("channelPort respects setChannelBounds", () => {
    repo.setChannelBounds(30000, 100);
    const port = repo.channelPort("s-abc123");
    expect(port).toBeGreaterThanOrEqual(30000);
    expect(port).toBeLessThan(30100);
  });

  // -- search ----------------------------------------------------------

  it("search finds sessions by id", async () => {
    const s = await repo.create({});
    const results = await repo.search(s.id);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe(s.id);
  });

  it("search finds sessions by repo", async () => {
    await repo.create({ repo: "/tmp/my-project" });
    const results = await repo.search("my-project");
    expect(results.length).toBe(1);
  });

  it("search respects limit option", async () => {
    for (let i = 0; i < 5; i++) await repo.create({ summary: `searchable-${i}` });
    const results = await repo.search("searchable", { limit: 3 });
    expect(results.length).toBe(3);
  });

  // -- create edge cases ------------------------------------------------

  it("create stores workdir and compute_name", async () => {
    const s = await repo.create({ workdir: "/tmp/work", compute_name: "docker-1" });
    expect(s.workdir).toBe("/tmp/work");
    expect(s.compute_name).toBe("docker-1");
  });

  it("create stores user_id", async () => {
    const s = await repo.create({ user_id: "user-123" });
    expect(s.user_id).toBe("user-123");
  });
});
