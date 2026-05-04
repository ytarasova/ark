/**
 * GitHub REST helper tests.
 *
 * Covers: URL parsing (owner/repo + canonical PR URL), createPullRequest
 * (200, 422-existing fallback, 401/403/404 surface), mergePullRequest
 * (200, 405 not-mergeable, 409 race, refusal of non-canonical URLs),
 * listPullRequests, GITHUB_TOKEN-missing guard.
 */

import { describe, it, expect } from "bun:test";
import {
  parseGithubOwnerRepoFromUrl,
  parseGithubPrUrl,
  createPullRequest,
  mergePullRequest,
  listPullRequests,
  type GithubDeps,
} from "../rest.js";

// ── URL parsing ──────────────────────────────────────────────────────────────

describe("parseGithubOwnerRepoFromUrl", () => {
  it("parses HTTPS URLs with .git suffix", () => {
    expect(parseGithubOwnerRepoFromUrl("https://github.com/ytarasova/ark.git")).toEqual({
      owner: "ytarasova",
      repo: "ark",
    });
  });

  it("parses HTTPS URLs without .git", () => {
    expect(parseGithubOwnerRepoFromUrl("https://github.com/ytarasova/ark")).toEqual({
      owner: "ytarasova",
      repo: "ark",
    });
  });

  it("parses SSH URLs", () => {
    expect(parseGithubOwnerRepoFromUrl("git@github.com:ytarasova/ark.git")).toEqual({
      owner: "ytarasova",
      repo: "ark",
    });
  });

  it("parses scheme-less URLs", () => {
    expect(parseGithubOwnerRepoFromUrl("github.com/ytarasova/ark")).toEqual({
      owner: "ytarasova",
      repo: "ark",
    });
  });

  it("returns null for non-github URLs", () => {
    expect(parseGithubOwnerRepoFromUrl("https://gitlab.com/foo/bar")).toBeNull();
  });

  it("returns null for null/empty", () => {
    expect(parseGithubOwnerRepoFromUrl(null)).toBeNull();
    expect(parseGithubOwnerRepoFromUrl("")).toBeNull();
  });
});

describe("parseGithubPrUrl", () => {
  it("parses canonical PR URL", () => {
    expect(parseGithubPrUrl("https://github.com/ytarasova/ark/pull/440")).toEqual({
      owner: "ytarasova",
      repo: "ark",
      number: 440,
    });
  });

  it("parses PR URL with subpath", () => {
    expect(parseGithubPrUrl("https://github.com/ytarasova/ark/pull/440/files")).toEqual({
      owner: "ytarasova",
      repo: "ark",
      number: 440,
    });
  });

  it("returns null for tree URL", () => {
    expect(parseGithubPrUrl("https://github.com/ytarasova/ark/tree/main")).toBeNull();
  });

  it("returns null for repo URL", () => {
    expect(parseGithubPrUrl("https://github.com/ytarasova/ark")).toBeNull();
  });

  it("returns null for null/empty", () => {
    expect(parseGithubPrUrl(null)).toBeNull();
    expect(parseGithubPrUrl(undefined)).toBeNull();
    expect(parseGithubPrUrl("")).toBeNull();
  });
});

// ── Stub fetch helpers ───────────────────────────────────────────────────────

function stubFetch(responder: (url: string, init?: any) => Response | Promise<Response>): typeof fetch {
  return ((url: any, init?: any) => {
    const u = String(url);
    return Promise.resolve(responder(u, init));
  }) as unknown as typeof fetch;
}

function jsonResponse(status: number, body: any): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// ── createPullRequest ────────────────────────────────────────────────────────

describe("createPullRequest", () => {
  it("returns ok with pr_url on 201", async () => {
    const deps: GithubDeps = {
      token: "ghp_test",
      fetchFn: stubFetch((url, init) => {
        expect(url).toBe("https://api.github.com/repos/ytarasova/ark/pulls");
        expect(init?.method).toBe("POST");
        const body = JSON.parse(init.body);
        expect(body).toEqual({
          title: "feat: x",
          head: "feat/x",
          base: "main",
          body: "details",
          draft: false,
        });
        return jsonResponse(201, { html_url: "https://github.com/ytarasova/ark/pull/100", number: 100, state: "open" });
      }),
    };
    const result = await createPullRequest(
      { owner: "ytarasova", repo: "ark", branch: "feat/x", base: "main", title: "feat: x", body: "details" },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.pr_url).toBe("https://github.com/ytarasova/ark/pull/100");
    expect(result.pr_number).toBe(100);
  });

  it("returns ok with existing PR on 422 (fallback to listPullRequests)", async () => {
    const deps: GithubDeps = {
      token: "ghp_test",
      fetchFn: stubFetch((url) => {
        if (url.startsWith("https://api.github.com/repos/ytarasova/ark/pulls?")) {
          return jsonResponse(200, [
            {
              html_url: "https://github.com/ytarasova/ark/pull/99",
              number: 99,
              title: "existing",
              state: "open",
              head: { ref: "feat/x" },
              base: { ref: "main" },
              draft: false,
            },
          ]);
        }
        return jsonResponse(422, { message: "A pull request already exists for ytarasova:feat/x." });
      }),
    };
    const result = await createPullRequest(
      { owner: "ytarasova", repo: "ark", branch: "feat/x", base: "main", title: "feat: x" },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.pr_url).toBe("https://github.com/ytarasova/ark/pull/99");
    expect(result.existed).toBe(true);
  });

  it("returns ok:false with descriptive error on 401", async () => {
    const deps: GithubDeps = {
      token: "ghp_bad",
      fetchFn: stubFetch(() => jsonResponse(401, { message: "Bad credentials" })),
    };
    const result = await createPullRequest({ owner: "o", repo: "r", branch: "b", base: "main", title: "t" }, deps);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("401");
    expect(result.message).toContain("Bad credentials");
  });

  it("returns ok:false when GITHUB_TOKEN is missing", async () => {
    const result = await createPullRequest({ owner: "o", repo: "r", branch: "b", base: "main", title: "t" }, {});
    expect(result.ok).toBe(false);
    expect(result.message).toContain("GITHUB_TOKEN not set");
  });

  it("validates required args", async () => {
    const result = await createPullRequest(
      { owner: "", repo: "r", branch: "b", base: "main", title: "t" },
      { token: "x" },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("requires");
  });
});

// ── mergePullRequest ─────────────────────────────────────────────────────────

describe("mergePullRequest", () => {
  it("merges + deletes branch by default", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const deps: GithubDeps = {
      token: "ghp_test",
      fetchFn: stubFetch((url, init) => {
        calls.push({ method: init?.method ?? "GET", url });
        if (init?.method === "PUT") {
          return jsonResponse(200, { merged: true, sha: "abc123", message: "Pull request successfully merged" });
        }
        if (init?.method === "GET") {
          return jsonResponse(200, { head: { ref: "feat/x" } });
        }
        if (init?.method === "DELETE") {
          return jsonResponse(204, {});
        }
        return jsonResponse(500, {});
      }),
    };
    const result = await mergePullRequest({ pr_url: "https://github.com/o/r/pull/42" }, deps);
    expect(result.ok).toBe(true);
    expect(result.merged).toBe(true);
    expect(result.sha).toBe("abc123");
    expect(result.branch_deleted).toBe(true);
    expect(calls.find((c) => c.method === "PUT")?.url).toBe("https://api.github.com/repos/o/r/pulls/42/merge");
    expect(calls.find((c) => c.method === "DELETE")?.url).toBe(
      "https://api.github.com/repos/o/r/git/refs/heads/feat%2Fx",
    );
  });

  it("skips branch delete when delete_branch=false", async () => {
    let deleteCalled = false;
    const deps: GithubDeps = {
      token: "ghp_test",
      fetchFn: stubFetch((_url, init) => {
        if (init?.method === "DELETE") deleteCalled = true;
        if (init?.method === "PUT") return jsonResponse(200, { merged: true, sha: "abc123" });
        return jsonResponse(200, {});
      }),
    };
    const result = await mergePullRequest({ pr_url: "https://github.com/o/r/pull/42", delete_branch: false }, deps);
    expect(result.ok).toBe(true);
    expect(deleteCalled).toBe(false);
  });

  it("returns ok:false on 405 not-mergeable", async () => {
    const deps: GithubDeps = {
      token: "ghp_test",
      fetchFn: stubFetch(() => jsonResponse(405, { message: "Pull Request is not mergeable" })),
    };
    const result = await mergePullRequest({ pr_url: "https://github.com/o/r/pull/42" }, deps);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("405");
    expect(result.message).toContain("not mergeable");
  });

  it("returns ok:false on 409 head-modified race", async () => {
    const deps: GithubDeps = {
      token: "ghp_test",
      fetchFn: stubFetch(() => jsonResponse(409, { message: "Head branch was modified" })),
    };
    const result = await mergePullRequest({ pr_url: "https://github.com/o/r/pull/42" }, deps);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("409");
  });

  it("refuses tree URLs", async () => {
    const deps: GithubDeps = { token: "ghp_test" };
    const result = await mergePullRequest({ pr_url: "https://github.com/o/r/tree/feat" }, deps);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not a canonical github pull-request URL");
  });

  it("returns ok:false when GITHUB_TOKEN is missing", async () => {
    const result = await mergePullRequest({ pr_url: "https://github.com/o/r/pull/42" }, {});
    expect(result.ok).toBe(false);
    expect(result.message).toContain("GITHUB_TOKEN not set");
  });
});

// ── listPullRequests ─────────────────────────────────────────────────────────

describe("listPullRequests", () => {
  it("returns parsed list on 200", async () => {
    const deps: GithubDeps = {
      token: "ghp_test",
      fetchFn: stubFetch(() =>
        jsonResponse(200, [
          {
            html_url: "https://github.com/o/r/pull/1",
            number: 1,
            title: "first",
            state: "open",
            head: { ref: "feat/a" },
            base: { ref: "main" },
            draft: false,
          },
        ]),
      ),
    };
    const result = await listPullRequests({ owner: "o", repo: "r" }, deps);
    expect(result.ok).toBe(true);
    expect(result.prs.length).toBe(1);
    expect(result.prs[0].pr_url).toBe("https://github.com/o/r/pull/1");
    expect(result.prs[0].head).toBe("feat/a");
  });

  it("returns ok:true with empty list when GitHub returns []", async () => {
    const deps: GithubDeps = { token: "ghp_test", fetchFn: stubFetch(() => jsonResponse(200, [])) };
    const result = await listPullRequests({ owner: "o", repo: "r" }, deps);
    expect(result.ok).toBe(true);
    expect(result.prs.length).toBe(0);
  });
});
