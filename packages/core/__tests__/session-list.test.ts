import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";
import type { Session } from "../../types/index.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});

afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

function createSession(overrides: Record<string, unknown> = {}): Session {
  const session = app.sessions.create({
    summary: "list-test",
    repo: ".",
    flow: "bare",
    ...overrides,
  });
  return session;
}

describe("SessionRepository.list", () => {
  it("returns sessions without filters", () => {
    createSession({ summary: "no-filter-test" });
    const sessions = app.sessions.list();
    expect(sessions.length).toBeGreaterThan(0);
  });

  it("filters by status", () => {
    const session = createSession({ summary: "status-filter" });
    app.sessions.update(session.id, { status: "running" });
    const running = app.sessions.list({ status: "running" });
    expect(running.some((s) => s.id === session.id)).toBe(true);
    const completed = app.sessions.list({ status: "completed" });
    expect(completed.some((s) => s.id === session.id)).toBe(false);
  });

  it("filters by repo", () => {
    const session = createSession({ summary: "repo-filter", repo: "/tmp/unique-repo-xyz" });
    const filtered = app.sessions.list({ repo: "/tmp/unique-repo-xyz" });
    expect(filtered.some((s) => s.id === session.id)).toBe(true);
    const other = app.sessions.list({ repo: "/tmp/nonexistent-repo" });
    expect(other.some((s) => s.id === session.id)).toBe(false);
  });

  it("filters by group_name", () => {
    const session = createSession({ summary: "group-filter", group_name: "test-group-abc" });
    const filtered = app.sessions.list({ group_name: "test-group-abc" });
    expect(filtered.some((s) => s.id === session.id)).toBe(true);
    const other = app.sessions.list({ group_name: "other-group" });
    expect(other.some((s) => s.id === session.id)).toBe(false);
  });

  it("filters by groupPrefix", () => {
    const session = createSession({ summary: "prefix-filter", group_name: "prefix-match-123" });
    const filtered = app.sessions.list({ groupPrefix: "prefix-match" });
    expect(filtered.some((s) => s.id === session.id)).toBe(true);
    const other = app.sessions.list({ groupPrefix: "no-match" });
    expect(other.some((s) => s.id === session.id)).toBe(false);
  });

  it("filters by parent_id", () => {
    const parent = createSession({ summary: "parent-session" });
    const child = createSession({ summary: "child-session" });
    app.sessions.update(child.id, { parent_id: parent.id });
    const filtered = app.sessions.list({ parent_id: parent.id });
    expect(filtered.some((s) => s.id === child.id)).toBe(true);
    expect(filtered.some((s) => s.id === parent.id)).toBe(false);
  });

  it("filters by flow", () => {
    const session = createSession({ summary: "flow-filter", flow: "bare" });
    const filtered = app.sessions.list({ flow: "bare" });
    expect(filtered.some((s) => s.id === session.id)).toBe(true);
  });

  it("respects limit", () => {
    for (let i = 0; i < 5; i++) {
      createSession({ summary: `limit-test-${i}` });
    }
    const limited = app.sessions.list({ limit: 2 });
    expect(limited.length).toBeLessThanOrEqual(2);
  });

  it("excludes archived sessions by default", () => {
    const session = createSession({ summary: "archive-exclude-test" });
    app.sessions.update(session.id, { status: "archived" });
    const defaultList = app.sessions.list();
    expect(defaultList.some((s) => s.id === session.id)).toBe(false);
  });

  it("includes archived sessions when filtering by archived status", () => {
    const session = createSession({ summary: "archive-include-test" });
    app.sessions.update(session.id, { status: "archived" });
    const archived = app.sessions.list({ status: "archived" });
    expect(archived.some((s) => s.id === session.id)).toBe(true);
  });

  it("excludes deleting sessions", () => {
    const session = createSession({ summary: "deleting-exclude-test" });
    app.sessions.update(session.id, { status: "deleting" });
    const all = app.sessions.list();
    expect(all.some((s) => s.id === session.id)).toBe(false);
  });

  it("combines multiple filters", () => {
    const session = createSession({
      summary: "multi-filter",
      repo: "/tmp/multi-filter-repo",
      flow: "bare",
      group_name: "multi-group",
    });
    app.sessions.update(session.id, { status: "running" });

    const filtered = app.sessions.list({
      status: "running",
      repo: "/tmp/multi-filter-repo",
      group_name: "multi-group",
      flow: "bare",
    });
    expect(filtered.some((s) => s.id === session.id)).toBe(true);

    const mismatch = app.sessions.list({
      status: "running",
      repo: "/tmp/multi-filter-repo",
      group_name: "wrong-group",
    });
    expect(mismatch.some((s) => s.id === session.id)).toBe(false);
  });

  it("orders by created_at descending", () => {
    const first = createSession({ summary: "order-first" });
    const second = createSession({ summary: "order-second" });
    const sessions = app.sessions.list();
    const firstIdx = sessions.findIndex((s) => s.id === first.id);
    const secondIdx = sessions.findIndex((s) => s.id === second.id);
    expect(secondIdx).toBeLessThan(firstIdx);
  });
});
