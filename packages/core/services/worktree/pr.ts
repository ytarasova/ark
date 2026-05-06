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
import { ArkdClient } from "../../../arkd/client/index.js";
import { resolveProvider } from "../../compute-resolver.js";
import { loadRepoConfig } from "../../repo-config.js";
import { logDebug, logInfo, logWarn } from "../../observability/structured-log.js";
import { rebaseOntoBase } from "./git-ops.js";
import { createPullRequest, mergePullRequest, parseGithubOwnerRepoFromUrl, type GithubDeps } from "../github/rest.js";

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
  // Action stages don't go through dispatch-core's lifecycle, so they must
  // resolve the same handle (with its compute-specific meta -- instance_id
  // for EC2, etc.) and call ensureReachable themselves. Building a stub
  // `{meta:{}}` handle here was the bug: ensureReachable hit `readMeta(h)`
  // which threw "missing meta.ec2", the catch swallowed the error, and
  // getArkdUrl then threw "no arkd_local_forward_port" -- causing every
  // action stage on a remote compute to fail after a conductor restart.
  try {
    const { resolveTargetAndHandle } = await import("../dispatch/target-resolver.js");
    const { target, handle } = await resolveTargetAndHandle(app, session);
    if (target?.compute.ensureReachable && handle) {
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
  // For Bitbucket / GitLab the "branch" page IS where the operator manually
  // opens a PR -- they emit no Create-PR URL on push. Returning the branch
  // URL is a useful hint even though it's not a real PR URL.
  if (host === "bitbucket") return `${normalized}/branch/${encodeURIComponent(branch)}`;
  if (host === "gitlab") return `${normalized}/-/tree/${encodeURIComponent(branch)}`;
  // For GitHub we DELIBERATELY do NOT return a tree URL: GitHub PRs require
  // explicit creation via `gh pr create` or the API; storing a tree URL as
  // pr_url breaks downstream `gh pr merge <url>` (the conductor's auto_merge
  // action) which only accepts /pull/<N> URLs. Returning null forces the
  // caller to either resolve a real PR URL via gh (when available) or
  // record `pr_url=null` so auto_merge surfaces a clear "no PR URL" error
  // instead of feeding an invalid URL to gh.
  if (host === "github") return null;
  return normalized;
}

/**
 * Recognize the URL shapes `gh pr merge` accepts as a real PR URL:
 *   - https://github.com/owner/repo/pull/<N>
 *   - https://github.com/owner/repo/pull/<N>/...
 *
 * Tree URLs (`/tree/<branch>`), branch URLs, and the bare repo URL all
 * fall through. Used by `mergeWorktreePR` to refuse merge attempts where
 * `pr_url` was populated with a non-PR URL by an earlier degraded-path.
 */
export function isGithubPrUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return /^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(\/|$)/.test(url);
}

/**
 * Resolve the GitHub token for this session's tenant.
 *
 * Resolution order:
 *   1. Tenant-scoped `GITHUB_TOKEN` in the secrets store. The right place
 *      for a credential -- it's per-tenant, never logged, redacted at
 *      every boundary.
 *   2. `process.env.GITHUB_TOKEN`. Conductor-process fallback for legacy
 *      deployments that pass the token via env at daemon startup.
 *   3. null. The action stage falls back to the legacy `gh` CLI path
 *      (local dispatch only) and surfaces a clear error elsewhere.
 *
 * This helper centralises the lookup so the three call sites in this
 * file (push origin auth, REST createPullRequest, REST mergePullRequest)
 * stay consistent. Adding gh-app or fine-grained-PAT support later
 * means one function change instead of three.
 */
async function resolveGithubToken(app: AppContext, session: Session): Promise<string | undefined> {
  try {
    const fromStore = await app.secrets.get(session.tenant_id, "GITHUB_TOKEN");
    if (fromStore) return fromStore;
  } catch {
    // Secret store unavailable -- fall through to env fallback.
  }
  return process.env.GITHUB_TOKEN || undefined;
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
    // For remote-dispatch push to github over HTTPS the worker has no
    // git credential helper -- `git push https://github.com/...` then
    // hangs prompting for a username. Inject GITHUB_TOKEN into the
    // origin URL before push so HTTPS basic-auth carries the token.
    // Idempotent: only runs on remote+github+https; the cleanup at the
    // end restores the original URL so we don't leak the token into the
    // worker's git config.
    let originalOriginUrl: string | null = null;
    const githubToken = await resolveGithubToken(app, session);
    if (routing.remote && githubToken) {
      const probe = await readOriginUrl(app, session);
      if (probe && probe.startsWith("https://github.com/")) {
        originalOriginUrl = probe;
        const authedUrl = probe.replace("https://", `https://x-access-token:${githubToken}@`);
        try {
          await runGit(app, session, ["remote", "set-url", "origin", authedUrl], { timeout: 15_000 });
        } catch (err: any) {
          logWarn("session", `createWorktreePR: failed to set authed origin url: ${err?.message ?? err}`);
        }
      }
    }

    // 1. Push branch. For remote sessions this dispatches over arkd; for
    //    local it execs git directly.
    //
    // `ark-s-<sessionId>` branches are owned by exactly one session --
    // no concurrent writers ever exist. Agents routinely rewrite history
    // mid-flow (`git commit --amend`, rebase, lint-fix squash) and push
    // it themselves via Bash; if they then make further local commits
    // and our `git push` attempts to write the new local state, the
    // remote is ahead of our last fetched view and lease/non-fast-forward
    // fails.
    //
    // For session-owned branches we use plain `--force`: the branch is
    // exclusively ours, no other process or human writes it, and "what
    // we have locally at the end of the session" is by definition the
    // intended end-state for the branch. --force-with-lease was the
    // first try but it refuses when the remote ref is unknown locally
    // (which happens every time the agent self-pushes mid-flow without
    // our worktree fetching). Plain force is the right tool here.
    //
    // Non-session branches (a human-named branch the agent was told to
    // work on, e.g. via `--branch my-fix`) keep the safe default --
    // those CAN have concurrent writers.
    const isSessionOwnedBranch = branch === `ark-s-${sessionId}`;
    const pushArgs = isSessionOwnedBranch
      ? ["push", "-u", "--force", "origin", branch]
      : ["push", "-u", "origin", branch];
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
      // Strip the embedded token from the error text before surfacing.
      let reason = e?.stderr || e?.message || String(e);
      if (githubToken) reason = reason.replaceAll(githubToken, "***");
      return { ok: false, message: `git push failed: ${reason}` };
    } finally {
      // Always restore the original origin URL so the token doesn't
      // persist in the worker's git config. Best-effort: a failure
      // here doesn't fail the action.
      if (originalOriginUrl) {
        try {
          await runGit(app, session, ["remote", "set-url", "origin", originalOriginUrl], { timeout: 15_000 });
        } catch (err: any) {
          logWarn("session", `createWorktreePR: failed to restore origin url: ${err?.message ?? err}`);
        }
      }
    }

    // 2. Decide host. For remote we read origin from the remote workdir;
    //    for local we read it from the local worktree.
    const originUrl = await readOriginUrl(app, session, routing.remote ? undefined : localPushDir);
    const host = detectGitHost(originUrl);

    let prUrl: string | undefined;

    if (host === "github") {
      // REST-API path FIRST. Works on every dispatch (local + EC2 + k8s)
      // because it talks to api.github.com over HTTPS instead of shelling
      // `gh` on the worker. Auth is `GITHUB_TOKEN`; the worker doesn't
      // need `gh` installed and we don't depend on stdout parsing.
      const githubToken = await resolveGithubToken(app, session);
      const ownerRepo = parseGithubOwnerRepoFromUrl(originUrl);
      if (githubToken && ownerRepo) {
        const restDeps: GithubDeps = { token: githubToken };
        const result = await createPullRequest(
          { owner: ownerRepo.owner, repo: ownerRepo.repo, branch, base, title, body, draft: opts?.draft },
          restDeps,
        );
        if (result.ok && result.pr_url) {
          prUrl = result.pr_url;
          if (result.existed) {
            logInfo("session", `createWorktreePR: REST API found existing PR for ${sessionId}: ${prUrl}`);
          }
        } else {
          // REST API failed loudly. Don't degrade silently to a tree URL --
          // surface the error so the caller marks the action failed and
          // the operator can fix auth / scopes / branch protection.
          logWarn(
            "session",
            `createWorktreePR: REST createPullRequest failed for ${sessionId}: ${result.message ?? "(no message)"}`,
          );
          return {
            ok: false,
            message: `create_pr failed via GitHub REST API: ${result.message ?? "unknown error"}`,
          };
        }
      } else if (!routing.remote) {
        // GITHUB_TOKEN absent + local dispatch: try the legacy `gh` CLI
        // path. Surfaces the same null-URL issue but is the documented
        // fallback for environments without GITHUB_TOKEN configured.
        try {
          const ghArgs = buildGhPrCreateArgs({ head: branch, base, title, body, draft: opts?.draft });
          const { stdout } = await execFileAsync("gh", ghArgs, {
            encoding: "utf-8",
            timeout: 30_000,
            cwd: localPushDir,
          });
          prUrl = stdout.trim();
        } catch (e: any) {
          logWarn("session", `createWorktreePR: gh pr create failed for ${sessionId}, degrading: ${e?.message ?? e}`);
          prUrl = parseCreatePrUrl(pushStderr) ?? fallbackBranchUrl(host, originUrl, branch) ?? undefined;
        }
      } else {
        // Remote GitHub with no GITHUB_TOKEN: `gh` not installed, no REST
        // path. Push succeeded; surface the parsed/fallback URL but the
        // null-URL guard at the bottom of the function will refuse to
        // mark the action successful without a real PR URL.
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
    // No URL but push succeeded. For non-github hosts (bitbucket / gitlab /
    // unknown) this is a documented degraded path -- those hosts don't
    // expose a PR API the action can call from the conductor side, and
    // the operator opens the PR manually from the branch URL.
    //
    // For GitHub, no URL is a HARD FAILURE. The legacy behaviour of
    // returning `ok:true` with `pr_url:null` was the root cause of every
    // downstream `auto_merge` "Session has no PR URL" mystery -- the
    // session looked successful at the create_pr stage, then failed
    // inscrutably one stage later. Surface the failure here so the
    // session goes to `failed` with a clear pointer at the actual issue
    // (no GITHUB_TOKEN, no `gh` on the worker, branch had no commits,
    // token lacks `pull_requests: write`, etc.).
    void pushStdout;
    if (host === "github") {
      return {
        ok: false,
        message:
          `create_pr: branch ${branch} pushed to origin but no PR URL was returned. ` +
          `Common causes: GITHUB_TOKEN missing or insufficient scope (need pull_requests: write), ` +
          `branch has no commits ahead of ${base}, or the worker lacks 'gh' CLI on a remote dispatch. ` +
          `Resolve and re-run, or create the PR manually and set session.pr_url.`,
      };
    }
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

  // Refuse non-PR URLs. The pr stage's degraded path (push succeeded but no
  // PR was created -- e.g. remote-GitHub session with `gh` only on the
  // conductor and a parsing miss) used to fall back to a `/tree/<branch>`
  // URL; running `gh pr merge` against that returns "fatal: not a git
  // repository" because gh resolves the URL to a tree page, not a PR.
  // Validate up front and surface a clear error pointing the operator at
  // the actual fix (use the github connector / create the PR explicitly).
  if (!isGithubPrUrl(prUrl)) {
    return {
      ok: false,
      message:
        `Cannot auto-merge: session.pr_url is not a GitHub pull-request URL (got '${prUrl}'). ` +
        `The pr stage may have recorded a branch URL because the conductor couldn't reach the GitHub API ` +
        `to create the PR. Resolve by either creating the PR manually and updating session.pr_url, ` +
        `or by re-running the pr stage with the github connector mounted (see #436).`,
    };
  }

  const method = opts?.method ?? "squash";
  const deleteAfter = opts?.deleteAfter ?? true;

  // REST-API path FIRST. Same rationale as createWorktreePR: works on
  // every dispatch shape, doesn't depend on `gh` being installed or
  // authenticated on the worker, surfaces typed errors instead of stdout
  // soup. Falls back to the legacy `gh pr merge` only when no
  // GITHUB_TOKEN is available.
  const githubToken = await resolveGithubToken(app, session);
  if (githubToken) {
    const result = await mergePullRequest(
      { pr_url: prUrl, method, delete_branch: deleteAfter },
      { token: githubToken },
    );
    if (result.ok) {
      await app.events.log(sessionId, "pr_merged", {
        stage: session.stage ?? undefined,
        actor: "system",
        data: {
          pr_url: prUrl,
          method,
          delete_branch: deleteAfter,
          sha: result.sha,
          branch_deleted: result.branch_deleted,
        },
      });
      return { ok: true, message: `PR merged via REST API: ${prUrl}` };
    }
    return { ok: false, message: `PR merge failed: ${result.message ?? "unknown error"}` };
  }

  // Legacy gh CLI fallback when GITHUB_TOKEN is not set. Local-only:
  // remote dispatches without a token have no path that can succeed
  // (no `gh` on the worker, no REST creds in the conductor).
  try {
    const ghArgs = ["pr", "merge", prUrl, `--${method}`, "--auto"];
    if (deleteAfter) ghArgs.push("--delete-branch");
    // `gh pr merge <url>` derives the repo from the URL -- the cwd
    // doesn't need to be a git checkout. Prefer the local worktree if
    // it exists; otherwise fall back to the conductor's arkDir.
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
