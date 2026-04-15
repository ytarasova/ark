/**
 * Tests for session artifact tracking: ArtifactRepository CRUD, querying,
 * deduplication, and cleanup on session delete.
 */

import { describe, it, expect } from "bun:test";
import { getApp } from "../app.js";
import { withTestContext } from "./test-helpers.js";

withTestContext();

describe("ArtifactRepository", () => {
  // ── Basic CRUD ────────────────────────────────────────────────────────────

  it("adds and lists artifacts for a session", () => {
    const app = getApp();
    const session = app.sessions.create({ summary: "artifact test" });

    const added = app.artifacts.add(session.id, "file", ["src/index.ts", "src/util.ts"]);
    expect(added.length).toBe(2);
    expect(added[0].type).toBe("file");
    expect(added[0].value).toBe("src/index.ts");
    expect(added[0].session_id).toBe(session.id);

    const listed = app.artifacts.list(session.id);
    expect(listed.length).toBe(2);
    expect(listed.map((a) => a.value)).toEqual(["src/index.ts", "src/util.ts"]);
  });

  it("filters list by artifact type", () => {
    const app = getApp();
    const session = app.sessions.create({ summary: "type filter test" });

    app.artifacts.add(session.id, "file", ["src/a.ts"]);
    app.artifacts.add(session.id, "commit", ["abc123"]);
    app.artifacts.add(session.id, "pr", ["https://github.com/org/repo/pull/1"]);

    const files = app.artifacts.list(session.id, "file");
    expect(files.length).toBe(1);
    expect(files[0].value).toBe("src/a.ts");

    const commits = app.artifacts.list(session.id, "commit");
    expect(commits.length).toBe(1);
    expect(commits[0].value).toBe("abc123");

    const prs = app.artifacts.list(session.id, "pr");
    expect(prs.length).toBe(1);
  });

  it("stores metadata as JSON", () => {
    const app = getApp();
    const session = app.sessions.create({ summary: "metadata test" });

    app.artifacts.add(session.id, "commit", ["abc123"], { message: "fix: thing" });

    const listed = app.artifacts.list(session.id);
    expect(listed[0].metadata).toEqual({ message: "fix: thing" });
  });

  // ── Deduplication ─────────────────────────────────────────────────────────

  it("deduplicates artifacts by (session_id, type, value)", () => {
    const app = getApp();
    const session = app.sessions.create({ summary: "dedup test" });

    const first = app.artifacts.add(session.id, "file", ["src/a.ts", "src/b.ts"]);
    expect(first.length).toBe(2);

    // Adding same values again should return empty (all duplicates)
    const second = app.artifacts.add(session.id, "file", ["src/a.ts", "src/b.ts"]);
    expect(second.length).toBe(0);

    // Adding a mix of new and existing
    const third = app.artifacts.add(session.id, "file", ["src/a.ts", "src/c.ts"]);
    expect(third.length).toBe(1);
    expect(third[0].value).toBe("src/c.ts");

    // Total should be 3 unique files
    expect(app.artifacts.list(session.id).length).toBe(3);
  });

  it("allows same value with different type", () => {
    const app = getApp();
    const session = app.sessions.create({ summary: "same value diff type" });

    app.artifacts.add(session.id, "file", ["README.md"]);
    app.artifacts.add(session.id, "branch", ["README.md"]);

    expect(app.artifacts.list(session.id).length).toBe(2);
  });

  // ── Querying ──────────────────────────────────────────────────────────────

  it("queries artifacts across sessions by type and value", () => {
    const app = getApp();
    const s1 = app.sessions.create({ summary: "session 1" });
    const s2 = app.sessions.create({ summary: "session 2" });

    app.artifacts.add(s1.id, "file", ["src/shared.ts", "src/only-s1.ts"]);
    app.artifacts.add(s2.id, "file", ["src/shared.ts", "src/only-s2.ts"]);

    // Query for shared.ts across all sessions
    const results = app.artifacts.query({ type: "file", value: "shared.ts" });
    expect(results.length).toBe(2);
    const sessionIds = results.map((a) => a.session_id);
    expect(sessionIds).toContain(s1.id);
    expect(sessionIds).toContain(s2.id);
  });

  it("queries with value pattern matching (LIKE)", () => {
    const app = getApp();
    const session = app.sessions.create({ summary: "pattern test" });

    app.artifacts.add(session.id, "file", [
      "packages/core/app.ts",
      "packages/core/config.ts",
      "packages/types/session.ts",
    ]);

    const coreFiles = app.artifacts.query({ type: "file", value: "packages/core" });
    expect(coreFiles.length).toBe(2);
  });

  it("queries scoped to a single session", () => {
    const app = getApp();
    const s1 = app.sessions.create({ summary: "s1" });
    const s2 = app.sessions.create({ summary: "s2" });

    app.artifacts.add(s1.id, "file", ["a.ts"]);
    app.artifacts.add(s2.id, "file", ["b.ts"]);

    const results = app.artifacts.query({ session_id: s1.id });
    expect(results.length).toBe(1);
    expect(results[0].value).toBe("a.ts");
  });

  it("respects query limit", () => {
    const app = getApp();
    const session = app.sessions.create({ summary: "limit test" });
    app.artifacts.add(session.id, "file", ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);

    const results = app.artifacts.query({ session_id: session.id, limit: 2 });
    expect(results.length).toBe(2);
  });

  // ── Count ─────────────────────────────────────────────────────────────────

  it("counts artifacts for a session", () => {
    const app = getApp();
    const session = app.sessions.create({ summary: "count test" });

    app.artifacts.add(session.id, "file", ["a.ts", "b.ts"]);
    app.artifacts.add(session.id, "commit", ["abc123"]);

    expect(app.artifacts.count(session.id)).toBe(3);
    expect(app.artifacts.count(session.id, "file")).toBe(2);
    expect(app.artifacts.count(session.id, "commit")).toBe(1);
    expect(app.artifacts.count(session.id, "pr")).toBe(0);
  });

  // ── sessionsForArtifact ───────────────────────────────────────────────────

  it("finds sessions that produced a given artifact", () => {
    const app = getApp();
    const s1 = app.sessions.create({ summary: "s1" });
    const s2 = app.sessions.create({ summary: "s2" });
    const s3 = app.sessions.create({ summary: "s3" });

    app.artifacts.add(s1.id, "file", ["shared.ts"]);
    app.artifacts.add(s2.id, "file", ["shared.ts"]);
    app.artifacts.add(s3.id, "file", ["other.ts"]);

    const sessions = app.artifacts.sessionsForArtifact("file", "shared.ts");
    expect(sessions.length).toBe(2);
    expect(sessions).toContain(s1.id);
    expect(sessions).toContain(s2.id);
    expect(sessions).not.toContain(s3.id);
  });

  // ── Cleanup on session delete ─────────────────────────────────────────────

  it("deletes artifacts when session is hard-deleted", () => {
    const app = getApp();
    const session = app.sessions.create({ summary: "cleanup test" });

    app.artifacts.add(session.id, "file", ["a.ts", "b.ts"]);
    app.artifacts.add(session.id, "commit", ["abc123"]);
    expect(app.artifacts.count(session.id)).toBe(3);

    // Hard delete (the repository delete includes artifact cleanup)
    app.sessions.delete(session.id);

    expect(app.artifacts.count(session.id)).toBe(0);
    expect(app.artifacts.list(session.id).length).toBe(0);
  });

  it("deleteForSession clears all artifacts", () => {
    const app = getApp();
    const session = app.sessions.create({ summary: "manual cleanup" });

    app.artifacts.add(session.id, "file", ["a.ts"]);
    app.artifacts.add(session.id, "pr", ["https://github.com/org/repo/pull/1"]);
    expect(app.artifacts.count(session.id)).toBe(2);

    app.artifacts.deleteForSession(session.id);
    expect(app.artifacts.count(session.id)).toBe(0);
  });

  // ── All artifact types ────────────────────────────────────────────────────

  it("supports all four artifact types", () => {
    const app = getApp();
    const session = app.sessions.create({ summary: "all types" });

    app.artifacts.add(session.id, "file", ["src/index.ts"]);
    app.artifacts.add(session.id, "commit", ["abc123def"]);
    app.artifacts.add(session.id, "pr", ["https://github.com/org/repo/pull/42"]);
    app.artifacts.add(session.id, "branch", ["feat/my-feature"]);

    const all = app.artifacts.list(session.id);
    expect(all.length).toBe(4);

    const types = new Set(all.map((a) => a.type));
    expect(types.has("file")).toBe(true);
    expect(types.has("commit")).toBe(true);
    expect(types.has("pr")).toBe(true);
    expect(types.has("branch")).toBe(true);
  });

  // ── Empty values ──────────────────────────────────────────────────────────

  it("handles empty values array gracefully", () => {
    const app = getApp();
    const session = app.sessions.create({ summary: "empty test" });

    const result = app.artifacts.add(session.id, "file", []);
    expect(result.length).toBe(0);
    expect(app.artifacts.list(session.id).length).toBe(0);
  });
});
