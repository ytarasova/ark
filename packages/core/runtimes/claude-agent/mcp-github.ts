/**
 * In-process GitHub MCP server for the claude-agent runtime.
 *
 * Why in-process: the shipped `github` connector in
 * `packages/core/connectors/definitions/github.ts` mounts
 * `@modelcontextprotocol/server-github` via npx -- which requires node+npx on
 * the worker. Our EC2 base image doesn't ship those, so on the dispatch path
 * the connector fails to start and the agent never sees github tools.
 *
 * Instead, this module exposes a small set of GitHub tools implemented as a
 * direct REST-API client (the github connector still exists for tenants that
 * have a node-capable worker). The pattern mirrors `mcp-stage-control.ts` and
 * `mcp-ask-user.ts`: pure handler functions are exported for unit tests, and
 * `createGithubMcpServer` wraps them via `createSdkMcpServer` so the SDK can
 * mount them as `mcp__ark-github__<tool>`.
 *
 * Auth: a bearer token is required. In production the launcher reads
 * `process.env.GITHUB_TOKEN` (the same env var the connector's `auth.envVar`
 * points at). When the token is missing we still register the server -- but
 * every tool returns a clear "GITHUB_TOKEN not set" error so the agent can
 * surface the failure via `report(type:"error", ...)` and fail the stage
 * cleanly.
 *
 * The tools return `{ content: [{ type:"text", text }] }` shapes the SDK
 * expects. Successful responses include a JSON-encoded payload as the text
 * body so the agent can parse structured fields (pr_url, pr_number, etc.).
 */

import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const GITHUB_API = "https://api.github.com";

// ── Result shape ────────────────────────────────────────────────────────────

export interface GithubToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function ok(payload: unknown): GithubToolResult {
  return {
    content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }],
  };
}

function err(message: string): GithubToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

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
 * Returns null when the URL doesn't match any of those shapes (callers fall
 * back to explicit owner/repo args).
 */
export function parseGithubOwnerRepoFromUrl(url: string | null | undefined): OwnerRepo | null {
  if (!url) return null;
  const trimmed = url.trim();

  // SSH form: git@github.com:owner/repo(.git)
  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };

  // HTTPS form (with or without scheme).
  const https = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/);
  if (https) return { owner: https[1], repo: https[2] };

  return null;
}

/**
 * Parse the PR number out of a canonical github PR URL, e.g.
 *   https://github.com/owner/repo/pull/123
 *   https://github.com/owner/repo/pull/123/files
 *
 * Returns `{ owner, repo, number }` on match, null otherwise. Tree/branch URLs
 * and bare repo URLs return null so callers can refuse to operate on them.
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

// ── Shared HTTP helpers ─────────────────────────────────────────────────────

interface HttpDeps {
  token?: string;
  fetchFn: typeof fetch;
}

interface RequestArgs {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
}

async function ghFetch(deps: HttpDeps, args: RequestArgs): Promise<{ status: number; json: any }> {
  const { token, fetchFn } = deps;
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
    "User-Agent": "ark-github-mcp",
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

function describeAuthError(status: number, message: string | undefined): string {
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

// ── create_pr ───────────────────────────────────────────────────────────────

export interface CreatePrArgs {
  owner: string;
  repo: string;
  branch: string;
  base: string;
  title: string;
  body?: string;
  draft?: boolean;
}

export async function createPrHandler(args: CreatePrArgs, deps: HttpDeps): Promise<GithubToolResult> {
  if (!deps.token) return err("GITHUB_TOKEN not set; configure the github connector token before calling this tool.");
  if (!args.owner || !args.repo || !args.branch || !args.base || !args.title) {
    return err("create_pr requires owner, repo, branch, base, and title.");
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
    return ok({
      pr_url: res.json?.html_url,
      pr_number: res.json?.number,
      state: res.json?.state,
      draft: res.json?.draft ?? false,
    });
  }
  // 422 typically means a PR already exists for this head branch. Try to find
  // the existing PR so the agent can use it instead of failing the stage.
  if (res.status === 422) {
    const existing = await listPrsHandler(
      { owner: args.owner, repo: args.repo, head: `${args.owner}:${args.branch}`, state: "open" },
      deps,
    );
    if (!existing.isError) {
      return ok({
        pr_url: tryFindFirstPrUrl(existing),
        note: "PR already exists for this branch; returning existing one.",
        github_status: 422,
        github_message: res.json?.message,
      });
    }
  }
  return err(describeAuthError(res.status, res.json?.message));
}

function tryFindFirstPrUrl(result: GithubToolResult): string | undefined {
  try {
    const parsed = JSON.parse(result.content[0].text);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed[0].pr_url ?? parsed[0].html_url;
  } catch {
    /* ignore */
  }
  return undefined;
}

// ── merge_pr ────────────────────────────────────────────────────────────────

export interface MergePrArgs {
  pr_url: string;
  method?: "merge" | "squash" | "rebase";
  delete_branch?: boolean;
  commit_title?: string;
  commit_message?: string;
}

export async function mergePrHandler(args: MergePrArgs, deps: HttpDeps): Promise<GithubToolResult> {
  if (!deps.token) return err("GITHUB_TOKEN not set; configure the github connector token before calling this tool.");
  const parsed = parseGithubPrUrl(args.pr_url);
  if (!parsed) {
    return err(
      `merge_pr: '${args.pr_url}' is not a canonical github pull-request URL ` +
        `(expected https://github.com/<owner>/<repo>/pull/<N>). Refusing to operate on tree/branch URLs.`,
    );
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
      // Best-effort: fetch the PR for its head ref, then DELETE the branch.
      // A failure here doesn't fail the merge -- we just report it.
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
    return ok({
      merged: merge.json?.merged ?? true,
      sha: merge.json?.sha,
      method,
      branch_deleted: branchDeleted,
      message: merge.json?.message,
    });
  }

  // 405 = "not mergeable" (CI failing, conflicts, branch protection).
  // 409 = "head branch was modified" (race).
  if (merge.status === 405 || merge.status === 409) {
    return err(
      `GitHub refused merge (${merge.status}): ${merge.json?.message ?? "not mergeable"}. ` +
        `Consider waiting for CI or rebasing the branch.`,
    );
  }
  return err(describeAuthError(merge.status, merge.json?.message));
}

// ── get_pr_status ───────────────────────────────────────────────────────────

export interface GetPrStatusArgs {
  pr_url: string;
}

export async function getPrStatusHandler(args: GetPrStatusArgs, deps: HttpDeps): Promise<GithubToolResult> {
  if (!deps.token) return err("GITHUB_TOKEN not set; configure the github connector token before calling this tool.");
  const parsed = parseGithubPrUrl(args.pr_url);
  if (!parsed) {
    return err(
      `get_pr_status: '${args.pr_url}' is not a canonical github pull-request URL ` +
        `(expected https://github.com/<owner>/<repo>/pull/<N>).`,
    );
  }
  const prRes = await ghFetch(deps, {
    method: "GET",
    path: `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/pulls/${parsed.number}`,
  });
  if (prRes.status < 200 || prRes.status >= 300) {
    return err(describeAuthError(prRes.status, prRes.json?.message));
  }
  const pr = prRes.json;
  const sha = pr?.head?.sha as string | undefined;
  let checksPassing: boolean | null = null;
  let combinedState: string | null = null;
  if (sha) {
    const status = await ghFetch(deps, {
      method: "GET",
      path: `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/commits/${sha}/status`,
    });
    if (status.status >= 200 && status.status < 300) {
      combinedState = status.json?.state ?? null;
      checksPassing = combinedState === "success";
    }
  }
  return ok({
    state: pr?.state,
    merged: pr?.merged ?? false,
    mergeable: pr?.mergeable,
    mergeable_state: pr?.mergeable_state,
    head_sha: sha,
    combined_status: combinedState,
    checks_passing: checksPassing,
    pr_url: pr?.html_url,
    pr_number: pr?.number,
  });
}

// ── list_prs ────────────────────────────────────────────────────────────────

export interface ListPrsArgs {
  owner: string;
  repo: string;
  head?: string;
  state?: "open" | "closed" | "all";
}

export async function listPrsHandler(args: ListPrsArgs, deps: HttpDeps): Promise<GithubToolResult> {
  if (!deps.token) return err("GITHUB_TOKEN not set; configure the github connector token before calling this tool.");
  if (!args.owner || !args.repo) return err("list_prs requires owner and repo.");
  const res = await ghFetch(deps, {
    method: "GET",
    path: `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/pulls`,
    query: { head: args.head, state: args.state ?? "open" },
  });
  if (res.status < 200 || res.status >= 300) {
    return err(describeAuthError(res.status, res.json?.message));
  }
  const list = Array.isArray(res.json) ? res.json : [];
  return ok(
    list.map((pr: any) => ({
      pr_url: pr.html_url,
      pr_number: pr.number,
      title: pr.title,
      state: pr.state,
      head: pr.head?.ref,
      base: pr.base?.ref,
      draft: pr.draft ?? false,
    })),
  );
}

// ── Server factory ──────────────────────────────────────────────────────────

export interface GithubMcpOpts {
  /** Bearer token for the GitHub REST API. Typically `process.env.GITHUB_TOKEN`. */
  token?: string;
  /** Fetch implementation. Defaults to the global fetch; tests inject a stub. */
  fetchFn?: typeof fetch;
}

/**
 * Build the `ark-github` MCP server. Tools become available to the agent as
 * `mcp__ark-github__create_pr`, `mcp__ark-github__merge_pr`, etc.
 */
export function createGithubMcpServer(opts: GithubMcpOpts): McpSdkServerConfigWithInstance {
  const deps: HttpDeps = { token: opts.token, fetchFn: opts.fetchFn ?? fetch };

  const createPr = tool(
    "create_pr",
    "Create a GitHub pull request. Returns { pr_url, pr_number }. If a PR already exists for the branch, returns the existing one.",
    {
      owner: z.string().describe("Repository owner (user or org), e.g. 'ytarasova'."),
      repo: z.string().describe("Repository name, e.g. 'ark'."),
      branch: z.string().describe("Head branch (the branch you pushed)."),
      base: z.string().describe("Base branch to merge into, e.g. 'main'."),
      title: z.string().describe("PR title."),
      body: z.string().optional().describe("PR description in markdown."),
      draft: z.boolean().optional().describe("Create as draft. Defaults to false."),
    },
    (args): Promise<GithubToolResult> => createPrHandler(args, deps),
  );

  const mergePr = tool(
    "merge_pr",
    "Merge a GitHub pull request via PUT /pulls/{n}/merge. Returns { merged, sha }. Optionally deletes the head branch after merge.",
    {
      pr_url: z.string().describe("Canonical PR URL: https://github.com/<owner>/<repo>/pull/<N>."),
      method: z.enum(["merge", "squash", "rebase"]).optional().describe("Merge method. Defaults to 'squash'."),
      delete_branch: z.boolean().optional().describe("Delete the head branch after merge. Defaults to true."),
      commit_title: z.string().optional().describe("Optional commit title for the merge commit."),
      commit_message: z.string().optional().describe("Optional commit message for the merge commit."),
    },
    (args): Promise<GithubToolResult> => mergePrHandler(args, deps),
  );

  const getPrStatus = tool(
    "get_pr_status",
    "Fetch a PR plus its head-commit combined status. Returns { state, mergeable, checks_passing, merged }.",
    {
      pr_url: z.string().describe("Canonical PR URL."),
    },
    (args): Promise<GithubToolResult> => getPrStatusHandler(args, deps),
  );

  const listPrs = tool(
    "list_prs",
    "List PRs for a repo, optionally filtered by head branch and state. Useful for finding an existing PR before creating a new one.",
    {
      owner: z.string().describe("Repository owner."),
      repo: z.string().describe("Repository name."),
      head: z.string().optional().describe("Filter by head, e.g. 'owner:branch'."),
      state: z.enum(["open", "closed", "all"]).optional().describe("PR state. Defaults to 'open'."),
    },
    (args): Promise<GithubToolResult> => listPrsHandler(args, deps),
  );

  return createSdkMcpServer({
    name: "ark-github",
    version: "0.1.0",
    tools: [createPr, mergePr, getPrStatus, listPrs],
  });
}
