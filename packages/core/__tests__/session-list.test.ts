import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";
import type { Session } from "../../types/index.js";

let app: AppContext;

beforeEach(async () => {
  app = AppContext.forTest();
  setApp(app);
  await app.boot();
});

afterEach(async () => {
  await app?.shutdown();
  clearApp();
});

function create(overrides: Record<string, unknown> = {}): Session {
  return app.sessions.create({ repo: "/tmp/test", flow: "bare", summary: "test", ...overrides });
}

describe("SessionRepository.list", () => {
  it("returns all non-archived sessions with no filters", () => {
    create({ summary: "a" });
    create({ summary: "b" });
    const results = app.sessions.list();
    expect(results.length).toBe(2);
  });

  it("returns empty array when no sessions exist", () => {
    expect(app.sessions.list()).toEqual([]);
  });

  it("filters by status", () => {
    const s = create({ summary: "completed-one" });
    app.sessions.update(s.id, { status: "completed" });
    create({ summary: "still-pending" });

    const completed = app.sessions.list({ status: "completed" });
    expect(completed.length).toBe(1);
    expect(completed[0].summary).toBe("completed-one");
  });

  it("excludes archived sessions by default", () => {
    const s = create({ summary: "archived-one" });
    app.sessions.update(s.id, { status: "archived" });
    create({ summary: "active-one" });

    const results = app.sessions.list();
    expect(results.length).toBe(1);
    expect(results[0].summary).toBe("active-one");
  });

  it("includes archived sessions when status=archived", () => {
    const s = create({ summary: "archived-one" });
    app.sessions.update(s.id, { status: "archived" });
    create({ summary: "active-one" });

    const archived = app.sessions.list({ status: "archived" });
    expect(archived.length).toBe(1);
    expect(archived[0].summary).toBe("archived-one");
  });

  it("excludes deleting sessions always", () => {
    const s = create({ summary: "deleting-one" });
    app.sessions.update(s.id, { status: "deleting" as any });
    create({ summary: "active-one" });

    const results = app.sessions.list();
    expect(results.length).toBe(1);
    expect(results[0].summary).toBe("active-one");
  });

  it("filters by repo", () => {
    create({ summary: "repo-a", repo: "/tmp/repo-a" });
    create({ summary: "repo-b", repo: "/tmp/repo-b" });

    const results = app.sessions.list({ repo: "/tmp/repo-a" });
    expect(results.length).toBe(1);
    expect(results[0].summary).toBe("repo-a");
  });

  it("filters by group_name", () => {
    create({ summary: "g1", group_name: "group-alpha" });
    create({ summary: "g2", group_name: "group-beta" });

    const results = app.sessions.list({ group_name: "group-alpha" });
    expect(results.length).toBe(1);
    expect(results[0].summary).toBe("g1");
  });

  it("filters by groupPrefix", () => {
    create({ summary: "gp1", group_name: "prefix-aaa" });
    create({ summary: "gp2", group_name: "prefix-bbb" });
    create({ summary: "gp3", group_name: "other-ccc" });

    const results = app.sessions.list({ groupPrefix: "prefix-" });
    expect(results.length).toBe(2);
    const summaries = results.map((s) => s.summary);
    expect(summaries).toContain("gp1");
    expect(summaries).toContain("gp2");
  });

  it("filters by parent_id", () => {
    const parent = create({ summary: "parent" });
    const child = create({ summary: "child" });
    app.sessions.update(child.id, { parent_id: parent.id });
    create({ summary: "orphan" });

    const results = app.sessions.list({ parent_id: parent.id });
    expect(results.length).toBe(1);
    expect(results[0].summary).toBe("child");
  });

  it("filters by flow", () => {
    create({ summary: "bare-flow", flow: "bare" });
    create({ summary: "quick-flow", flow: "quick" });

    const results = app.sessions.list({ flow: "bare" });
    expect(results.length).toBe(1);
    expect(results[0].summary).toBe("bare-flow");
  });

  it("respects limit", () => {
    for (let i = 0; i < 5; i++) {
      create({ summary: `s${i}` });
    }

    const results = app.sessions.list({ limit: 3 });
    expect(results.length).toBe(3);
  });

  it("orders by created_at DESC", () => {
    create({ summary: "first" });
    create({ summary: "second" });
    create({ summary: "third" });

    const results = app.sessions.list();
    expect(results[0].summary).toBe("third");
    expect(results[2].summary).toBe("first");
  });

  it("combines multiple filters", () => {
    create({ summary: "match", repo: "/tmp/combo", flow: "bare" });
    create({ summary: "wrong-repo", repo: "/tmp/other", flow: "bare" });
    create({ summary: "wrong-flow", repo: "/tmp/combo", flow: "quick" });

    const results = app.sessions.list({ repo: "/tmp/combo", flow: "bare" });
    expect(results.length).toBe(1);
    expect(results[0].summary).toBe("match");
  });

  it("defaults limit to 100", () => {
    for (let i = 0; i < 5; i++) {
      create({ summary: `s${i}` });
    }
    const results = app.sessions.list();
    expect(results.length).toBe(5);
  });
});
