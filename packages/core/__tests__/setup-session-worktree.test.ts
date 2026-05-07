/**
 * Regression tests for setupSessionWorktree.
 *
 * Bug s-6d2686: when a session is created with `repo: "."` (the self-dogfood
 * case), the old code bailed out of worktree creation because it checked
 * `workdir !== "."`. The session then ran with workdir pointing straight at
 * the live checkout, which was dangerous -- the agent edited the live repo,
 * and parallel dispatches would collide.
 *
 * The fix: always create a worktree when the resolved repo source is a git
 * repository, regardless of how the caller spelled the repo path.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, realpathSync } from "fs";
import { join, resolve } from "path";

/**
 * Resolve a path through symlinks (handles macOS /var → /private/var).
 * Used in assertions so we compare canonical paths regardless of how the
 * subject function obtained its answer.
 */
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}
import { AppContext } from "../app.js";
import { setupSessionWorktree } from "../services/worktree/index.js";

let app: AppContext;
let originalCwd: string;
let repoDir: string;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();

  // Set up a real git repo to serve as the "live" checkout.
  repoDir = join(app.config.dirs.ark, "fake-live-repo");
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", repoDir], { stdio: "pipe" });
  execFileSync("git", ["-C", repoDir, "config", "user.email", "test@example.com"], { stdio: "pipe" });
  execFileSync("git", ["-C", repoDir, "config", "user.name", "Test"], { stdio: "pipe" });
  execFileSync("git", ["-C", repoDir, "commit", "--allow-empty", "-m", "init"], { stdio: "pipe" });

  // Self-dogfood case: the session is dispatched from the repo dir itself.
  originalCwd = process.cwd();
  process.chdir(repoDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await app?.shutdown();
});

describe("setupSessionWorktree -- worktree isolation", async () => {
  it("creates a worktree when repo='.', even with no explicit workdir", async () => {
    // Reproduces the s-6d2686 failure: `--recipe self-dogfood` passes
    // `repo: "."` and leaves workdir null. The old code bailed because
    // `workdir ?? "."` was exactly ".".
    const session = await app.sessions.create({
      summary: "self-dogfood regression",
      repo: ".",
    });

    const effectiveWorkdir = await setupSessionWorktree(app, session, null);

    // The worktree must NOT be the live checkout.
    expect(effectiveWorkdir).not.toBe(repoDir);
    expect(effectiveWorkdir).not.toBe(".");
    expect(resolve(effectiveWorkdir)).not.toBe(resolve(repoDir));

    // The worktree must be under ~/.ark/worktrees/<sessionId>/
    const expectedWtDir = join(app.config.dirs.worktrees, session.id);
    expect(canonical(effectiveWorkdir)).toBe(canonical(expectedWtDir));
    expect(existsSync(expectedWtDir)).toBe(true);
    expect(existsSync(join(expectedWtDir, ".git"))).toBe(true);
  });

  it("persists the absolute worktree path to the session row", async () => {
    const session = await app.sessions.create({
      summary: "persist-workdir test",
      repo: ".",
    });

    const effectiveWorkdir = await setupSessionWorktree(app, session, null);

    const updated = await app.sessions.get(session.id);
    expect(updated).not.toBeNull();
    expect(updated!.workdir).toBe(resolve(effectiveWorkdir));
    // And it must be an absolute path, not "." or null.
    expect(updated!.workdir).not.toBe(".");
    expect(updated!.workdir?.startsWith("/")).toBe(true);
  });

  it("creates a worktree when workdir is explicitly an absolute git repo path", async () => {
    // The "normal" path -- workdir is an absolute directory that happens to
    // be a git repo. This was already working before the fix; this test
    // guards against regressions from the repoSource resolution change.
    const session = await app.sessions.create({
      summary: "absolute workdir",
      repo: repoDir,
      workdir: repoDir,
    });

    const effectiveWorkdir = await setupSessionWorktree(app, session, null);

    expect(effectiveWorkdir).not.toBe(repoDir);
    const expectedWtDir = join(app.config.dirs.worktrees, session.id);
    expect(canonical(effectiveWorkdir)).toBe(canonical(expectedWtDir));
  });

  it("does NOT create a worktree when config.worktree === false", async () => {
    const session = await app.sessions.create({
      summary: "opt-out",
      repo: ".",
      config: { worktree: false },
    });

    const effectiveWorkdir = await setupSessionWorktree(app, session, null);

    // When worktree is explicitly disabled, we fall back to the resolved repo
    // source (the live checkout). No worktree directory is created.
    const wtDir = join(app.config.dirs.worktrees, session.id);
    expect(existsSync(wtDir)).toBe(false);
    expect(canonical(effectiveWorkdir)).toBe(canonical(repoDir));
  });

  it("does NOT create a worktree when the resolved repo source is not a git repo", async () => {
    // Non-git directory -- same behaviour as before the fix: skip worktree.
    const nonGitDir = join(app.config.dirs.ark, "not-a-repo");
    mkdirSync(nonGitDir, { recursive: true });

    const session = await app.sessions.create({
      summary: "non-git",
      repo: nonGitDir,
      workdir: nonGitDir,
    });

    const effectiveWorkdir = await setupSessionWorktree(app, session, null);

    const wtDir = join(app.config.dirs.worktrees, session.id);
    expect(existsSync(wtDir)).toBe(false);
    expect(resolve(effectiveWorkdir)).toBe(resolve(nonGitDir));
  });
});
