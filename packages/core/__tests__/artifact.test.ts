/**
 * Tests for artifact tracking in the session store.
 *
 * Validates:
 * 1. ArtifactRepository CRUD (add, addMany, list, summary, deleteForSession)
 * 2. Artifact extraction from applyReport() completion reports
 * 3. Artifact extraction from applyReport() progress reports
 * 4. Artifact cleanup on session deletion
 * 5. Tenant scoping
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";
import { applyReport } from "../services/session-orchestration.js";
import type { OutboundMessage } from "../conductor/channel-types.js";
import type { ArtifactType } from "../../types/index.js";

let app: AppContext;

beforeAll(async () => {
  app = AppContext.forTest();
  await app.boot();
  setApp(app);
});

afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

// ── ArtifactRepository CRUD ──────────────────────────────────────────────────

describe("ArtifactRepository", () => {
  it("add() creates and returns an artifact", () => {
    const session = app.sessions.create({ summary: "artifact test" });
    const artifact = app.artifacts.add(session.id, "commit", "abc123", {
      stage: "implement",
      metadata: { message: "fix bug" },
    });
    expect(artifact.id).toBeGreaterThan(0);
    expect(artifact.session_id).toBe(session.id);
    expect(artifact.type).toBe("commit");
    expect(artifact.value).toBe("abc123");
    expect(artifact.stage).toBe("implement");
    expect(artifact.metadata).toEqual({ message: "fix bug" });
    expect(artifact.created_at).toBeTruthy();
  });

  it("add() works without optional fields", () => {
    const session = app.sessions.create({ summary: "artifact test minimal" });
    const artifact = app.artifacts.add(session.id, "file", "src/main.ts");
    expect(artifact.type).toBe("file");
    expect(artifact.value).toBe("src/main.ts");
    expect(artifact.stage).toBeNull();
    expect(artifact.metadata).toEqual({});
  });

  it("addMany() inserts multiple artifacts", () => {
    const session = app.sessions.create({ summary: "batch test" });
    app.artifacts.addMany(session.id, [
      { type: "file", value: "src/a.ts" },
      { type: "file", value: "src/b.ts" },
      { type: "commit", value: "def456", metadata: { author: "test" } },
    ], { stage: "implement" });

    const artifacts = app.artifacts.list(session.id);
    expect(artifacts.length).toBe(3);
    expect(artifacts[0].value).toBe("src/a.ts");
    expect(artifacts[1].value).toBe("src/b.ts");
    expect(artifacts[2].value).toBe("def456");
    expect(artifacts[2].metadata).toEqual({ author: "test" });
    expect(artifacts.every(a => a.stage === "implement")).toBe(true);
  });

  it("list() filters by type", () => {
    const session = app.sessions.create({ summary: "filter test" });
    app.artifacts.addMany(session.id, [
      { type: "file", value: "src/a.ts" },
      { type: "commit", value: "abc" },
      { type: "file", value: "src/b.ts" },
      { type: "pr", value: "https://github.com/org/repo/pull/1" },
    ]);

    const files = app.artifacts.list(session.id, { type: "file" });
    expect(files.length).toBe(2);
    expect(files.every(a => a.type === "file")).toBe(true);

    const commits = app.artifacts.list(session.id, { type: "commit" });
    expect(commits.length).toBe(1);

    const prs = app.artifacts.list(session.id, { type: "pr" });
    expect(prs.length).toBe(1);
    expect(prs[0].value).toBe("https://github.com/org/repo/pull/1");
  });

  it("list() respects limit", () => {
    const session = app.sessions.create({ summary: "limit test" });
    app.artifacts.addMany(session.id, [
      { type: "file", value: "a.ts" },
      { type: "file", value: "b.ts" },
      { type: "file", value: "c.ts" },
    ]);
    const limited = app.artifacts.list(session.id, { limit: 2 });
    expect(limited.length).toBe(2);
  });

  it("summary() returns counts by type", () => {
    const session = app.sessions.create({ summary: "summary test" });
    app.artifacts.addMany(session.id, [
      { type: "file", value: "src/a.ts" },
      { type: "file", value: "src/b.ts" },
      { type: "commit", value: "abc" },
      { type: "commit", value: "def" },
      { type: "commit", value: "ghi" },
      { type: "pr", value: "https://github.com/org/repo/pull/1" },
    ]);

    const summary = app.artifacts.summary(session.id);
    expect(summary.files).toBe(2);
    expect(summary.commits).toBe(3);
    expect(summary.prs).toBe(1);
    expect(summary.branches).toBe(0);
  });

  it("summary() returns zeros for empty session", () => {
    const session = app.sessions.create({ summary: "empty summary" });
    const summary = app.artifacts.summary(session.id);
    expect(summary).toEqual({ commits: 0, files: 0, prs: 0, branches: 0 });
  });

  it("deleteForSession() removes all artifacts", () => {
    const session = app.sessions.create({ summary: "delete test" });
    app.artifacts.addMany(session.id, [
      { type: "file", value: "a.ts" },
      { type: "commit", value: "abc" },
    ]);
    expect(app.artifacts.list(session.id).length).toBe(2);

    app.artifacts.deleteForSession(session.id);
    expect(app.artifacts.list(session.id).length).toBe(0);
  });

  it("session deletion cascades to artifacts", () => {
    const session = app.sessions.create({ summary: "cascade test" });
    app.artifacts.addMany(session.id, [
      { type: "file", value: "a.ts" },
      { type: "commit", value: "abc" },
    ]);
    expect(app.artifacts.list(session.id).length).toBe(2);

    app.sessions.delete(session.id);
    expect(app.artifacts.list(session.id).length).toBe(0);
  });
});

// ── Tenant scoping ────────────────────────────────────────────────────────────

describe("ArtifactRepository tenant scoping", () => {
  it("artifacts are scoped to tenant", () => {
    const session = app.sessions.create({ summary: "tenant test" });
    app.artifacts.add(session.id, "file", "src/main.ts");

    // Scoped app for different tenant should not see the artifact
    const scopedApp = app.forTenant("other-tenant");
    const artifacts = scopedApp.artifacts.list(session.id);
    expect(artifacts.length).toBe(0);

    // Original tenant should still see it
    expect(app.artifacts.list(session.id).length).toBe(1);
  });
});

// ── applyReport artifact extraction ──────────────────────────────────────────

describe("applyReport: artifact extraction", () => {
  it("extracts artifacts from completion report", () => {
    const session = app.sessions.create({ summary: "report artifact test", flow: "bare" });
    app.sessions.update(session.id, { status: "running", stage: "implement" });

    const report: OutboundMessage = {
      type: "completed",
      sessionId: session.id,
      stage: "implement",
      summary: "Done",
      filesChanged: ["src/main.ts", "src/util.ts"],
      commits: ["abc123", "def456"],
      pr_url: "https://github.com/org/repo/pull/42",
    };

    const result = applyReport(app, session.id, report);
    expect(result.artifacts).toBeDefined();
    expect(result.artifacts!.length).toBe(5); // 2 files + 2 commits + 1 PR

    const files = result.artifacts!.filter(a => a.type === "file");
    expect(files.length).toBe(2);
    expect(files[0].value).toBe("src/main.ts");
    expect(files[1].value).toBe("src/util.ts");

    const commits = result.artifacts!.filter(a => a.type === "commit");
    expect(commits.length).toBe(2);
    expect(commits[0].value).toBe("abc123");

    const prs = result.artifacts!.filter(a => a.type === "pr");
    expect(prs.length).toBe(1);
    expect(prs[0].value).toBe("https://github.com/org/repo/pull/42");
  });

  it("extracts artifacts from progress report with filesChanged", () => {
    const session = app.sessions.create({ summary: "progress artifact test", flow: "bare" });
    app.sessions.update(session.id, { status: "running", stage: "implement" });

    const report: OutboundMessage = {
      type: "progress",
      sessionId: session.id,
      stage: "implement",
      message: "Working...",
      filesChanged: ["src/index.ts"],
      pr_url: "https://github.com/org/repo/pull/99",
    };

    const result = applyReport(app, session.id, report);
    expect(result.artifacts).toBeDefined();
    expect(result.artifacts!.length).toBe(2); // 1 file + 1 PR
    expect(result.artifacts![0]).toEqual({ type: "file", value: "src/index.ts" });
    expect(result.artifacts![1]).toEqual({ type: "pr", value: "https://github.com/org/repo/pull/99" });
  });

  it("does not produce artifacts when report has no files/commits/PR", () => {
    const session = app.sessions.create({ summary: "no artifacts test", flow: "bare" });
    app.sessions.update(session.id, { status: "running", stage: "implement" });

    const report: OutboundMessage = {
      type: "progress",
      sessionId: session.id,
      stage: "implement",
      message: "Just thinking...",
    };

    const result = applyReport(app, session.id, report);
    expect(result.artifacts).toBeUndefined();
  });

  it("does not produce artifacts for question/error reports", () => {
    const session = app.sessions.create({ summary: "question test", flow: "bare" });
    app.sessions.update(session.id, { status: "running", stage: "implement" });

    const questionReport: OutboundMessage = {
      type: "question",
      sessionId: session.id,
      stage: "implement",
      question: "Should I use TypeScript?",
    };
    const qResult = applyReport(app, session.id, questionReport);
    expect(qResult.artifacts).toBeUndefined();

    const errorReport: OutboundMessage = {
      type: "error",
      sessionId: session.id,
      stage: "implement",
      error: "Something failed",
    };
    const eResult = applyReport(app, session.id, errorReport);
    expect(eResult.artifacts).toBeUndefined();
  });
});
