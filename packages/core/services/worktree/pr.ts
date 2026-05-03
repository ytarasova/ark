/**
 * Worktree PR operations -- GitHub/GitLab/Bitbucket aware PR creation.
 *
 * Originally extracted from workspace-service.ts as part of the god-modules split.
 * Subsequently extended to be remote-aware: when a session is dispatched on a
 * compute target whose `provider.supportsWorktree === false` (EC2, k8s, ...)
 * the agent's commits live on the remote box, NOT in the conductor-side
 * `~/.ark/worktrees/<sessionId>` clone. Routing `git push` / `git fetch` /
 * `git rebase` through `execFileAsync` against the local clone fails with
 * `src refspec ... does not match any` -- the local clone never saw the
 * commits. We now dispatch every git invocation through `runGit`, which
 * picks `ArkdClient.run` (against the remote workdir) for remote computes
 * and the existing `execFileAsync("git", ...)` for local ones.
 *
 * PR-host detection: GitHub / GitLab / Bitbucket are detected from the git
 * remote URL. GitHub gets the original `gh pr create` path; the others get
 * a graceful degraded path -- branch is pushed, the "Create a pull request"
 * URL is parsed out of the push stderr (Bitbucket emits one) or the remote
 * URL is returned. Auto-merge on non-GitHub hosts is intentionally not
 * supported and surfaces `ok: false` so the session goes to `failed` with
 * a clear reason.
 */

import { existsSync } from "fs";
import { basename, join } from "path";
import { promisify } from "util";
import { execFile } from "child_process";

import type { AppContext } from "../../app.js";
import type { Session, Compute } from "../../../types/index.js";
import type { ComputeProvider } from "../../../compute/types.js";
import { ArkdClient } from "../../../arkd/client.js";
import { resolveProvider } from "../../compute-resolver.js";
import { loadRepoConfig } from "../../repo-config.js";
import { logDebug, logWarn } from "../../observability/structured-log.js";
import { rebaseOntoBase } from "./git-ops.js";

const execFileAsync = promisify(execFile);

const DEFAULT_BASE_BRANCH = "main";

// ── Host detection ──────────────────────────────────────────────────────────

export type GitHost = "github" | "bitbucket" | "gitlab" | "unknown";

/**
 * Detect the git-hosting service from a remote URL. Handles both SSH
 * (`git@github.com:owner/repo.git`) and HTTPS (`https://github.com/owner/repo`)
 * shapes. Returns "unknown" for self-hosted / unrecognized hosts so the
 * caller falls into the push-only degraded path.
 */
export function detectGitHost(repoUrl: string | null | undefined): GitHost {
  if (!repoUrl) return "unknown";
  const lower = repoUrl.toLowerCase();
  if (lower.includes("github.com")) return "github";
  if (lower.includes("bitbucket.org")) return "bitbucket";
  if (lower.includes("gitlab.com")) return "gitlab";
  return "unknown";
}

// ── Remote-aware git dispatcher ─────────────────────────────────────────────

interface GitOpts {
  /** Per-call timeout in ms (default 30s). */
  timeout?: number;
  /**
   * Force a local-cwd override. Used by callers that already computed a
   * conductor-side path (e.g. `mergeWorktreePR` falls back to `~/.ark`).
   * Ignored when the dispatch goes through `ArkdClient.run`.
   */
  localCwd?: string;
}

interface GitResult {
  stdout: string;
  stderr: string;
}

/**
 * Resolve the (provider, compute) pair for a session and tell the caller
 * whether the dispatch should be routed through `ArkdClient.run` against the
 * remote workdir.
 *
 * Remote = `provider.supportsWorktree === false` and `provider.getArkdUrl`
 * exists. Everything else (local, missing provider, missing compute) falls
 * back to the local `execFileAsync` path.
 */
async function resolveRemoteRouting(
  app: AppContext,
  session: Session,
): Promise<{ remote: false } | { remote: true; client: ArkdClient; remoteWorkdir: string }> {
  const { provider, compute } = await resolveProvider(app, session);
  if (!provider || !compute) return { remote: false };
  if (provider.supportsWorktree) return { remote: false };
  if (!provider.getArkdUrl) return { remote: false };

  const remoteWorkdir = resolveRemoteWorkdir(provider, compute, session);
  if (!remoteWorkdir) {
    logWarn(
      "session",
      `runGit: provider '${provider.name}' is remote but resolveWorkdir returned null for session ${session.id}; ` +
        `falling back to local dispatch`,
    );
    return { remote: false };
  }

  // RESILIENCE: ensure the arkd transport is up before we build the client.
  // After a daemon restart the previous SSM tunnel is dead but its port may
  // still be cached on session.config / compute.config. Calling
  // `target.compute.ensureReachable` re-allocates a fresh tunnel and writes
  // the new port; without this, the action stage would post to a dead
  // localhost port and fail with ECONNREFUSED.
  try {
    const { resolveComputeTarget } = await import("../../compute-resolver.js");
    const { target } = await resolveComputeTarget(app, session);
    if (target?.compute.ensureReachable) {
      const handle = { kind: target.compute.kind, name: compute.name, meta: {} };
      await target.compute.ensureReachable(handle, { app, sessionId: session.id });
    }
  } catch (err: any) {
    logWarn(
      "session",
      `runGit: ensureReachable failed for session ${session.id}: ${err?.message ?? err}; ` +
        `proceeding with cached arkd URL (RPC may fail with ECONNREFUSED)`,
    );
  }

  // Fetch the (possibly refreshed) session row so getArkdUrl reads the
  // freshly-written port. Pass the session into getArkdUrl so the
  // session-aware lookup runs (the per-session port wins over the
  // compute-level cache, see #423).
  const refreshed = (await app.sessions.get(session.id)) ?? session;
  const arkdUrl = provider.getArkdUrl(compute, refreshed);
  const cfg = compute.config as { arkd_request_timeout_ms?: number } | null | undefined;
  const requestTimeoutMs = typeof cfg?.arkd_request_timeout_ms === "number" ? cfg.arkd_request_timeout_ms : undefined;
  const client = new ArkdClient(arkdUrl, requestTimeoutMs ? { requestTimeoutMs } : undefined);
  return { remote: true, client, remoteWorkdir };
}

/**
 * Best-effort remote workdir for the agent's clone. Prefers the provider's
 * own `resolveWorkdir` (the canonical hook the launcher uses, e.g.
 * `RemoteWorktreeProvider` returns `${REMOTE_HOME}/Projects/<repoBasename>`).
 * Falls back to `session.config.remoteWorkdir` (set by some launch flows)
 * and finally to `${REMOTE_HOME}/Projects/<basename(session.repo)>` -- the
 * convention used by EC2 cloud-init.
 */
function resolveRemoteWorkdir(provider: ComputeProvider, compute: Compute, session: Session): string | null {
  if (provider.resolveWorkdir) {
    const wd = provider.resolveWorkdir(compute, session);
    if (wd) return wd;
  }
  const cfgWd = (session.config as { remoteWorkdir?: string } | null | undefined)?.remoteWorkdir;
  if (cfgWd) return cfgWd;
  // Last resort: derive from the repo name. Matches the
  // `${REMOTE_HOME}/Projects/<repo>` convention used by RemoteWorktreeProvider
  // and by cloud-init.
  const src = (session.config as { remoteRepo?: string } | null | undefined)?.remoteRepo ?? session.repo;
  if (!src) return null;
  const repoName = basename(src).replace(/\.git$/, "");
  return `/home/ubuntu/Projects/${repoName}`;
}

/**
 * Run `git <args>` in the right place for this session. Local sessions go
 * through `execFileAsync("git", ["-C", localCwd, ...args])`; remote sessions
 * go through `ArkdClient.run({ command: "git", args, cwd: remoteWorkdir })`.
 *
 * The function never throws on non-zero exit -- callers inspect `stdout`/
 * `stderr` (both populated for remote, only `stdout` is populated for the
 * happy local path; `execFileAsync` throws on non-zero, which we let
 * propagate). For symmetry between paths we re-throw on a non-zero exit
 * code from the remote dispatcher.
 */
export async function runGit(app: AppContext, session: Session, args: string[], opts?: GitOpts): Promise<GitResult> {
  const timeout = opts?.timeout ?? 30_000;
  const routing = await resolveRemoteRouting(app, session);
  if (routing.remote) {
    const res = await routing.client.run({
      command: "git",
      args,
      cwd: routing.remoteWorkdir,
      timeout,
    });
    if (res.exitCode !== 0) {
      const err: Error & { stdout?: string; stderr?: string; code?: number } = new Error(
        `git ${args.join(" ")} failed (exit ${res.exitCode}): ${res.stderr || res.stdout}`,
      );
      err.stdout = res.stdout;
      err.stderr = res.stderr;
      err.code = res.exitCode;
      throw err;
    }
    return { stdout: res.stdout, stderr: res.stderr };
  }

  // Local dispatch.
  const cwd = opts?.localCwd;
  const finalArgs = cwd ? ["-C", cwd, ...args] : args;
  const { stdout, stderr } = await execFileAsync("git", finalArgs, {
    encoding: "utf-8",
    timeout,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
}

/**
 * Build the argv for `gh pr create`. Extracted so it's unit-testable
 * without stubbing child_process.
 *
 * We never pass `--repo`: `gh` auto-detects the owner/name from the git
 * remote of `cwd`, which is always the worktree. `session.repo` is a
 * filesystem path, not the `OWNER/NAME` shape `--repo` expects -- passing
 * it caused `gh` to reject the call with "expected the [HOST/]OWNER/REPO
 * format" on local dispatches.
 */
export function buildGhPrCreateArgs(opts: {
  head: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
}): string[] {
  const args = ["pr", "create", "--head", opts.head, "--base", opts.base, "--title", opts.title, "--body", opts.body];
  if (opts.draft) args.push("--draft");
  return args;
}

/**
 * Parse a "Create a pull request" URL out of `git push` stderr. Bitbucket
 * Cloud + Bitbucket Server both emit lines of the form:
 *
 *   remote: Create pull request for <branch>:
 *   remote:   https://bitbucket.org/<owner>/<repo>/pull-requests/new?source=<branch>
 *
 * GitLab emits something similar. Returns the first http(s) URL found on a
 * `remote:` line, or null.
 */
export function parseCreatePrUrl(pushStderr: string): string | null {
  if (!pushStderr) return null;
  const lines = pushStderr.split(/\r?\n/);
  for (const line of lines) {
    if (!line.includes("remote:")) continue;
    const m = line.match(/https?:\/\/[^\s)>\]"']+/);
    if (m) return m[0];
  }
  return null;
}

/**
 * Determine the canonical "view this branch" URL on the host. Used as a
 * fallback when the push stderr didn't include a Create-PR URL -- gives
 * the operator a clickable starting point even when we can't construct
 * the precise PR-creation URL.
 */
function fallbackBranchUrl(host: GitHost, remoteUrl: string | null, branch: string): string | null {
  if (!remoteUrl) return null;
  // Normalize ssh-style `git@host:owner/repo(.git)` to `https://host/owner/repo`.
  let normalized = remoteUrl;
  const sshMatch = normalized.match(/^git@([^:]+):(.+?)(\.git)?$/);
  if (sshMatch) normalized = `https://${sshMatch[1]}/${sshMatch[2]}`;
  normalized = normalized.replace(/\.git$/, "");
  if (host === "bitbucket") return `${normalized}/branch/${encodeURIComponent(branch)}`;
  if (host === "gitlab") return `${normalized}/-/tree/${encodeURIComponent(branch)}`;
  if (host === "github") return `${normalized}/tree/${encodeURIComponent(branch)}`;
  return normalized;
}

/**
 * Read the `origin` remote URL via the same dispatcher used for push/rebase.
 * Returns null on any error (not a git repo, no origin, network failure on
 * remote, etc.).
 */
async function readOriginUrl(app: AppContext, session: Session, localCwd?: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(app, session, ["remote", "get-url", "origin"], { timeout: 15_000, localCwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Create a PR from a session's worktree branch.
 *
 * Routing:
 *   - Local provider: `git push` / `gh pr create` run against the local
 *     worktree clone (as before).
 *   - Remote provider (EC2, k8s, ...): `git push` runs through arkd against
 *     the remote workdir; PR creation depends on the host -- GitHub uses
 *     `gh pr create` (today still on the conductor; out-of-scope to install
 *     `gh` on EC2), Bitbucket / GitLab / unknown get the push-only path
 *     and surface the host's "create a PR" web URL as `pr_url`.
 *
 * Auto-rebase still runs first when enabled in repo config; rebase failures
 * are non-fatal (the resulting PR shows the conflicts, which is preferable
 * to silent failure here).
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

  // Determine which side the agent worked on.
  const routing = await resolveRemoteRouting(app, session);

  // Determine branch. For remote sessions we trust session.branch (set at
  // dispatch); if missing, ask remote git via runGit. For local, fall back
  // to the worktree dir as before -- bail to "Cannot determine branch" if
  // wtDir does not exist (avoid having `rev-parse` resolve to whatever the
  // dispatcher's cwd happens to be).
  const wtDir = join(app.config.dirs.worktrees, sessionId);
  let branch = session.branch;
  if (!branch) {
    if (routing.remote) {
      try {
        const { stdout } = await runGit(app, session, ["rev-parse", "--abbrev-ref", "HEAD"], { timeout: 15_000 });
        branch = stdout.trim() || null;
      } catch {
        logDebug("session", "could not resolve branch via runGit (remote) -- branch stays undefined");
      }
    } else if (existsSync(wtDir)) {
      try {
        const { stdout } = await runGit(app, session, ["rev-parse", "--abbrev-ref", "HEAD"], {
          timeout: 15_000,
          localCwd: wtDir,
        });
        branch = stdout.trim() || null;
      } catch {
        logDebug("session", "worktree dir may not be a git repo yet -- branch stays undefined");
      }
    }
  }
  if (!branch) return { ok: false, message: "Cannot determine worktree branch" };

  const base = opts?.base ?? DEFAULT_BASE_BRANCH;
  const title = opts?.title ?? session.summary ?? `ark: ${sessionId}`;
  const body = opts?.body ?? `Session: ${sessionId}\nFlow: ${session.flow}\nAgent: ${session.agent ?? "default"}`;

  // Auto-rebase onto base branch (unless disabled in repo config). For
  // remote sessions there's no `.ark.yaml` on the conductor's filesystem
  // (the file lives on the remote box); we still load it from session.workdir
  // as a best-effort -- it's a no-op if the path doesn't exist.
  const repoConfig = session.workdir ? loadRepoConfig(session.workdir) : {};
  if (repoConfig.auto_rebase !== false) {
    const rebaseResult = await rebaseOntoBase(app, sessionId, { base });
    if (!rebaseResult.ok) {
      // Rebase failed (conflict) -- still proceed with PR creation without rebase.
      // The PR will show merge conflicts on the host, which is preferable to
      // blocking. (Note: if this is a remote session and the rebase failed
      // because the remote had no upstream config, the push below will set
      // it via `-u`.)
      logWarn(
        "session",
        `createWorktreePR: auto-rebase failed for ${sessionId}, proceeding without rebase: ${rebaseResult.message}`,
      );
    }
  }

  // For the `gh pr create` step (GitHub only) we need a local cwd -- gh
  // can't talk to a remote worktree. We always use the conductor's local
  // worktree if it exists; remote-host GitHub PRs are out of scope (would
  // need `gh` installed on EC2).
  const localPushDir = existsSync(wtDir) ? wtDir : repo;

  try {
    // 1. Push branch. For remote sessions this dispatches over arkd; for
    //    local it execs git directly.
    const pushArgs = ["push", "-u", "origin", branch];
    let pushStdout = "";
    let pushStderr = "";
    try {
      const r = await runGit(app, session, pushArgs, {
        timeout: 60_000,
        localCwd: routing.remote ? undefined : localPushDir,
      });
      pushStdout = r.stdout;
      pushStderr = r.stderr;
    } catch (e: any) {
      // Surface stderr if the dispatcher attached it (remote path).
      const reason = e?.stderr || e?.message || String(e);
      return { ok: false, message: `git push failed: ${reason}` };
    }

    // 2. Decide host. For remote we read origin from the remote workdir;
    //    for local we read it from the local worktree.
    const originUrl = await readOriginUrl(app, session, routing.remote ? undefined : localPushDir);
    const host = detectGitHost(originUrl);

    let prUrl: string | undefined;

    if (host === "github") {
      // GitHub: original `gh pr create` path. Only reachable for local
      // dispatches today (we don't install `gh` on EC2). For remote-GitHub
      // sessions, fall through to the parsed/fallback URL behaviour.
      if (!routing.remote) {
        try {
          const ghArgs = buildGhPrCreateArgs({ head: branch, base, title, body, draft: opts?.draft });
          const { stdout } = await execFileAsync("gh", ghArgs, {
            encoding: "utf-8",
            timeout: 30_000,
            cwd: localPushDir,
          });
          prUrl = stdout.trim();
        } catch (e: any) {
          // gh failed (auth missing, repo unrecognized, etc.) -- degrade.
          logWarn("session", `createWorktreePR: gh pr create failed for ${sessionId}, degrading: ${e?.message ?? e}`);
          prUrl = parseCreatePrUrl(pushStderr) ?? fallbackBranchUrl(host, originUrl, branch) ?? undefined;
        }
      } else {
        // Remote GitHub: `gh` not installed on the box. Push succeeded;
        // surface the parsed/fallback URL.
        prUrl = parseCreatePrUrl(pushStderr) ?? fallbackBranchUrl(host, originUrl, branch) ?? undefined;
      }
    } else {
      // Bitbucket / GitLab / unknown: push-only path. Bitbucket's git
      // server emits a Create-PR URL on push stderr; GitLab does the same.
      // Unknown hosts fall back to the branch URL.
      prUrl = parseCreatePrUrl(pushStderr) ?? fallbackBranchUrl(host, originUrl, branch) ?? undefined;
    }

    // 3. Persist whatever URL we got. If we got nothing at all, still record
    //    a "branch pushed" success -- the operator can find the PR manually
    //    and downstream merge logic will surface a clear "no PR URL" error.
    if (prUrl) {
      await app.sessions.update(sessionId, { pr_url: prUrl });
    }
    await app.events.log(sessionId, "pr_created", {
      stage: session.stage ?? undefined,
      actor: "user",
      data: { pr_url: prUrl ?? null, branch, base, draft: opts?.draft ?? false, host, remote: routing.remote },
    });

    if (prUrl) {
      const note = host === "github" ? "" : ` (host=${host}; auto-merge not supported)`;
      return { ok: true, message: `PR created: ${prUrl}${note}`, pr_url: prUrl };
    }
    // No URL but push succeeded -- treat as ok so callers don't block.
    void pushStdout;
    return {
      ok: true,
      message: `Branch ${branch} pushed to origin (host=${host}); no PR URL surfaced -- create one manually`,
    };
  } catch (e: any) {
    return { ok: false, message: `PR creation failed: ${e?.message ?? e}` };
  }
}

/**
 * Merge an existing PR via `gh pr merge`. Used by the auto_merge action stage.
 * Requires the session to have a pr_url (set by a preceding create_pr stage).
 *
 * Only GitHub PRs can be auto-merged from this code path -- `gh pr merge`
 * is GitHub-specific. Bitbucket / GitLab / unknown hosts return a clean
 * `ok: false` with a clear message so the surrounding session goes to
 * `failed` rather than crashing.
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

  // Refuse to drive non-GitHub hosts. `gh pr merge` only knows GitHub --
  // running it against a Bitbucket URL emits a confusing "no such PR"
  // error. Surface a clean failure so the surrounding session goes to
  // failed with a clear reason.
  const host = detectGitHost(prUrl);
  if (host !== "github") {
    return {
      ok: false,
      message: `auto-merge not supported for non-github hosts (host=${host}, pr_url=${prUrl})`,
    };
  }

  const method = opts?.method ?? "squash";
  const deleteAfter = opts?.deleteAfter ?? true;

  try {
    const ghArgs = ["pr", "merge", prUrl, `--${method}`, "--auto"];
    if (deleteAfter) ghArgs.push("--delete-branch");
    // `gh pr merge <url>` derives the repo from the URL itself -- the cwd
    // doesn't need to be a git checkout. Older code passed
    // `session.workdir ?? repo`, but for remote-repo sessions
    // session.workdir points at a phantom local path
    // (e.g. /Users/<u>/Projects/<repo>/<repo>) and session.repo is just the
    // basename ("ark"), so posix_spawn errored with ENOTDIR. Prefer the
    // local worktree if it exists; otherwise fall back to the conductor's
    // arkDir (always present).
    const wtDir = join(app.config.dirs.worktrees, sessionId);
    const cwd = existsSync(wtDir) ? wtDir : app.config.dirs.ark;
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
