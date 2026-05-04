/**
 * GitHub REST API helpers for the deterministic action layer.
 *
 * Why these exist: the legacy `create_pr` / `auto_merge` actions shelled
 * out to `gh pr create` / `gh pr merge` on the worker. That has two
 * failure modes:
 *
 *   1. The worker may not have `gh` installed (EC2 base image doesn't),
 *      and even when it does, auth propagation across the SSM tunnel is
 *      fragile. `gh pr create` succeeds-ish on auth failure, returning
 *      no PR URL on stdout, which the action used to wrap as
 *      `{ok:true, pr_url:null}` and let `auto_merge` choke on later.
 *
 *   2. Subprocess error contracts are fuzzy. Checking exit codes alone
 *      misses cases where `gh` prints a warning to stderr and exits 0
 *      without doing what was asked.
 *
 * This module talks to the GitHub REST API directly via fetch using
 * `GITHUB_TOKEN`. Status codes are typed; failures surface the upstream
 * error message verbatim. No `gh` dependency, no stdout parsing.
 *
 * Originally extracted from a closed PR (#439) that wired this layer
 * into an LLM-driven `pr-handler` agent. PR-creation and merge are
 * deterministic mechanical operations -- using an agent is overkill and
 * non-deterministic. Keep the REST helpers; drop the agent stage.
 */

const GITHUB_API = "https://api.github.com";

// ── URL parsing ─────────────────────────────────────────────────────────────

export interface OwnerRepo {
  owner: string;
  repo: string;
}

/**
 * Parse `owner` + `repo` from a git remote URL or web URL. Handles:
 *   - https://github.com/owner/repo
 *   - https://github.com/owner/repo.git
 *   - git@github.com:owner/repo.git
 *   - github.com/owner/repo
 *
 * Returns null when the URL doesn't match any of those shapes.
 */
export function parseGithubOwnerRepoFromUrl(url: string | null | undefined): OwnerRepo | null {
  if (!url) return null;
  const trimmed = url.trim();

  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };

  const https = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/);
  if (https) return { owner: https[1], repo: https[2] };

  return null;
}

/**
 * Recognize canonical GitHub PR URLs:
 *   - https://github.com/owner/repo/pull/123
 *   - https://github.com/owner/repo/pull/123/files
 *
 * Tree/branch URLs and bare repo URLs return null so callers can refuse
 * to operate on them.
 */
export function parseGithubPrUrl(
  url: string | null | undefined,
): { owner: string; repo: string; number: number } | null {
  if (!url) return null;
  const m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/);
  if (!m) return null;
  const number = Number(m[3]);
  if (!Number.isFinite(number) || number <= 0) return null;
  return { owner: m[1], repo: m[2], number };
}

// ── HTTP transport ──────────────────────────────────────────────────────────

export interface GithubDeps {
  /** Bearer token. Required for every call -- handlers refuse to operate without it. */
  token?: string;
  /** Fetch implementation. Defaults to global fetch; tests inject a stub. */
  fetchFn?: typeof fetch;
}

interface RequestArgs {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
}

async function ghFetch(deps: GithubDeps, args: RequestArgs): Promise<{ status: number; json: any }> {
  const { token } = deps;
  const fetchFn = deps.fetchFn ?? fetch;
  if (!token) {
    return { status: 401, json: { message: "GITHUB_TOKEN not set" } };
  }
  const qs = args.query
    ? "?" +
      Object.entries(args.query)
        .filter(([, v]) => v !== undefined && v !== "")
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&")
    : "";
  const url = `${GITHUB_API}${args.path}${qs}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ark",
  };
  if (args.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetchFn(url, {
    method: args.method,
    headers,
    body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
  });
  let parsed: any = null;
  const text = await res.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  return { status: res.status, json: parsed };
}

function describeStatusError(status: number, message: string | undefined): string {
  if (status === 401) {
    return `GitHub 401 unauthorized -- check that GITHUB_TOKEN is valid and has the required scopes (repo, workflow): ${message ?? ""}`.trim();
  }
  if (status === 403) {
    return `GitHub 403 forbidden -- token may lack scopes or hit a rate limit: ${message ?? ""}`.trim();
  }
  if (status === 404) {
    return `GitHub 404 not found -- check owner/repo and that the token can see this repository: ${message ?? ""}`.trim();
  }
  return `GitHub API ${status}: ${message ?? "(no message)"}`;
}

// ── createPullRequest ───────────────────────────────────────────────────────

export interface CreatePullRequestArgs {
  owner: string;
  repo: string;
  branch: string;
  base: string;
  title: string;
  body?: string;
  draft?: boolean;
}

export interface CreatePullRequestResult {
  ok: boolean;
  pr_url?: string;
  pr_number?: number;
  /** Set when the PR already existed for this head branch. */
  existed?: boolean;
  message?: string;
}

/**
 * Create a PR via `POST /repos/:owner/:repo/pulls`. Returns `{ok:true,
 * pr_url}` on 2xx. On 422 ("PR already exists for this head") looks up
 * the existing PR and returns it instead -- this is the idempotency
 * case the legacy gh-cli path also handled.
 */
export async function createPullRequest(
  args: CreatePullRequestArgs,
  deps: GithubDeps,
): Promise<CreatePullRequestResult> {
  if (!deps.token) {
    return { ok: false, message: "GITHUB_TOKEN not set; cannot create pull request via REST API" };
  }
  if (!args.owner || !args.repo || !args.branch || !args.base || !args.title) {
    return { ok: false, message: "createPullRequest requires owner, repo, branch, base, and title." };
  }
  const res = await ghFetch(deps, {
    method: "POST",
    path: `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/pulls`,
    body: {
      title: args.title,
      head: args.branch,
      base: args.base,
      body: args.body ?? "",
      draft: args.draft ?? false,
    },
  });
  if (res.status >= 200 && res.status < 300) {
    return {
      ok: true,
      pr_url: res.json?.html_url,
      pr_number: res.json?.number,
    };
  }
  // 422 typically means a PR already exists for this head branch.
  if (res.status === 422) {
    const existing = await listPullRequests(
      { owner: args.owner, repo: args.repo, head: `${args.owner}:${args.branch}`, state: "open" },
      deps,
    );
    if (existing.ok && existing.prs.length > 0) {
      return {
        ok: true,
        pr_url: existing.prs[0].pr_url,
        pr_number: existing.prs[0].pr_number,
        existed: true,
        message: `PR already exists for ${args.branch}`,
      };
    }
  }
  return { ok: false, message: describeStatusError(res.status, res.json?.message) };
}

// ── mergePullRequest ────────────────────────────────────────────────────────

export interface MergePullRequestArgs {
  pr_url: string;
  method?: "merge" | "squash" | "rebase";
  delete_branch?: boolean;
  commit_title?: string;
  commit_message?: string;
}

export interface MergePullRequestResult {
  ok: boolean;
  merged?: boolean;
  sha?: string;
  branch_deleted?: boolean;
  message?: string;
}

/**
 * Merge a PR via `PUT /repos/:owner/:repo/pulls/:number/merge`. Then
 * (optionally) deletes the head branch via `DELETE /git/refs/heads/:ref`.
 *
 * Refuses non-canonical PR URLs (tree/branch URLs) so the caller has to
 * resolve a real `/pull/<N>` URL first. 405 = "not mergeable" (CI failing,
 * conflicts, branch protection). 409 = "head ref modified" (race).
 */
export async function mergePullRequest(args: MergePullRequestArgs, deps: GithubDeps): Promise<MergePullRequestResult> {
  if (!deps.token) {
    return { ok: false, message: "GITHUB_TOKEN not set; cannot merge pull request via REST API" };
  }
  const parsed = parseGithubPrUrl(args.pr_url);
  if (!parsed) {
    return {
      ok: false,
      message:
        `mergePullRequest: '${args.pr_url}' is not a canonical github pull-request URL ` +
        `(expected https://github.com/<owner>/<repo>/pull/<N>). Refusing to operate on tree/branch URLs.`,
    };
  }
  const method = args.method ?? "squash";
  const merge = await ghFetch(deps, {
    method: "PUT",
    path: `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/pulls/${parsed.number}/merge`,
    body: {
      merge_method: method,
      ...(args.commit_title ? { commit_title: args.commit_title } : {}),
      ...(args.commit_message ? { commit_message: args.commit_message } : {}),
    },
  });

  if (merge.status >= 200 && merge.status < 300) {
    let branchDeleted = false;
    if (args.delete_branch !== false) {
      const prRes = await ghFetch(deps, {
        method: "GET",
        path: `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/pulls/${parsed.number}`,
      });
      const headRef = prRes.json?.head?.ref as string | undefined;
      if (headRef) {
        const del = await ghFetch(deps, {
          method: "DELETE",
          path: `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/git/refs/heads/${encodeURIComponent(headRef)}`,
        });
        branchDeleted = del.status >= 200 && del.status < 300;
      }
    }
    return {
      ok: true,
      merged: merge.json?.merged ?? true,
      sha: merge.json?.sha,
      branch_deleted: branchDeleted,
      message: merge.json?.message,
    };
  }

  if (merge.status === 405 || merge.status === 409) {
    return {
      ok: false,
      message:
        `GitHub refused merge (${merge.status}): ${merge.json?.message ?? "not mergeable"}. ` +
        `Consider waiting for CI or rebasing the branch.`,
    };
  }
  return { ok: false, message: describeStatusError(merge.status, merge.json?.message) };
}

// ── listPullRequests (used as the 422 fallback in createPullRequest) ────────

export interface ListPullRequestsArgs {
  owner: string;
  repo: string;
  head?: string;
  state?: "open" | "closed" | "all";
}

export interface ListedPr {
  pr_url: string;
  pr_number: number;
  title: string;
  state: string;
  head: string;
  base: string;
  draft: boolean;
}

export interface ListPullRequestsResult {
  ok: boolean;
  prs: ListedPr[];
  message?: string;
}

export async function listPullRequests(args: ListPullRequestsArgs, deps: GithubDeps): Promise<ListPullRequestsResult> {
  if (!deps.token) return { ok: false, prs: [], message: "GITHUB_TOKEN not set" };
  if (!args.owner || !args.repo) return { ok: false, prs: [], message: "listPullRequests requires owner and repo." };
  const res = await ghFetch(deps, {
    method: "GET",
    path: `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/pulls`,
    query: { head: args.head, state: args.state ?? "open" },
  });
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, prs: [], message: describeStatusError(res.status, res.json?.message) };
  }
  const list = Array.isArray(res.json) ? res.json : [];
  return {
    ok: true,
    prs: list.map((pr: any) => ({
      pr_url: pr.html_url,
      pr_number: pr.number,
      title: pr.title,
      state: pr.state,
      head: pr.head?.ref,
      base: pr.base?.ref,
      draft: pr.draft ?? false,
    })),
  };
}
