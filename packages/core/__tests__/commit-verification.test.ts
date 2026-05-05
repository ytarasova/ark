/**
 * Tests for commit verification gate in applyReport() and applyHookStatus().
 *
 * Validates that agents must commit all changes before the implement stage
 * (or any agent stage) can advance:
 * 1. Uncommitted tracked changes block completion
 * 2. Untracked files do NOT block completion
 * 3. Clean working tree with commits allows completion
 * 4. Sessions without workdir/branch skip the check
 * 5. Verify scripts on a stage block advancement when they fail
 * 6. Per-stage commit verification uses stage_start_sha
 * 7. stage_start_sha is recorded during dispatch
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AppContext } from "../app.js";
import type { OutboundMessage } from "../conductor/common/channel-types.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

/** Create a temporary git repo with an initial commit. */
function createTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ark-commit-test-"));
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["checkout", "-b", "test-branch"], { cwd: dir });
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "--allow-empty", "-m", "initial"],
    { cwd: dir },
  );
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

describe("Commit verification: uncommitted changes", async () => {
  it("rejects completion when staged but uncommitted changes exist", async () => {
    const gitDir = createTempGitRepo();
    const session = await app.sessions.create({ summary: "staged changes test", flow: "quick" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "implement",
      workdir: gitDir,
      branch: "test-branch",
    });

    // Create a file and stage it without committing
    writeFileSync(join(gitDir, "feature.ts"), "export const x = 1;");
    execFileSync("git", ["add", "feature.ts"], { cwd: gitDir });

    const result = await app.sessionHooks.applyReport(session.id, makeReport(session.id, "implement"));

    // Should reject -- staged but uncommitted changes
    expect(result.shouldAdvance).toBeFalsy();
    expect(result.message?.type).toBe("error");
    expect(result.message?.content).toContain("uncommitted changes");
  });

  it("rejects completion when modified tracked files are not committed", async () => {
    const gitDir = createTempGitRepo();

    // Create and commit a file first
    writeFileSync(join(gitDir, "existing.ts"), "export const v = 1;");
    execFileSync("git", ["add", "existing.ts"], { cwd: gitDir });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "add existing"], {
      cwd: gitDir,
    });

    const session = await app.sessions.create({ summary: "modified tracked test", flow: "quick" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "implement",
      workdir: gitDir,
      branch: "test-branch",
    });

    // Modify the tracked file without committing
    writeFileSync(join(gitDir, "existing.ts"), "export const v = 2; // changed");

    const result = await app.sessionHooks.applyReport(session.id, makeReport(session.id, "implement"));

    // Should reject -- modified tracked file not committed
    expect(result.shouldAdvance).toBeFalsy();
    expect(result.message?.type).toBe("error");
    expect(result.message?.content).toContain("uncommitted changes");
  });

  it("allows completion when only untracked files exist (no tracked changes)", async () => {
    const gitDir = createTempGitRepo();

    // Add and commit a real change so the commit check passes
    writeFileSync(join(gitDir, "feature.ts"), "export const x = 1;");
    execFileSync("git", ["add", "feature.ts"], { cwd: gitDir });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "add feature"], {
      cwd: gitDir,
    });

    const session = await app.sessions.create({ summary: "untracked only test", flow: "quick" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "implement",
      workdir: gitDir,
      branch: "test-branch",
    });

    // Create an untracked file (e.g. build artifact)
    writeFileSync(join(gitDir, "temp.log"), "build output");

    const result = await app.sessionHooks.applyReport(session.id, makeReport(session.id, "implement"));

    // Should allow -- untracked files don't count
    expect(result.shouldAdvance).toBe(true);
    expect(result.shouldAutoDispatch).toBe(true);
    expect(result.updates.status).toBe("ready");
  });

  it("allows completion when working tree is clean with commits", async () => {
    const gitDir = createTempGitRepo();

    // Create and commit a change
    writeFileSync(join(gitDir, "feature.ts"), "export const x = 1;");
    execFileSync("git", ["add", "feature.ts"], { cwd: gitDir });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "add feature"], {
      cwd: gitDir,
    });

    const session = await app.sessions.create({ summary: "clean test", flow: "quick" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "implement",
      workdir: gitDir,
      branch: "test-branch",
    });

    const result = await app.sessionHooks.applyReport(session.id, makeReport(session.id, "implement"));

    // Should allow -- clean working tree, commits exist
    expect(result.shouldAdvance).toBe(true);
    expect(result.shouldAutoDispatch).toBe(true);
    expect(result.updates.status).toBe("ready");
  });
});

// ── No workdir/branch -- check skipped ─────────────────────────────────────────

describe("Commit verification: sessions without workdir", async () => {
  it("skips commit check when no workdir is set", async () => {
    const session = await app.sessions.create({ summary: "no workdir test", flow: "quick" });
    await app.sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running", stage: "implement" });

    const result = await app.sessionHooks.applyReport(session.id, makeReport(session.id, "implement"));

    // Should allow -- no workdir means no git checks
    expect(result.shouldAdvance).toBe(true);
    expect(result.updates.status).toBe("ready");
  });

  it("skips commit check when no branch is set", async () => {
    const session = await app.sessions.create({ summary: "no branch test", flow: "quick" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "implement",
      workdir: "/tmp/some-dir",
    });

    const result = await app.sessionHooks.applyReport(session.id, makeReport(session.id, "implement"));

    // Should allow -- no branch means no git checks
    expect(result.shouldAdvance).toBe(true);
    expect(result.updates.status).toBe("ready");
  });
});

// ── Rejection details ──────────────────────────────────────────────────────────

describe("Commit verification: rejection events", async () => {
  it("logs completion_rejected event with file details on uncommitted changes", async () => {
    const gitDir = createTempGitRepo();
    const session = await app.sessions.create({ summary: "rejection event test", flow: "quick" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "implement",
      workdir: gitDir,
      branch: "test-branch",
    });

    // Create staged but uncommitted changes
    writeFileSync(join(gitDir, "a.ts"), "const a = 1;");
    writeFileSync(join(gitDir, "b.ts"), "const b = 2;");
    execFileSync("git", ["add", "a.ts", "b.ts"], { cwd: gitDir });

    const result = await app.sessionHooks.applyReport(session.id, makeReport(session.id, "implement"));

    // Should have completion_rejected event with file info
    const rejectionEvent = result.logEvents!.find((e) => e.type === "completion_rejected");
    expect(rejectionEvent).toBeTruthy();
    expect(rejectionEvent!.opts.data?.reason).toBe("uncommitted changes in worktree");
    expect(rejectionEvent!.opts.data?.files).toBeTruthy();
  });

  it("does not set session_id to null when rejecting (agent stays alive)", async () => {
    const gitDir = createTempGitRepo();
    const session = await app.sessions.create({ summary: "session alive test", flow: "quick" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "implement",
      workdir: gitDir,
      branch: "test-branch",
    });

    writeFileSync(join(gitDir, "dirty.ts"), "const x = 1;");
    execFileSync("git", ["add", "dirty.ts"], { cwd: gitDir });

    const result = await app.sessionHooks.applyReport(session.id, makeReport(session.id, "implement"));

    // session_id should NOT be set to null -- agent must stay alive to finish
    expect(result.updates.session_id).toBeUndefined();
    // status should NOT be set to "ready"
    expect(result.updates.status).toBeUndefined();
  });

  it("still saves completion config data even when rejecting", async () => {
    const gitDir = createTempGitRepo();
    const session = await app.sessions.create({ summary: "config saved test", flow: "quick" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "implement",
      workdir: gitDir,
      branch: "test-branch",
    });

    writeFileSync(join(gitDir, "dirty.ts"), "const x = 1;");
    execFileSync("git", ["add", "dirty.ts"], { cwd: gitDir });

    const result = await app.sessionHooks.applyReport(
      session.id,
      makeReport(session.id, "implement", {
        summary: "My work summary",
      } as any),
    );

    // Completion data should still be saved to config even though completion is rejected
    expect(result.updates.config).toBeTruthy();
    expect(result.updates.config?.completion_summary).toBe("My work summary");
  });
});

// ── Manual gate interaction ────────────────────────────────────────────────────

describe("Commit verification: manual gate interaction", async () => {
  it("skips commit check for manual gate stages (bare flow)", async () => {
    // Manual gate stages don't advance, so commit verification is deferred to human
    const session = await app.sessions.create({ summary: "manual gate test", flow: "bare" });
    await app.sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running", stage: "work" });

    const result = await app.sessionHooks.applyReport(session.id, makeReport(session.id, "work"));

    // Manual gate: no shouldAdvance, no commit check needed
    expect(result.shouldAdvance).toBeFalsy();
    // Should still have a message (agent completed, waiting for human)
    expect(result.message).toBeTruthy();
  });
});

// ── Per-stage commit verification (stage_start_sha) ──────────────────────────

describe("Per-stage commit verification via stage_start_sha", async () => {
  it("rejects completion when HEAD matches stage_start_sha (no new commits this stage)", async () => {
    const gitDir = createTempGitRepo();

    // Record initial HEAD as stage_start_sha (simulating what dispatch does)
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: gitDir,
      encoding: "utf-8",
    }).trim();

    const session = await app.sessions.create({ summary: "no stage commits", flow: "quick" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "implement",
      workdir: gitDir,
      branch: "test-branch",
    });
    await app.sessions.mergeConfig(session.id, { stage_start_sha: headSha });

    const result = await app.sessionHooks.applyReport(session.id, makeReport(session.id, "implement"));

    // Should reject -- HEAD == stage_start_sha means no commits this stage
    expect(result.shouldAdvance).toBeFalsy();
    expect(result.message?.type).toBe("error");
    expect(result.message?.content).toContain("no new commits found for this stage");
  });

  it("allows completion when HEAD differs from stage_start_sha (commits made this stage)", async () => {
    const gitDir = createTempGitRepo();

    // Record initial HEAD as stage_start_sha
    const startSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: gitDir,
      encoding: "utf-8",
    }).trim();

    // Make a commit (simulating agent work during the stage)
    writeFileSync(join(gitDir, "feature.ts"), "export const x = 1;");
    execFileSync("git", ["add", "feature.ts"], { cwd: gitDir });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "stage work"], {
      cwd: gitDir,
    });

    const session = await app.sessions.create({ summary: "has stage commits", flow: "quick" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "implement",
      workdir: gitDir,
      branch: "test-branch",
    });
    await app.sessions.mergeConfig(session.id, { stage_start_sha: startSha });

    const result = await app.sessionHooks.applyReport(session.id, makeReport(session.id, "implement"));

    // Should allow -- HEAD differs from stage_start_sha
    expect(result.shouldAdvance).toBe(true);
    expect(result.shouldAutoDispatch).toBe(true);
    expect(result.updates.status).toBe("ready");
  });

  it("rejects even when branch has prior-stage commits but none for current stage", async () => {
    const gitDir = createTempGitRepo();

    // Simulate a prior stage making commits
    writeFileSync(join(gitDir, "prior-stage.ts"), "export const prior = true;");
    execFileSync("git", ["add", "prior-stage.ts"], { cwd: gitDir });
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "prior stage commit"],
      { cwd: gitDir },
    );

    // Record HEAD now as stage_start_sha (this stage starts here)
    const startSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: gitDir,
      encoding: "utf-8",
    }).trim();

    // No new commits after stage started

    const session = await app.sessions.create({ summary: "prior commits only", flow: "quick" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "implement",
      workdir: gitDir,
      branch: "test-branch",
    });
    await app.sessions.mergeConfig(session.id, { stage_start_sha: startSha });

    const result = await app.sessionHooks.applyReport(session.id, makeReport(session.id, "implement"));

    // Should reject -- no commits since stage_start_sha despite prior-stage commits existing
    expect(result.shouldAdvance).toBeFalsy();
    expect(result.message?.type).toBe("error");
    expect(result.message?.content).toContain("no new commits found for this stage");
  });

  it("includes stage_start_sha in completion_rejected event data", async () => {
    const gitDir = createTempGitRepo();
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: gitDir,
      encoding: "utf-8",
    }).trim();

    const session = await app.sessions.create({ summary: "rejection sha test", flow: "quick" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "implement",
      workdir: gitDir,
      branch: "test-branch",
    });
    await app.sessions.mergeConfig(session.id, { stage_start_sha: headSha });

    const result = await app.sessionHooks.applyReport(session.id, makeReport(session.id, "implement"));

    const rejectionEvent = result.logEvents!.find((e) => e.type === "completion_rejected");
    expect(rejectionEvent).toBeTruthy();
    expect(rejectionEvent!.opts.data?.stage_start_sha).toBe(headSha);
  });

  it("falls back to origin/main..HEAD when stage_start_sha is not set", async () => {
    const gitDir = createTempGitRepo();

    // Make a commit so origin/main..HEAD fallback finds something
    writeFileSync(join(gitDir, "feature.ts"), "export const x = 1;");
    execFileSync("git", ["add", "feature.ts"], { cwd: gitDir });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "work"], {
      cwd: gitDir,
    });

    const session = await app.sessions.create({ summary: "no sha fallback", flow: "quick" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "implement",
      workdir: gitDir,
      branch: "test-branch",
    });
    // Deliberately NOT setting stage_start_sha

    const result = await app.sessionHooks.applyReport(session.id, makeReport(session.id, "implement"));

    // Fallback to origin/main..HEAD will fail (no remote) but catch allows continuation
    // So this should pass through to uncommitted check (which passes since tree is clean)
    expect(result.shouldAdvance).toBe(true);
  });
});

// ── Per-stage commit verification in applyHookStatus ─────────────────────────

describe("Per-stage commit verification in applyHookStatus (SessionEnd)", async () => {
  it("rejects auto-advance when HEAD matches stage_start_sha on SessionEnd", async () => {
    const gitDir = createTempGitRepo();
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: gitDir,
      encoding: "utf-8",
    }).trim();

    const session = await app.sessions.create({ summary: "hook no commits", flow: "quick" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "implement",
      workdir: gitDir,
      branch: "test-branch",
    });
    await app.sessions.mergeConfig(session.id, { stage_start_sha: headSha });

    // Re-fetch session to include merged config
    const freshSession = await app.sessions.get(session.id)!;

    const result = await app.sessionHooks.applyHookStatus(freshSession, "SessionEnd", {});

    // Should NOT advance -- no commits since stage_start_sha
    expect(result.shouldAdvance).toBeFalsy();
    expect(result.updates?.error).toContain("without committing");
  });

  it("allows auto-advance when HEAD differs from stage_start_sha on SessionEnd", async () => {
    const gitDir = createTempGitRepo();
    const startSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: gitDir,
      encoding: "utf-8",
    }).trim();

    // Make a commit during the stage
    writeFileSync(join(gitDir, "feature.ts"), "export const x = 1;");
    execFileSync("git", ["add", "feature.ts"], { cwd: gitDir });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "stage work"], {
      cwd: gitDir,
    });

    const session = await app.sessions.create({ summary: "hook has commits", flow: "quick" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "implement",
      workdir: gitDir,
      branch: "test-branch",
    });
    await app.sessions.mergeConfig(session.id, { stage_start_sha: startSha });

    const freshSession = await app.sessions.get(session.id)!;

    const result = await app.sessionHooks.applyHookStatus(freshSession, "SessionEnd", {});

    // Should advance -- commits exist since stage_start_sha
    expect(result.shouldAdvance).toBe(true);
    expect(result.shouldAutoDispatch).toBe(true);
  });

  it("falls back to origin/main..HEAD when stage_start_sha is not set in hook path", async () => {
    const gitDir = createTempGitRepo();

    // Make a commit so there's content on branch
    writeFileSync(join(gitDir, "feature.ts"), "export const x = 1;");
    execFileSync("git", ["add", "feature.ts"], { cwd: gitDir });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "work"], {
      cwd: gitDir,
    });

    const session = await app.sessions.create({ summary: "hook no sha", flow: "quick" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "implement",
      workdir: gitDir,
      branch: "test-branch",
    });
    // No stage_start_sha set

    const freshSession = await app.sessions.get(session.id)!;

    const result = await app.sessionHooks.applyHookStatus(freshSession, "SessionEnd", {});

    // Fallback to origin/main..HEAD will fail (no remote), catch allows (hasNewCommits = true)
    expect(result.shouldAdvance).toBe(true);
  });
});
