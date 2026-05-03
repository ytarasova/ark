/**
 * Unit tests for the in-process `ark-github` MCP server.
 *
 * The handlers are exported as pure functions so we can drive them with a
 * stub fetch implementation. The createGithubMcpServer() factory is also
 * smoke-tested for its SDK shape (mirrors mcp-ask-user.test.ts).
 */

import { test, expect, describe } from "bun:test";
import {
  createPrHandler,
  mergePrHandler,
  getPrStatusHandler,
  listPrsHandler,
  parseGithubOwnerRepoFromUrl,
  parseGithubPrUrl,
  createGithubMcpServer,
} from "../mcp-github.js";

interface CapturedCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string | undefined;
}

interface StubResponse {
  status: number;
  body: unknown;
}

function makeFakeFetch(calls: CapturedCall[], reply: (call: CapturedCall) => StubResponse): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders) {
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      } else if (Array.isArray(rawHeaders)) {
        for (const [k, v] of rawHeaders) {
          headers[k.toLowerCase()] = v;
        }
      } else {
        for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) {
          headers[k.toLowerCase()] = v;
        }
      }
    }
    const captured: CapturedCall = {
      url,
      method: init?.method,
      headers,
      body: typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : undefined,
    };
    calls.push(captured);
    const r = reply(captured);
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

// ── parseGithubOwnerRepoFromUrl ─────────────────────────────────────────────

describe("parseGithubOwnerRepoFromUrl", () => {
  test("parses ssh-style remotes", () => {
    expect(parseGithubOwnerRepoFromUrl("git@github.com:ytarasova/ark.git")).toEqual({
      owner: "ytarasova",
      repo: "ark",
    });
    expect(parseGithubOwnerRepoFromUrl("git@github.com:owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  test("parses https remotes with and without .git suffix", () => {
    expect(parseGithubOwnerRepoFromUrl("https://github.com/ytarasova/ark.git")).toEqual({
      owner: "ytarasova",
      repo: "ark",
    });
    expect(parseGithubOwnerRepoFromUrl("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  test("parses URLs with extra path segments", () => {
    expect(parseGithubOwnerRepoFromUrl("https://github.com/owner/repo/tree/main")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  test("returns null for unrelated hosts and falsy values", () => {
    expect(parseGithubOwnerRepoFromUrl("https://bitbucket.org/owner/repo.git")).toBeNull();
    expect(parseGithubOwnerRepoFromUrl("git@gitlab.com:owner/repo.git")).toBeNull();
    expect(parseGithubOwnerRepoFromUrl("")).toBeNull();
    expect(parseGithubOwnerRepoFromUrl(null)).toBeNull();
    expect(parseGithubOwnerRepoFromUrl(undefined)).toBeNull();
  });
});

// ── parseGithubPrUrl ────────────────────────────────────────────────────────

describe("parseGithubPrUrl", () => {
  test("extracts owner/repo/number from canonical PR URLs", () => {
    expect(parseGithubPrUrl("https://github.com/ytarasova/ark/pull/123")).toEqual({
      owner: "ytarasova",
      repo: "ark",
      number: 123,
    });
    expect(parseGithubPrUrl("https://github.com/owner/repo/pull/1/files")).toEqual({
      owner: "owner",
      repo: "repo",
      number: 1,
    });
  });

  test("returns null for tree / branch / non-pr URLs", () => {
    expect(parseGithubPrUrl("https://github.com/owner/repo/tree/main")).toBeNull();
    expect(parseGithubPrUrl("https://github.com/owner/repo")).toBeNull();
    expect(parseGithubPrUrl("https://github.com/owner/repo/pull/abc")).toBeNull();
    expect(parseGithubPrUrl(null)).toBeNull();
    expect(parseGithubPrUrl(undefined)).toBeNull();
    expect(parseGithubPrUrl("")).toBeNull();
  });
});

// ── createPrHandler ─────────────────────────────────────────────────────────

describe("createPrHandler", () => {
  test("POSTs to /pulls with the right body and returns pr_url + pr_number", async () => {
    const calls: CapturedCall[] = [];
    const fetchFn = makeFakeFetch(calls, () => ({
      status: 201,
      body: { html_url: "https://github.com/owner/repo/pull/42", number: 42, state: "open", draft: false },
    }));
    const result = await createPrHandler(
      {
        owner: "owner",
        repo: "repo",
        branch: "feat/x",
        base: "main",
        title: "Feat: x",
        body: "some body",
      },
      { token: "tok-abc", fetchFn },
    );
    expect(result.isError ?? false).toBe(false);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.pr_url).toBe("https://github.com/owner/repo/pull/42");
    expect(parsed.pr_number).toBe(42);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/owner/repo/pulls");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.authorization).toBe("Bearer tok-abc");
    expect(calls[0].headers.accept).toBe("application/vnd.github+json");
    const body = JSON.parse(calls[0].body!);
    expect(body).toEqual({
      title: "Feat: x",
      head: "feat/x",
      base: "main",
      body: "some body",
      draft: false,
    });
  });

  test("returns a clean GITHUB_TOKEN error when token is missing", async () => {
    const calls: CapturedCall[] = [];
    const result = await createPrHandler(
      { owner: "o", repo: "r", branch: "b", base: "main", title: "t" },
      { token: undefined, fetchFn: makeFakeFetch(calls, () => ({ status: 200, body: {} })) },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/GITHUB_TOKEN not set/);
    expect(calls).toHaveLength(0);
  });

  test("returns a 401-aware error when GitHub rejects the token", async () => {
    const fetchFn = makeFakeFetch([], () => ({ status: 401, body: { message: "Bad credentials" } }));
    const result = await createPrHandler(
      { owner: "o", repo: "r", branch: "b", base: "main", title: "t" },
      { token: "bad", fetchFn },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/401 unauthorized/);
    expect(result.content[0].text).toMatch(/Bad credentials/);
  });

  test("missing required fields short-circuits without an HTTP call", async () => {
    const calls: CapturedCall[] = [];
    const result = await createPrHandler(
      { owner: "o", repo: "r", branch: "", base: "main", title: "t" },
      { token: "tok", fetchFn: makeFakeFetch(calls, () => ({ status: 200, body: {} })) },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/owner, repo, branch, base, and title/);
    expect(calls).toHaveLength(0);
  });

  test("422 with an existing PR returns the existing pr_url", async () => {
    let callIdx = 0;
    const fetchFn = makeFakeFetch([], () => {
      const reply: StubResponse =
        callIdx === 0
          ? { status: 422, body: { message: "A pull request already exists for owner:feat/x" } }
          : { status: 200, body: [{ html_url: "https://github.com/owner/repo/pull/7", number: 7 }] };
      callIdx++;
      return reply;
    });
    const result = await createPrHandler(
      { owner: "owner", repo: "repo", branch: "feat/x", base: "main", title: "t" },
      { token: "tok", fetchFn },
    );
    expect(result.isError ?? false).toBe(false);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.pr_url).toBe("https://github.com/owner/repo/pull/7");
    expect(parsed.note).toMatch(/already exists/);
  });
});

// ── mergePrHandler ──────────────────────────────────────────────────────────

describe("mergePrHandler", () => {
  test("PUTs /pulls/<n>/merge and returns merged + sha + branch_deleted", async () => {
    const calls: CapturedCall[] = [];
    let idx = 0;
    const fetchFn = makeFakeFetch(calls, () => {
      idx++;
      if (idx === 1) {
        // PUT merge
        return { status: 200, body: { merged: true, sha: "abc123", message: "Pull Request successfully merged" } };
      }
      if (idx === 2) {
        // GET pr (to discover head ref)
        return { status: 200, body: { head: { ref: "feat/x" } } };
      }
      // DELETE branch
      return { status: 204, body: {} };
    });
    const result = await mergePrHandler(
      { pr_url: "https://github.com/owner/repo/pull/7", method: "squash", delete_branch: true },
      { token: "tok", fetchFn },
    );
    expect(result.isError ?? false).toBe(false);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.merged).toBe(true);
    expect(parsed.sha).toBe("abc123");
    expect(parsed.method).toBe("squash");
    expect(parsed.branch_deleted).toBe(true);

    expect(calls[0].url).toBe("https://api.github.com/repos/owner/repo/pulls/7/merge");
    expect(calls[0].method).toBe("PUT");
    expect(JSON.parse(calls[0].body!)).toEqual({ merge_method: "squash" });
    expect(calls[1].url).toBe("https://api.github.com/repos/owner/repo/pulls/7");
    expect(calls[2].url).toBe("https://api.github.com/repos/owner/repo/git/refs/heads/feat%2Fx");
    expect(calls[2].method).toBe("DELETE");
  });

  test("refuses non-PR URLs (tree URLs, branch URLs, etc.)", async () => {
    const calls: CapturedCall[] = [];
    const result = await mergePrHandler(
      { pr_url: "https://github.com/owner/repo/tree/feat%2Fx" },
      { token: "tok", fetchFn: makeFakeFetch(calls, () => ({ status: 200, body: {} })) },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not a canonical github pull-request URL/);
    expect(calls).toHaveLength(0);
  });

  test("returns GITHUB_TOKEN error when token is missing", async () => {
    const result = await mergePrHandler(
      { pr_url: "https://github.com/owner/repo/pull/1" },
      { token: undefined, fetchFn: makeFakeFetch([], () => ({ status: 200, body: {} })) },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/GITHUB_TOKEN not set/);
  });

  test("405 (not mergeable) surfaces a clear retryable error", async () => {
    const fetchFn = makeFakeFetch([], () => ({ status: 405, body: { message: "Pull Request is not mergeable" } }));
    const result = await mergePrHandler({ pr_url: "https://github.com/owner/repo/pull/1" }, { token: "tok", fetchFn });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/refused merge \(405\)/);
    expect(result.content[0].text).toMatch(/not mergeable/);
  });

  test("delete_branch:false skips the GET + DELETE roundtrips", async () => {
    const calls: CapturedCall[] = [];
    const fetchFn = makeFakeFetch(calls, () => ({ status: 200, body: { merged: true, sha: "deadbeef" } }));
    const result = await mergePrHandler(
      { pr_url: "https://github.com/owner/repo/pull/1", delete_branch: false },
      { token: "tok", fetchFn },
    );
    expect(result.isError ?? false).toBe(false);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.branch_deleted).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

// ── getPrStatusHandler ─────────────────────────────────────────────────────

describe("getPrStatusHandler", () => {
  test("merges PR data + combined status into one payload", async () => {
    let idx = 0;
    const fetchFn = makeFakeFetch([], () => {
      idx++;
      if (idx === 1) {
        return {
          status: 200,
          body: {
            state: "open",
            merged: false,
            mergeable: true,
            mergeable_state: "clean",
            head: { sha: "sha-1" },
            html_url: "https://github.com/owner/repo/pull/3",
            number: 3,
          },
        };
      }
      return { status: 200, body: { state: "success" } };
    });
    const result = await getPrStatusHandler(
      { pr_url: "https://github.com/owner/repo/pull/3" },
      { token: "tok", fetchFn },
    );
    expect(result.isError ?? false).toBe(false);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.state).toBe("open");
    expect(parsed.merged).toBe(false);
    expect(parsed.mergeable).toBe(true);
    expect(parsed.checks_passing).toBe(true);
    expect(parsed.combined_status).toBe("success");
    expect(parsed.head_sha).toBe("sha-1");
  });

  test("rejects non-PR URLs", async () => {
    const result = await getPrStatusHandler(
      { pr_url: "https://github.com/owner/repo" },
      { token: "tok", fetchFn: makeFakeFetch([], () => ({ status: 200, body: {} })) },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not a canonical github pull-request URL/);
  });
});

// ── listPrsHandler ─────────────────────────────────────────────────────────

describe("listPrsHandler", () => {
  test("returns a compact array of PR metadata", async () => {
    const calls: CapturedCall[] = [];
    const fetchFn = makeFakeFetch(calls, () => ({
      status: 200,
      body: [
        {
          html_url: "https://github.com/owner/repo/pull/9",
          number: 9,
          title: "wip",
          state: "open",
          head: { ref: "feat/x" },
          base: { ref: "main" },
          draft: true,
        },
      ],
    }));
    const result = await listPrsHandler(
      { owner: "owner", repo: "repo", head: "owner:feat/x", state: "open" },
      { token: "tok", fetchFn },
    );
    expect(result.isError ?? false).toBe(false);
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].pr_url).toBe("https://github.com/owner/repo/pull/9");
    expect(parsed[0].pr_number).toBe(9);
    expect(parsed[0].draft).toBe(true);

    // Query string should include head + state filters.
    expect(calls[0].url).toContain("head=owner%3Afeat%2Fx");
    expect(calls[0].url).toContain("state=open");
  });

  test("requires owner and repo", async () => {
    const result = await listPrsHandler(
      { owner: "", repo: "" },
      { token: "tok", fetchFn: makeFakeFetch([], () => ({ status: 200, body: [] })) },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/owner and repo/);
  });
});

// ── createGithubMcpServer factory ───────────────────────────────────────────

describe("createGithubMcpServer", () => {
  test("returns an SDK-compatible config with the expected name", () => {
    const server = createGithubMcpServer({ token: "tok" });
    const cfg = server as unknown as { type?: string; name?: string; instance?: unknown };
    expect(cfg.type).toBe("sdk");
    expect(cfg.name).toBe("ark-github");
    expect(cfg.instance).toBeDefined();
  });
});
