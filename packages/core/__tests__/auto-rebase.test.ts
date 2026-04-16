/**
 * Tests for auto-rebase before PR creation.
 *
 * Uses real git repos (no mocks) to verify:
 *   - rebaseOntoBase fetches + rebases onto origin/<base>
 *   - rebaseOntoBase aborts cleanly on conflict
 *   - createWorktreePR calls rebase before push (when enabled)
 *   - auto_rebase: false in repo config skips rebase
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AppContext, setApp, clearApp } from "../app.js";
import { rebaseOntoBase } from "../services/session-orchestration.js";

// ── Helpers ─────────────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Create a bare origin with initial-branch=main and a seeded first commit.
 * Returns { origin, work } where work is a clone ready for feature branches.
 */
function setupRepo(testDir: string, name: string): { origin: string; work: string } {
  // Create a temp staging repo to make the first commit
  const staging = join(testDir, `${name}-staging`);
  mkdirSync(staging, { recursive: true });
  git(staging, "init", "--initial-branch=main");
  git(staging, "config", "user.email", "test@test.com");
  git(staging, "config", "user.name", "Test");
  writeFileSync(join(staging, "init.txt"), "initial");
  git(staging, "add", "init.txt");
  git(staging, "commit", "-m", "initial commit");

  // Create bare origin from the staging repo
  const origin = join(testDir, `${name}-origin.git`);
  execFileSync("git", ["clone", "--bare", staging, origin], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Clone the origin into a work dir
  const work = join(testDir, `${name}-work`);
  execFileSync("git", ["clone", origin, work], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  git(work, "config", "user.email", "test@test.com");
  git(work, "config", "user.name", "Test");

  // Clean up staging
  rmSync(staging, { recursive: true, force: true });

  return { origin, work };
}

function commitFile(cwd: string, name: string, content: string, msg: string): void {
  writeFileSync(join(cwd, name), content);
  git(cwd, "add", name);
  git(cwd, "commit", "-m", msg);
}

// ── Test suite ──────────────────────────────────────────────────────────

let app: AppContext;
let testDir: string;

beforeAll(async () => {
  app = AppContext.forTest();
  await app.boot();
  setApp(app);
  testDir = join(tmpdir(), `ark-rebase-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
});

afterAll(async () => {
  await app?.shutdown();
  clearApp();
  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

describe("rebaseOntoBase", () => {
  it("rebases session branch onto origin/main", async () => {
    const { work } = setupRepo(testDir, "rebase-ok");

    // Create a feature branch with one commit
    git(work, "checkout", "-b", "ark-s-rebase01");
    commitFile(work, "feature.txt", "feature work", "add feature");

    // Advance main on origin (simulate another contributor)
    git(work, "checkout", "main");
    commitFile(work, "other.txt", "other work", "other commit");
    git(work, "push", "origin", "main");

    // Go back to feature branch
    git(work, "checkout", "ark-s-rebase01");

    // Create session pointing to this repo
    const session = app.sessions.create({ repo: work, workdir: work });
    app.sessions.update(session.id, { branch: "ark-s-rebase01" });

    const result = await rebaseOntoBase(app, session.id, { base: "main" });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("origin/main");

    // Verify the feature commit is now on top of the latest main
    const log = git(work, "log", "--oneline", "-3");
    expect(log).toContain("add feature");
    expect(log).toContain("other commit");

    // Verify event was logged
    const events = app.events.list(session.id);
    expect(events.some((e) => e.type === "rebase_completed")).toBe(true);
  });

  it("aborts cleanly on conflict", async () => {
    const { work } = setupRepo(testDir, "rebase-conflict");

    // Feature branch modifies init.txt (the only file from initial commit)
    git(work, "checkout", "-b", "ark-s-conflict01");
    commitFile(work, "init.txt", "feature change", "feature edit");

    // Main also modifies init.txt (conflict)
    git(work, "checkout", "main");
    commitFile(work, "init.txt", "main change", "main edit");
    git(work, "push", "origin", "main");

    git(work, "checkout", "ark-s-conflict01");

    const session = app.sessions.create({ repo: work, workdir: work });
    app.sessions.update(session.id, { branch: "ark-s-conflict01" });

    const result = await rebaseOntoBase(app, session.id, { base: "main" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Rebase failed");

    // Branch should be unchanged (rebase --abort was called)
    const content = git(work, "show", "HEAD:init.txt");
    expect(content).toBe("feature change");
  });

  it("returns error for missing session", async () => {
    const result = await rebaseOntoBase(app, "s-nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("returns error for session without repo", async () => {
    const session = app.sessions.create({ summary: "no repo" });
    const result = await rebaseOntoBase(app, session.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("no repo");
  });

  it("uses worktree dir when present", async () => {
    const { work } = setupRepo(testDir, "rebase-wt");

    // Create session
    const session = app.sessions.create({ repo: work, workdir: work });
    app.sessions.update(session.id, { branch: "ark-s-wt01" });

    // Create a worktree directory at the expected path
    const wtDir = join(app.config.worktreesDir, session.id);
    execFileSync("git", ["-C", work, "worktree", "add", wtDir, "-b", "ark-s-wt01"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Configure git in worktree
    git(wtDir, "config", "user.email", "test@test.com");
    git(wtDir, "config", "user.name", "Test");

    // Add a commit in the worktree
    commitFile(wtDir, "wt-feature.txt", "worktree feature", "worktree commit");

    // Advance main on origin
    git(work, "checkout", "main");
    commitFile(work, "other.txt", "other", "other commit");
    git(work, "push", "origin", "main");

    const result = await rebaseOntoBase(app, session.id, { base: "main" });
    expect(result.ok).toBe(true);

    // Verify rebase happened in the worktree
    const log = git(wtDir, "log", "--oneline", "-3");
    expect(log).toContain("worktree commit");
    expect(log).toContain("other commit");

    // Cleanup worktree
    try {
      execFileSync("git", ["-C", work, "worktree", "remove", wtDir, "--force"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      /* ignore */
    }
  });
});

describe("createWorktreePR auto-rebase integration", () => {
  it("skips rebase when auto_rebase is false in repo config", async () => {
    const { work } = setupRepo(testDir, "skip-rebase");

    git(work, "checkout", "-b", "ark-s-skiprebase01");
    commitFile(work, "feature.txt", "feature", "add feature");

    // Advance main on origin
    git(work, "checkout", "main");
    commitFile(work, "other.txt", "other", "other commit");
    git(work, "push", "origin", "main");
    git(work, "checkout", "ark-s-skiprebase01");

    // Write .ark.yaml with auto_rebase: false
    writeFileSync(join(work, ".ark.yaml"), "auto_rebase: false\n");

    const session = app.sessions.create({ repo: work, workdir: work });
    app.sessions.update(session.id, { branch: "ark-s-skiprebase01" });

    // Remember the commit before (should stay unchanged since rebase is skipped)
    const commitBefore = git(work, "rev-parse", "HEAD");

    // createWorktreePR will fail at push (no real remote with gh), but we can
    // verify the commit hasn't changed (no rebase happened)
    const { createWorktreePR } = await import("../services/session-orchestration.js");
    await createWorktreePR(app, session.id, { base: "main" });

    // PR creation will fail (no gh auth in tests), but rebase should NOT have happened
    const commitAfter = git(work, "rev-parse", "HEAD");
    expect(commitAfter).toBe(commitBefore);

    // There should be no rebase_completed event
    const events = app.events.list(session.id);
    expect(events.some((e) => e.type === "rebase_completed")).toBe(false);
  });

  it("performs rebase when auto_rebase is not set (default true)", async () => {
    const { work } = setupRepo(testDir, "default-rebase");

    git(work, "checkout", "-b", "ark-s-defaultrebase01");
    commitFile(work, "feature.txt", "feature", "add feature");

    // Advance main on origin
    git(work, "checkout", "main");
    commitFile(work, "other.txt", "other", "other commit");
    git(work, "push", "origin", "main");
    git(work, "checkout", "ark-s-defaultrebase01");

    const session = app.sessions.create({ repo: work, workdir: work });
    app.sessions.update(session.id, { branch: "ark-s-defaultrebase01" });

    const commitBefore = git(work, "rev-parse", "HEAD");

    const { createWorktreePR } = await import("../services/session-orchestration.js");
    // Will fail at push/gh but rebase should happen first
    await createWorktreePR(app, session.id, { base: "main" });

    const commitAfter = git(work, "rev-parse", "HEAD");
    // Commit should have changed due to rebase
    expect(commitAfter).not.toBe(commitBefore);

    // Rebase event should be logged
    const events = app.events.list(session.id);
    expect(events.some((e) => e.type === "rebase_completed")).toBe(true);
  });
});
