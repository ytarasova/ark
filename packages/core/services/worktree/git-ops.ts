/**
 * Worktree git operations -- diff, rebase, finish.
 *
 * Extracted from workspace-service.ts as part of the god-modules split.
 * All functions take app: AppContext as first arg. Pure file move, no
 * behavior change.
 */

import { existsSync } from "fs";
import { join } from "path";
import { promisify } from "util";
import { execFile } from "child_process";

import type { AppContext } from "../../app.js";
import { logDebug, logError, logInfo, logWarn } from "../../observability/structured-log.js";
import { createWorktreePR } from "./pr.js";

const execFileAsync = promisify(execFile);

const DEFAULT_BASE_BRANCH = "main";

/**
 * Resolve the repo's actual default branch instead of guessing `main`.
 * Tries `origin/HEAD` (the canonical "what branch does origin point at"),
 * falls back to inspecting common names, finally returns null. Without
 * this, `worktreeDiff` against repos whose default is `develop` (Paytm's
 * convention) returned 0 files / 0 insertions for every session whose
 * actual branch was forked off develop.
 */
async function detectDefaultBranch(repo: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      encoding: "utf-8",
    });
    const ref = stdout.trim();
    if (ref.startsWith("origin/")) return ref.slice("origin/".length);
    if (ref) return ref;
  } catch {
    /* fall through to common-name probe */
  }
  for (const candidate of ["main", "master", "develop"]) {
    try {
      await execFileAsync("git", ["-C", repo, "rev-parse", "--verify", `refs/remotes/origin/${candidate}`], {
        encoding: "utf-8",
      });
      return candidate;
    } catch {
      /* not this one */
    }
  }
  return null;
}

/**
 * Get a diff summary for a session's worktree branch vs its base branch.
 * Used for previewing changes before merge or PR creation.
 */
export async function worktreeDiff(
  app: AppContext,
  sessionId: string,
  opts?: {
    base?: string;
  },
): Promise<{
  ok: boolean;
  stat: string;
  diff: string;
  branch: string;
  baseBranch: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  modifiedSinceReview: string[];
  message?: string;
}> {
  const session = await app.sessions.get(sessionId);
  if (!session)
    return {
      ok: false,
      stat: "",
      diff: "",
      branch: "",
      baseBranch: "",
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      modifiedSinceReview: [],
      message: "Session not found",
    };

  const workdir = session.workdir;
  const repo = session.repo;
  if (!workdir || !repo)
    return {
      ok: false,
      stat: "",
      diff: "",
      branch: "",
      baseBranch: "",
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      modifiedSinceReview: [],
      message: "No workdir or repo",
    };

  // Determine the worktree path and branch
  const wtDir = join(app.config.dirs.worktrees, sessionId);
  let branch = session.branch;
  if (!branch && existsSync(wtDir)) {
    try {
      const { stdout } = await execFileAsync("git", ["-C", wtDir, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf-8",
      });
      branch = stdout.trim();
    } catch {
      logDebug("session", "worktree dir may not be a git repo yet -- branch stays undefined");
    }
  }
  if (!branch)
    return {
      ok: false,
      stat: "",
      diff: "",
      branch: "",
      baseBranch: "",
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      modifiedSinceReview: [],
      message: "Cannot determine branch",
    };

  // Use the repo's actual default branch when the caller didn't pin one.
  // Hard-coding "main" misses repos whose default is `develop` / `master`
  // and silently produces empty diffs.
  const baseBranch = opts?.base ?? (await detectDefaultBranch(repo)) ?? DEFAULT_BASE_BRANCH;

  try {
    // Get diff stat
    const { stdout: stat } = await execFileAsync("git", ["-C", repo, "diff", "--stat", `${baseBranch}...${branch}`], {
      encoding: "utf-8",
    });

    // Get full diff (truncated to 50KB)
    const { stdout: fullDiff } = await execFileAsync("git", ["-C", repo, "diff", `${baseBranch}...${branch}`], {
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
    });
    const diff = fullDiff.length > 50_000 ? fullDiff.slice(0, 50_000) + "\n... (truncated)" : fullDiff;

    // Parse shortstat for counts
    const { stdout: shortstat } = await execFileAsync(
      "git",
      ["-C", repo, "diff", "--shortstat", `${baseBranch}...${branch}`],
      { encoding: "utf-8" },
    );
    // "3 files changed, 42 insertions(+), 7 deletions(-)"
    const filesMatch = shortstat.match(/(\d+) files? changed/);
    const insMatch = shortstat.match(/(\d+) insertions?/);
    const delMatch = shortstat.match(/(\d+) deletions?/);

    // Track file hashes for re-review detection
    const modifiedSinceReview: string[] = [];
    try {
      const { stdout: diffNames } = await execFileAsync(
        "git",
        ["-C", repo, "diff", "--name-only", `${baseBranch}...${branch}`],
        { encoding: "utf-8" },
      );
      const files = diffNames.trim().split("\n").filter(Boolean);
      const fileHashes: Record<string, string> = {};
      for (const file of files) {
        try {
          const { stdout: hash } = await execFileAsync("git", ["-C", repo, "rev-parse", `${branch}:${file}`], {
            encoding: "utf-8",
          });
          fileHashes[file] = hash.trim();
        } catch {
          logInfo("session", "file may have been deleted");
        }
      }

      // Compare against previously reviewed hashes
      const prevSessionForReview = await app.sessions.get(sessionId);
      const prevReviewed = prevSessionForReview?.config?.reviewed_files as Record<string, string> | undefined;
      if (prevReviewed) {
        for (const file of files) {
          if (prevReviewed[file] && prevReviewed[file] !== fileHashes[file]) {
            modifiedSinceReview.push(file);
          }
        }
      }

      // Save current hashes as reviewed. Must await: under Temporal
      // semantics the activity can return before the DB write lands, so the
      // next worktreeDiff would read stale hashes and mis-report
      // modifiedSinceReview. Bun resolves synchronously today but that's
      // incidental.
      await app.sessions.mergeConfig(sessionId, { reviewed_files: fileHashes });
    } catch {
      logDebug("session", "re-review tracking is best-effort");
    }

    return {
      ok: true,
      stat,
      diff,
      branch,
      baseBranch,
      filesChanged: filesMatch ? parseInt(filesMatch[1]) : 0,
      insertions: insMatch ? parseInt(insMatch[1]) : 0,
      deletions: delMatch ? parseInt(delMatch[1]) : 0,
      modifiedSinceReview,
    };
  } catch (e: any) {
    return {
      ok: false,
      stat: "",
      diff: "",
      branch,
      baseBranch,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      modifiedSinceReview: [],
      message: e?.message ?? "Diff failed",
    };
  }
}

/**
 * Rebase the session branch onto the base branch before PR creation.
 * Fetches origin, then rebases onto origin/<base>. On conflict, aborts
 * the rebase and returns an error -- the branch is left unchanged.
 *
 * Remote-aware: for sessions on a non-`supportsWorktree` provider the agent's
 * commits live on the remote box, so the fetch + rebase must run there.
 * `runGit` (in pr.ts) routes the dispatch through `ArkdClient.run`; for
 * local sessions it falls back to the existing `execFileAsync` path.
 */
export async function rebaseOntoBase(
  app: AppContext,
  sessionId: string,
  opts?: {
    base?: string;
  },
): Promise<{ ok: boolean; message: string }> {
  const session = await app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  const repo = session.repo;
  if (!repo) return { ok: false, message: "Session has no repo" };

  // Local-side cwd for the local-dispatch path. The remote dispatcher
  // (runGit) ignores this and uses the provider's resolved remote workdir.
  const wtDir = join(app.config.dirs.worktrees, sessionId);
  const localCwd = existsSync(wtDir) ? wtDir : repo;
  const base = opts?.base ?? DEFAULT_BASE_BRANCH;

  // Lazy import to avoid the pr.ts <-> git-ops.ts circular at module load.
  const { runGit } = await import("./pr.js");

  try {
    // Fetch latest from origin so rebase target is up to date
    await runGit(app, session, ["fetch", "origin", base], { timeout: 30_000, localCwd });

    // Rebase onto origin/<base>
    await runGit(app, session, ["rebase", `origin/${base}`], { timeout: 60_000, localCwd });

    await app.events.log(sessionId, "rebase_completed", {
      stage: session.stage ?? undefined,
      actor: "system",
      data: { base },
    });

    return { ok: true, message: `Rebased onto origin/${base}` };
  } catch (e: any) {
    // Abort the rebase to leave the branch in its original state. Use the
    // same dispatcher so the abort lands on the same machine the rebase
    // was running on.
    try {
      await runGit(app, session, ["rebase", "--abort"], { timeout: 15_000, localCwd });
    } catch {
      logDebug("session", "already clean");
    }

    logWarn("session", `rebaseOntoBase: rebase failed for ${sessionId}: ${e?.message ?? e}`);
    return { ok: false, message: `Rebase failed: ${e?.message ?? e}` };
  }
}

/**
 * Finish a worktree session: merge branch into target, remove worktree, delete session.
 * Aborts safely on merge conflict without losing work.
 *
 * Pulls lifecycle ops (deleteSession, stop, runVerification) straight off
 * `app.sessionLifecycle` so there is no circular-import trick and no global
 * injection step required.
 */

export async function finishWorktree(
  app: AppContext,
  sessionId: string,
  opts?: {
    into?: string;
    noMerge?: boolean;
    keepBranch?: boolean;
    createPR?: boolean;
    force?: boolean;
  },
): Promise<{ ok: boolean; message: string }> {
  const session = await app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  const workdir = session.workdir;
  const repo = session.repo;
  if (!workdir || !repo)
    return {
      ok: false,
      message: "Session has no workdir or repo. Create a new session with --repo to enable worktree features.",
    };

  // Verify before finishing (unless force)
  if (!opts?.force) {
    const verify = await app.sessionLifecycle.runVerification(sessionId);
    if (!verify.ok) {
      return { ok: false, message: `Cannot finish: verification failed:\n${verify.message}` };
    }
  }

  // Determine the worktree path and branch
  const wtDir = join(app.config.dirs.worktrees, sessionId);
  const isWorktree = existsSync(wtDir);

  // Get the branch name from the worktree
  let branch: string | null = session.branch;
  if (!branch && isWorktree) {
    try {
      const { stdout } = await execFileAsync("git", ["-C", wtDir, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf-8",
      });
      branch = stdout.trim();
    } catch {
      logDebug("session", "worktree dir may not be a git repo yet -- branch stays undefined");
    }
  }

  if (!branch) return { ok: false, message: "Cannot determine worktree branch" };

  const targetBranch = opts?.into ?? DEFAULT_BASE_BRANCH;

  // 1. Stop the session if running
  if (!["completed", "failed", "killed", "stopped", "pending"].includes(session.status)) {
    await app.sessionLifecycle.stop(sessionId);
  }

  // 1b. Create PR instead of merging locally if requested
  if (opts?.createPR) {
    const prResult = await createWorktreePR(app, sessionId, {
      base: targetBranch,
      title: session.summary ?? undefined,
    });
    if (!prResult.ok) return prResult;
    // Still cleanup worktree after PR creation
    if (isWorktree) {
      try {
        await execFileAsync("git", ["-C", repo, "worktree", "remove", wtDir, "--force"], {
          encoding: "utf-8",
        });
      } catch (e: any) {
        logError("session", `finishWorktree: remove worktree failed: ${e?.message ?? e}`);
      }
    }
    await app.sessionLifecycle.deleteSession(sessionId);
    await app.events.log(sessionId, "worktree_finished", {
      actor: "user",
      data: { branch, targetBranch, merged: false, pr: true },
    });
    return { ok: true, message: `PR created and worktree cleaned up. ${prResult.pr_url ?? ""}`.trim() };
  }

  // 2. Merge branch into target (unless --no-merge)
  if (!opts?.noMerge) {
    try {
      // Checkout target branch in the main repo
      await execFileAsync("git", ["-C", repo, "checkout", targetBranch], {
        encoding: "utf-8",
      });
      // Merge the worktree branch
      await execFileAsync("git", ["-C", repo, "merge", branch, "--no-edit"], {
        encoding: "utf-8",
      });
    } catch {
      // Abort merge on conflict to preserve state
      try {
        await execFileAsync("git", ["-C", repo, "merge", "--abort"], {
          encoding: "utf-8",
        });
      } catch {
        logDebug("session", "merge --abort may fail if no merge in progress -- safe to ignore");
      }
      return {
        ok: false,
        message: `Merge conflict: ${branch} into ${targetBranch}. Resolve manually. Worktree preserved.`,
      };
    }
  }

  // 3. Remove worktree
  if (isWorktree) {
    try {
      await execFileAsync("git", ["-C", repo, "worktree", "remove", wtDir, "--force"], {
        encoding: "utf-8",
      });
    } catch (e: any) {
      logError("session", `finishWorktree: remove worktree failed: ${e?.message ?? e}`);
    }
  }

  // 4. Delete branch (unless --keep-branch)
  if (!opts?.keepBranch && branch !== targetBranch) {
    try {
      await execFileAsync("git", ["-C", repo, "branch", "-d", branch], {
        encoding: "utf-8",
      });
    } catch {
      // Branch may not exist or not be fully merged -- try force delete
      try {
        await execFileAsync("git", ["-C", repo, "branch", "-D", branch], {
          encoding: "utf-8",
        });
      } catch {
        logDebug("session", "force delete also failed -- branch may already be gone");
      }
    }
  }

  // 5. Delete the session
  await app.sessionLifecycle.deleteSession(sessionId);

  const mergeMsg = opts?.noMerge ? "skipped merge" : `merged ${branch} -> ${targetBranch}`;
  await app.events.log(sessionId, "worktree_finished", {
    actor: "user",
    data: { branch, targetBranch, merged: !opts?.noMerge },
  });

  return { ok: true, message: `Finished: ${mergeMsg}, worktree removed, session deleted` };
}
