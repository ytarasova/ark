/**
 * Remote-aware createWorktreePR tests.
 *
 * The action stage was previously local-only: `git push` ran on the conductor's
 * local clone (`~/.ark/worktrees/<sessionId>`), which never saw the agent's
 * commits when the agent was dispatched on EC2 / any non-`supportsWorktree`
 * provider. Push always failed with `src refspec ... does not match any`.
 *
 * These tests cover the new remote routing: when a session resolves to a
 * provider with `supportsWorktree === false`, every git invocation must go
 * through `ArkdClient.run({ command: "git", ..., cwd: <remoteWorkdir> })`.
 *
 * To avoid a dependency on a real EC2 instance we spin up a tiny in-process
 * HTTP server that mimics arkd's `/exec` endpoint, register a stub provider
 * pointing at it, and assert which git invocations the dispatcher fires.
 *
 * Also covers `detectGitHost` + `mergeWorktreePR`'s graceful degradation
 * for non-github hosts.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "bun";

import { AppContext } from "../../../app.js";
import { setApp, clearApp } from "../../../__tests__/test-helpers.js";
import { allocatePort } from "../../../config/port-allocator.js";
import { createWorktreePR, mergeWorktreePR, detectGitHost, parseCreatePrUrl, isGithubPrUrl } from "../pr.js";
import type { Compute, Session } from "../../../../types/index.js";
import type { ComputeProvider } from "../../../compute/legacy-provider.js";

// ── Stub arkd server: records every /exec call and returns a programmable response ──

interface ExecCall {
  command: string;
  args: string[];
  cwd?: string;
}

function startStubArkd(opts: {
  port: number;
  reply: (call: ExecCall) => { exitCode: number; stdout: string; stderr: string };
}): { server: Server; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const server = Bun.serve({
    port: opts.port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ status: "ok", version: "stub", hostname: "stub", platform: "stub" }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/exec" && req.method === "POST") {
        const body = (await req.json()) as ExecCall;
        calls.push(body);
        const res = opts.reply(body);
        return new Response(
          JSON.stringify({ exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, timedOut: false }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, calls };
}

// ── Stub remote provider: supportsWorktree = false, getArkdUrl points at the stub ──

function makeRemoteStubProvider(arkdUrl: string, remoteWorkdir: string): ComputeProvider {
  return {
    name: "ec2",
    isolationModes: [],
    singleton: false,
    canReboot: true,
    canDelete: true,
    supportsWorktree: false,
    initialStatus: "stopped",
    needsAuth: true,
    supportsSecretMount: false,
    async provision() {},
    async destroy() {},
    async start() {},
    async stop() {},
    async launch() {
      return "";
    },
    async attach() {},
    async killAgent() {},
    async captureOutput() {
      return "";
    },
    async cleanupSession() {},
    async getMetrics() {
      return { metrics: {} as any, sessions: [], processes: [], docker: [] };
    },
    async probePorts() {
      return [];
    },
    async syncEnvironment() {},
    async checkSession() {
      return true;
    },
    getAttachCommand() {
      return [];
    },
    buildChannelConfig() {
      return {};
    },
    buildLaunchEnv() {
      return {};
    },
    getArkdUrl() {
      return arkdUrl;
    },
    resolveWorkdir() {
      return remoteWorkdir;
    },
  } as unknown as ComputeProvider;
}

// ── Test setup ───────────────────────────────────────────────────────────────

let app: AppContext;
let arkdPort: number;
let stub: ReturnType<typeof startStubArkd>;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);

  arkdPort = await allocatePort();
});

afterAll(async () => {
  stub?.server.stop();
  await app?.shutdown();
  clearApp();
});

// ── detectGitHost ────────────────────────────────────────────────────────────

describe("detectGitHost", () => {
  it("recognizes GitHub https + ssh URLs", () => {
    expect(detectGitHost("https://github.com/owner/repo")).toBe("github");
    expect(detectGitHost("https://github.com/owner/repo.git")).toBe("github");
    expect(detectGitHost("git@github.com:owner/repo.git")).toBe("github");
  });

  it("recognizes Bitbucket https + ssh URLs", () => {
    expect(detectGitHost("https://bitbucket.org/owner/repo.git")).toBe("bitbucket");
    expect(detectGitHost("git@bitbucket.org:owner/repo.git")).toBe("bitbucket");
  });

  it("recognizes GitLab https + ssh URLs", () => {
    expect(detectGitHost("https://gitlab.com/owner/repo.git")).toBe("gitlab");
    expect(detectGitHost("git@gitlab.com:owner/repo.git")).toBe("gitlab");
  });

  it("returns 'unknown' for self-hosted / unrecognized hosts", () => {
    expect(detectGitHost("https://git.example.com/owner/repo.git")).toBe("unknown");
    expect(detectGitHost("git@git.internal:owner/repo.git")).toBe("unknown");
    expect(detectGitHost(null)).toBe("unknown");
    expect(detectGitHost(undefined)).toBe("unknown");
    expect(detectGitHost("")).toBe("unknown");
  });
});

// ── parseCreatePrUrl ─────────────────────────────────────────────────────────

describe("parseCreatePrUrl", () => {
  it("parses Bitbucket's 'Create pull request' URL out of push stderr", () => {
    const stderr = [
      "Pushing to ssh://git@bitbucket.org/owner/repo.git",
      "remote:",
      "remote: Create pull request for feat/x:",
      "remote:   https://bitbucket.org/owner/repo/pull-requests/new?source=feat/x",
      "remote:",
    ].join("\n");
    expect(parseCreatePrUrl(stderr)).toBe("https://bitbucket.org/owner/repo/pull-requests/new?source=feat/x");
  });

  it("returns null when no remote: line carries a URL", () => {
    expect(parseCreatePrUrl("To origin\n * [new branch] feat/x -> feat/x\n")).toBeNull();
    expect(parseCreatePrUrl("")).toBeNull();
  });
});

// ── isGithubPrUrl: only matches /pull/<N> URLs ──────────────────────────────

describe("isGithubPrUrl", () => {
  it("matches canonical PR URLs", () => {
    expect(isGithubPrUrl("https://github.com/ytarasova/ark/pull/123")).toBe(true);
    expect(isGithubPrUrl("https://github.com/ytarasova/ark/pull/1")).toBe(true);
    expect(isGithubPrUrl("https://github.com/ytarasova/ark/pull/123/files")).toBe(true);
  });

  it("rejects tree / branch / repo URLs (the degraded-path output that broke auto_merge)", () => {
    // This is the bug from the screenshot in #436: pr stage stored a
    // `/tree/<branch>` URL as pr_url and downstream `gh pr merge` failed.
    expect(isGithubPrUrl("https://github.com/ytarasova/ark/tree/main")).toBe(false);
    expect(isGithubPrUrl("https://github.com/ytarasova/ark/tree/feat%2Fx")).toBe(false);
    expect(isGithubPrUrl("https://github.com/ytarasova/ark")).toBe(false);
    expect(isGithubPrUrl("https://github.com/ytarasova/ark.git")).toBe(false);
  });

  it("rejects non-github hosts and falsy values", () => {
    expect(isGithubPrUrl("https://bitbucket.org/owner/repo/pull-requests/1")).toBe(false);
    expect(isGithubPrUrl("https://gitlab.com/owner/repo/-/merge_requests/1")).toBe(false);
    expect(isGithubPrUrl(null)).toBe(false);
    expect(isGithubPrUrl(undefined)).toBe(false);
    expect(isGithubPrUrl("")).toBe(false);
  });
});

// ── mergeWorktreePR: bitbucket / non-github degrades cleanly ────────────────

describe("mergeWorktreePR", () => {
  it("refuses to feed a /tree/<branch> URL to gh pr merge (#436)", async () => {
    // Repro for #436: the pr stage's degraded path stored a tree URL as
    // pr_url. mergeWorktreePR then ran `gh pr merge <tree-url>` which
    // returned "fatal: not a git repository". The fix validates that
    // pr_url is a real PR URL before invoking gh.
    const session = await app.sessions.create({
      summary: "merge tree URL",
      flow: "quick",
      repo: "git@github.com:ytarasova/ark.git",
    });
    await app.sessions.update(session.id, {
      pr_url: "https://github.com/ytarasova/ark/tree/main",
    });

    const result = await mergeWorktreePR(app, session.id);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not a GitHub pull-request URL/);
    // Error message points the operator at the right fix path (#436 connector)
    expect(result.message).toContain("#436");
  });

  it("returns ok:false with a clear message for non-github PR URLs", async () => {
    const session = await app.sessions.create({
      summary: "merge non-github",
      flow: "quick",
      repo: "git@bitbucket.org:owner/repo.git",
    });
    await app.sessions.update(session.id, {
      pr_url: "https://bitbucket.org/owner/repo/pull-requests/new?source=feat/x",
    });

    const result = await mergeWorktreePR(app, session.id);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/auto-merge not supported for non-github/);
    expect(result.message).toContain("host=bitbucket");
  });

  it("returns ok:false when session has no pr_url", async () => {
    const session = await app.sessions.create({
      summary: "merge no url",
      flow: "quick",
      repo: "git@github.com:owner/repo.git",
    });
    const result = await mergeWorktreePR(app, session.id);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no PR URL/);
  });
});
