/**
 * `worktreeDiff` should diff against the repo's actual default branch, not a
 * hardcoded "main". Repos whose default is `master` or `develop` (Paytm's
 * convention) silently returned 0 files / 0 insertions in the Diff and Files
 * tabs even when the agent had committed real changes.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { AppContext } from "../app.js";
import { worktreeDiff } from "../services/worktree/git-ops.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
}, 30_000);

function setupRepoWithDefault(defaultBranch: string): { repo: string; wtDir: string } {
  const root = mkdtempSync(join(tmpdir(), "ark-wtdiff-test-"));
  const upstream = join(root, "upstream.git");
  const repo = join(root, "repo");

  // Bare upstream + local clone with HEAD pointing at the chosen default.
  mkdirSync(upstream, { recursive: true });
  execFileSync("git", ["init", "--bare", "--initial-branch=" + defaultBranch, upstream], { stdio: "pipe" });
  execFileSync("git", ["init", "--initial-branch=" + defaultBranch, repo], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t"], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "config", "user.name", "T"], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "remote", "add", "origin", upstream], { stdio: "pipe" });

  writeFileSync(join(repo, "README.md"), "# Hello\n");
  execFileSync("git", ["-C", repo, "add", "."], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "commit", "-m", "init"], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "push", "origin", defaultBranch], { stdio: "pipe" });
  // Ensure origin/HEAD points at the right branch.
  execFileSync("git", ["-C", repo, "remote", "set-head", "origin", defaultBranch], { stdio: "pipe" });

  // Now create a feature branch + commit a change.
  execFileSync("git", ["-C", repo, "checkout", "-b", "feat/x"], { stdio: "pipe" });
  writeFileSync(join(repo, "README.md"), "# Hello\n\n+marker\n");
  execFileSync("git", ["-C", repo, "commit", "-am", "marker"], { stdio: "pipe" });

  return { repo, wtDir: repo };
}

describe("worktreeDiff -- default-branch detection", () => {
  test("repo on `master` produces a non-empty diff against the right base", async () => {
    const { repo } = setupRepoWithDefault("master");
    const session = await app.sessions.create({
      summary: "diff master",
      repo,
      branch: "feat/x",
    });
    await app.sessions.update(session.id, { workdir: repo });

    const result = await worktreeDiff(app, session.id);
    expect(result.ok).toBe(true);
    expect(result.baseBranch).toBe("master");
    expect(result.filesChanged).toBe(1);
    expect(result.insertions).toBeGreaterThan(0);
  });

  test("repo on `develop` produces a non-empty diff against the right base", async () => {
    const { repo } = setupRepoWithDefault("develop");
    const session = await app.sessions.create({
      summary: "diff develop",
      repo,
      branch: "feat/x",
    });
    await app.sessions.update(session.id, { workdir: repo });

    const result = await worktreeDiff(app, session.id);
    expect(result.ok).toBe(true);
    expect(result.baseBranch).toBe("develop");
    expect(result.filesChanged).toBe(1);
  });

  test("explicit base override still wins", async () => {
    const { repo } = setupRepoWithDefault("master");
    const session = await app.sessions.create({
      summary: "diff override",
      repo,
      branch: "feat/x",
    });
    await app.sessions.update(session.id, { workdir: repo });

    const result = await worktreeDiff(app, session.id, { base: "master" });
    expect(result.baseBranch).toBe("master");
  });
});
