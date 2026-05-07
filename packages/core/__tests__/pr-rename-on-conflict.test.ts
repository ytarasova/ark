/**
 * Tests for createWorktreePR's auto-rename-on-non-fast-forward behaviour.
 *
 * Reproduces the failure mode observed 2026-05-06 on the fleet: a flow
 * runs to completion, the PR action attempts `git push -u origin <branch>`,
 * the upstream already carries a divergent `<branch>` from a prior
 * dispatch / manual setup, and the push is rejected non-fast-forward.
 *
 * The fix: detect the rejection, rename the local branch to
 * `<branch>-s-<sid8>`, retry the push once. The session's branch field is
 * updated and a `branch_renamed_on_conflict` event is emitted so the
 * operator can see why the PR landed under a renamed ref.
 *
 * Real git, no mocks, mirroring the auto-rebase test pattern.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AppContext } from "../app.js";
import { createWorktreePR } from "../services/worktree/index.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function commitFile(cwd: string, name: string, content: string, msg: string): void {
  writeFileSync(join(cwd, name), content);
  git(cwd, "add", name);
  git(cwd, "commit", "-m", msg);
}

let app: AppContext;
let testDir: string;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  testDir = join(tmpdir(), `ark-pr-rename-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
});

afterAll(async () => {
  await app?.shutdown();
  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

/**
 * Build origin with `<targetBranch>` already present (divergent commit) and
 * a fresh single-branch (main-only) clone for the session. Worktree is
 * NOT created here -- the caller supplies the session id so the worktree
 * lands at the path createWorktreePR expects (`{worktrees}/<sessionId>`).
 */
function setupDivergentOrigin(name: string, targetBranch: string): { origin: string; work: string } {
  const staging = join(testDir, `${name}-staging`);
  mkdirSync(staging, { recursive: true });
  git(staging, "init", "--initial-branch=main");
  git(staging, "config", "user.email", "t@t");
  git(staging, "config", "user.name", "t");
  writeFileSync(join(staging, "init.txt"), "init");
  git(staging, "add", "init.txt");
  git(staging, "commit", "-m", "init");
  git(staging, "checkout", "-b", targetBranch);
  commitFile(staging, "upstream.txt", "from upstream", `upstream ${targetBranch}`);
  git(staging, "checkout", "main");

  const origin = join(testDir, `${name}-origin.git`);
  execFileSync("git", ["clone", "--bare", staging, origin], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });

  const work = join(testDir, `${name}-work`);
  execFileSync("git", ["clone", "--single-branch", "--branch", "main", origin, work], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  git(work, "config", "user.email", "t@t");
  git(work, "config", "user.name", "t");

  rmSync(staging, { recursive: true, force: true });
  return { origin, work };
}

/**
 * Carve a session-owned worktree at the canonical path with a fresh commit
 * on `branch` -- guaranteed divergent from any upstream of the same name
 * because the local clone never fetched the upstream version.
 */
function carveSessionWorktree(work: string, sessionId: string, branch: string, marker: string): string {
  const wtDir = join(app.config.dirs.worktrees, sessionId);
  execFileSync("git", ["-C", work, "worktree", "add", wtDir, "-b", branch], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  git(wtDir, "config", "user.email", "t@t");
  git(wtDir, "config", "user.name", "t");
  writeFileSync(join(wtDir, `${marker}.txt`), marker);
  git(wtDir, "add", `${marker}.txt`);
  git(wtDir, "commit", "-m", `session ${marker}`);
  return wtDir;
}

describe("createWorktreePR -- branch rename on non-fast-forward", () => {
  it("renames to <branch>-s-<sid8> and retries push when origin has divergent history", async () => {
    const branch = "feat/foo";
    const { work } = setupDivergentOrigin("rename01", branch);

    const session = await app.sessions.create({ repo: work, branch });
    const wtDir = carveSessionWorktree(work, session.id, branch, "session-a");
    await app.sessions.update(session.id, { workdir: wtDir });

    const result = await createWorktreePR(app, session.id);

    // Push retry must have landed. Independent of PR-create outcome (no
    // GitHub host in this unit test):
    //   1. session.branch was updated to the suffixed name
    //   2. branch_renamed_on_conflict event was logged
    const expectedSuffix = `-s-${session.id.slice(0, 8)}`;
    const after = await app.sessions.get(session.id);
    expect(after?.branch).toBe(`${branch}${expectedSuffix}`);

    const events = await app.events.list(session.id);
    const renameEvent = events.find((e) => e.type === "branch_renamed_on_conflict");
    expect(renameEvent).toBeTruthy();
    expect((renameEvent?.data as any)?.from).toBe(branch);
    expect((renameEvent?.data as any)?.to).toBe(`${branch}${expectedSuffix}`);

    // Renamed branch exists on origin -- the retry push succeeded.
    const refs = git(work, "ls-remote", "origin", `${branch}${expectedSuffix}`);
    expect(refs).toContain(`${branch}${expectedSuffix}`);

    // No "git push failed" surfaced (any later failure such as no GitHub
    // host detection is fine for this test).
    if (result.ok === false) {
      expect(result.message).not.toContain("git push failed");
    }

    // Cleanup
    try {
      execFileSync("git", ["-C", work, "worktree", "remove", "--force", wtDir], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      /* ignore */
    }
  });

  it("does NOT rename when branch is already session-suffixed (avoid runaway stacking)", async () => {
    // Pre-create the session so we know the suffix we need to seed upstream with.
    const provisionalSession = await app.sessions.create({ summary: "rename02-provisional" });
    const sessionId = provisionalSession.id;
    const suffixedBranch = `feat/foo-s-${sessionId.slice(0, 8)}`;

    const { work, origin } = setupDivergentOrigin("rename02", suffixedBranch);

    // Reattach the session to this repo + branch.
    await app.sessions.update(sessionId, { repo: work, branch: suffixedBranch });
    const wtDir = carveSessionWorktree(work, sessionId, suffixedBranch, "session-b");
    await app.sessions.update(sessionId, { workdir: wtDir });

    void origin; // silence unused
    const result = await createWorktreePR(app, sessionId);

    // Already-suffixed branch must NOT be re-renamed. Push fails, original
    // git error surfaces.
    expect(result.ok).toBe(false);
    expect(result.message).toContain("git push failed");

    const after = await app.sessions.get(sessionId);
    expect(after?.branch).toBe(suffixedBranch); // unchanged

    const events = await app.events.list(sessionId);
    expect(events.some((e) => e.type === "branch_renamed_on_conflict")).toBe(false);

    // Cleanup
    try {
      execFileSync("git", ["-C", work, "worktree", "remove", "--force", wtDir], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      /* ignore */
    }
  });
});
