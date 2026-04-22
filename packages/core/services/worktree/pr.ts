/**
 * Worktree PR operations -- GitHub/GitLab API calls via gh CLI.
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
import { loadRepoConfig } from "../../repo-config.js";
import { logDebug, logWarn } from "../../observability/structured-log.js";
import { rebaseOntoBase } from "./git-ops.js";

const execFileAsync = promisify(execFile);

const DEFAULT_BASE_BRANCH = "main";

/**
 * Create a GitHub PR from a session's worktree branch.
 * Optionally rebases onto the base branch first (controlled by repo config auto_rebase, default true).
 * Pushes the branch and creates the PR via gh CLI.
 */
export async function createWorktreePR(
  app: AppContext,
  sessionId: string,
  opts?: {
    title?: string;
    body?: string;
    base?: string;
    draft?: boolean;
  },
): Promise<{ ok: boolean; message: string; pr_url?: string }> {
  const session = await app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  const repo = session.repo;
  if (!repo) return { ok: false, message: "Session has no repo" };

  // Determine branch
  const wtDir = join(app.config.worktreesDir, sessionId);
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
  if (!branch) return { ok: false, message: "Cannot determine worktree branch" };

  const base = opts?.base ?? DEFAULT_BASE_BRANCH;
  const title = opts?.title ?? session.summary ?? `ark: ${sessionId}`;
  const body = opts?.body ?? `Session: ${sessionId}\nFlow: ${session.flow}\nAgent: ${session.agent ?? "default"}`;

  // Auto-rebase onto base branch (unless disabled in repo config)
  const repoConfig = session.workdir ? loadRepoConfig(session.workdir) : {};
  if (repoConfig.auto_rebase !== false) {
    const rebaseResult = await rebaseOntoBase(app, sessionId, { base });
    if (!rebaseResult.ok) {
      // Rebase failed (conflict) -- still proceed with PR creation without rebase.
      // The PR will show merge conflicts on GitHub, which is preferable to blocking.
      logWarn(
        "session",
        `createWorktreePR: auto-rebase failed for ${sessionId}, proceeding without rebase: ${rebaseResult.message}`,
      );
    }
  }

  try {
    // 1. Push branch
    const pushDir = existsSync(wtDir) ? wtDir : repo;
    await execFileAsync("git", ["-C", pushDir, "push", "-u", "origin", branch], { encoding: "utf-8", timeout: 30_000 });

    // 2. Create PR via gh CLI
    const ghArgs = ["pr", "create", "--repo", repo, "--head", branch, "--base", base, "--title", title, "--body", body];
    if (opts?.draft) ghArgs.push("--draft");
    const { stdout } = await execFileAsync("gh", ghArgs, { encoding: "utf-8", timeout: 30_000, cwd: pushDir });
    const prUrl = stdout.trim();

    // 3. Store PR URL on session
    await app.sessions.update(sessionId, { pr_url: prUrl });
    await app.events.log(sessionId, "pr_created", {
      stage: session.stage ?? undefined,
      actor: "user",
      data: { pr_url: prUrl, branch, base, draft: opts?.draft ?? false },
    });

    return { ok: true, message: `PR created: ${prUrl}`, pr_url: prUrl };
  } catch (e: any) {
    return { ok: false, message: `PR creation failed: ${e?.message ?? e}` };
  }
}

/**
 * Merge an existing PR via `gh pr merge`. Used by the auto_merge action stage.
 * Requires the session to have a pr_url (set by a preceding create_pr stage).
 */
export async function mergeWorktreePR(
  app: AppContext,
  sessionId: string,
  opts?: {
    method?: "merge" | "squash" | "rebase";
    deleteAfter?: boolean;
  },
): Promise<{ ok: boolean; message: string }> {
  const session = await app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  const prUrl = session.pr_url;
  if (!prUrl) return { ok: false, message: "Session has no PR URL -- run create_pr first" };

  const repo = session.repo;
  if (!repo) return { ok: false, message: "Session has no repo" };

  const method = opts?.method ?? "squash";
  const deleteAfter = opts?.deleteAfter ?? true;

  try {
    const ghArgs = ["pr", "merge", prUrl, `--${method}`, "--auto"];
    if (deleteAfter) ghArgs.push("--delete-branch");
    const cwd = session.workdir ?? repo;
    await execFileAsync("gh", ghArgs, { encoding: "utf-8", timeout: 30_000, cwd });

    await app.events.log(sessionId, "pr_merged", {
      stage: session.stage ?? undefined,
      actor: "system",
      data: { pr_url: prUrl, method, delete_branch: deleteAfter },
    });

    return { ok: true, message: `PR merge initiated: ${prUrl}` };
  } catch (e: any) {
    return { ok: false, message: `PR merge failed: ${e?.message ?? e}` };
  }
}
