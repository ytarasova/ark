/**
 * Tests for commit verification gate in applyReport().
 *
 * Validates that agents must commit all changes before the implement stage
 * (or any agent stage) can advance:
 * 1. Uncommitted tracked changes block completion
 * 2. Untracked files do NOT block completion
 * 3. Clean working tree with commits allows completion
 * 4. Sessions without workdir/branch skip the check
 * 5. Verify scripts on a stage block advancement when they fail
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AppContext, setApp, clearApp } from "../app.js";
import { applyReport } from "../services/session-orchestration.js";
import type { OutboundMessage } from "../conductor/channel-types.js";

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

/** Create a temporary git repo with an initial commit. */
function createTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ark-commit-test-"));
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["checkout", "-b", "test-branch"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "--allow-empty", "-m", "initial"], { cwd: dir });
  return dir;
}

function makeReport(sessionId: string, stage: string, overrides?: Partial<OutboundMessage>): OutboundMessage {
  return {
    type: "completed",
    sessionId,
    stage,
    summary: "Done",
    filesChanged: ["src/main.ts"],
    commits: ["abc123"],
    ...overrides,
  } as OutboundMessage;
}

// ── Uncommitted changes gate ──────────────────────────────────────────────────

describe("Commit verification: uncommitted changes", () => {
  it("rejects completion when staged but uncommitted changes exist", () => {
    const gitDir = createTempGitRepo();
    const session = app.sessions.create({ summary: "staged changes test", flow: "quick" });
    app.sessions.update(session.id, {
      status: "running",
      stage: "implement",
      workdir: gitDir,
      branch: "test-branch",
    });

    // Create a file and stage it without committing
    writeFileSync(join(gitDir, "feature.ts"), "export const x = 1;");
    execFileSync("git", ["add", "feature.ts"], { cwd: gitDir });

    const result = applyReport(app, session.id, makeReport(session.id, "implement"));

    // Should reject -- staged but uncommitted changes
    expect(result.shouldAdvance).toBeFalsy();
    expect(result.message?.type).toBe("error");
    expect(result.message?.content).toContain("uncommitted changes");
  });

  it("rejects completion when modified tracked files are not committed", () => {
    const gitDir = createTempGitRepo();

    // Create and commit a file first
    writeFileSync(join(gitDir, "existing.ts"), "export const v = 1;");
    execFileSync("git", ["add", "existing.ts"], { cwd: gitDir });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "add existing"], { cwd: gitDir });

    const session = app.sessions.create({ summary: "modified tracked test", flow: "quick" });
    app.sessions.update(session.id, {
      status: "running",
      stage: "implement",
      workdir: gitDir,
      branch: "test-branch",
    });

    // Modify the tracked file without committing
    writeFileSync(join(gitDir, "existing.ts"), "export const v = 2; // changed");

    const result = applyReport(app, session.id, makeReport(session.id, "implement"));

    // Should reject -- modified tracked file not committed
    expect(result.shouldAdvance).toBeFalsy();
    expect(result.message?.type).toBe("error");
    expect(result.message?.content).toContain("uncommitted changes");
  });

  it("allows completion when only untracked files exist (no tracked changes)", () => {
    const gitDir = createTempGitRepo();

    // Add and commit a real change so the commit check passes
    writeFileSync(join(gitDir, "feature.ts"), "export const x = 1;");
    execFileSync("git", ["add", "feature.ts"], { cwd: gitDir });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "add feature"], { cwd: gitDir });

    const session = app.sessions.create({ summary: "untracked only test", flow: "quick" });
    app.sessions.update(session.id, {
      status: "running",
      stage: "implement",
      workdir: gitDir,
      branch: "test-branch",
    });

    // Create an untracked file (e.g. build artifact)
    writeFileSync(join(gitDir, "temp.log"), "build output");

    const result = applyReport(app, session.id, makeReport(session.id, "implement"));

    // Should allow -- untracked files don't count
    expect(result.shouldAdvance).toBe(true);
    expect(result.shouldAutoDispatch).toBe(true);
    expect(result.updates.status).toBe("ready");
  });

  it("allows completion when working tree is clean with commits", () => {
    const gitDir = createTempGitRepo();

    // Create and commit a change
    writeFileSync(join(gitDir, "feature.ts"), "export const x = 1;");
    execFileSync("git", ["add", "feature.ts"], { cwd: gitDir });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "add feature"], { cwd: gitDir });

    const session = app.sessions.create({ summary: "clean test", flow: "quick" });
    app.sessions.update(session.id, {
      status: "running",
      stage: "implement",
      workdir: gitDir,
      branch: "test-branch",
    });

    const result = applyReport(app, session.id, makeReport(session.id, "implement"));

    // Should allow -- clean working tree, commits exist
    expect(result.shouldAdvance).toBe(true);
    expect(result.shouldAutoDispatch).toBe(true);
    expect(result.updates.status).toBe("ready");
  });
});

// ── No workdir/branch -- check skipped ─────────────────────────────────────────

describe("Commit verification: sessions without workdir", () => {
  it("skips commit check when no workdir is set", () => {
    const session = app.sessions.create({ summary: "no workdir test", flow: "quick" });
    app.sessions.update(session.id, { status: "running", stage: "implement" });

    const result = applyReport(app, session.id, makeReport(session.id, "implement"));

    // Should allow -- no workdir means no git checks
    expect(result.shouldAdvance).toBe(true);
    expect(result.updates.status).toBe("ready");
  });

  it("skips commit check when no branch is set", () => {
    const session = app.sessions.create({ summary: "no branch test", flow: "quick" });
    app.sessions.update(session.id, {
      status: "running",
      stage: "implement",
      workdir: "/tmp/some-dir",
    });

    const result = applyReport(app, session.id, makeReport(session.id, "implement"));

    // Should allow -- no branch means no git checks
    expect(result.shouldAdvance).toBe(true);
    expect(result.updates.status).toBe("ready");
  });
});

// ── Rejection details ──────────────────────────────────────────────────────────

describe("Commit verification: rejection events", () => {
  it("logs completion_rejected event with file details on uncommitted changes", () => {
    const gitDir = createTempGitRepo();
    const session = app.sessions.create({ summary: "rejection event test", flow: "quick" });
    app.sessions.update(session.id, {
      status: "running",
      stage: "implement",
      workdir: gitDir,
      branch: "test-branch",
    });

    // Create staged but uncommitted changes
    writeFileSync(join(gitDir, "a.ts"), "const a = 1;");
    writeFileSync(join(gitDir, "b.ts"), "const b = 2;");
    execFileSync("git", ["add", "a.ts", "b.ts"], { cwd: gitDir });

    const result = applyReport(app, session.id, makeReport(session.id, "implement"));

    // Should have completion_rejected event with file info
    const rejectionEvent = result.logEvents!.find(e => e.type === "completion_rejected");
    expect(rejectionEvent).toBeTruthy();
    expect(rejectionEvent!.opts.data?.reason).toBe("uncommitted changes in worktree");
    expect(rejectionEvent!.opts.data?.files).toBeTruthy();
  });

  it("does not set session_id to null when rejecting (agent stays alive)", () => {
    const gitDir = createTempGitRepo();
    const session = app.sessions.create({ summary: "session alive test", flow: "quick" });
    app.sessions.update(session.id, {
      status: "running",
      stage: "implement",
      workdir: gitDir,
      branch: "test-branch",
    });

    writeFileSync(join(gitDir, "dirty.ts"), "const x = 1;");
    execFileSync("git", ["add", "dirty.ts"], { cwd: gitDir });

    const result = applyReport(app, session.id, makeReport(session.id, "implement"));

    // session_id should NOT be set to null -- agent must stay alive to finish
    expect(result.updates.session_id).toBeUndefined();
    // status should NOT be set to "ready"
    expect(result.updates.status).toBeUndefined();
  });

  it("still saves completion config data even when rejecting", () => {
    const gitDir = createTempGitRepo();
    const session = app.sessions.create({ summary: "config saved test", flow: "quick" });
    app.sessions.update(session.id, {
      status: "running",
      stage: "implement",
      workdir: gitDir,
      branch: "test-branch",
    });

    writeFileSync(join(gitDir, "dirty.ts"), "const x = 1;");
    execFileSync("git", ["add", "dirty.ts"], { cwd: gitDir });

    const result = applyReport(app, session.id, makeReport(session.id, "implement", {
      summary: "My work summary",
    } as any));

    // Completion data should still be saved to config even though completion is rejected
    expect(result.updates.config).toBeTruthy();
    expect(result.updates.config?.completion_summary).toBe("My work summary");
  });
});

// ── Manual gate interaction ────────────────────────────────────────────────────

describe("Commit verification: manual gate interaction", () => {
  it("skips commit check for manual gate stages (bare flow)", () => {
    // Manual gate stages don't advance, so commit verification is deferred to human
    const session = app.sessions.create({ summary: "manual gate test", flow: "bare" });
    app.sessions.update(session.id, { status: "running", stage: "work" });

    const result = applyReport(app, session.id, makeReport(session.id, "work"));

    // Manual gate: no shouldAdvance, no commit check needed
    expect(result.shouldAdvance).toBeFalsy();
    // Should still have a message (agent completed, waiting for human)
    expect(result.message).toBeTruthy();
  });
});
