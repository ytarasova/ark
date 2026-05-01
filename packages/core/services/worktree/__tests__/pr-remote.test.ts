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
import {
  createWorktreePR,
  mergeWorktreePR,
  detectGitHost,
  parseCreatePrUrl,
} from "../pr.js";
import type { Compute, Session } from "../../../../types/index.js";
import type { ComputeProvider } from "../../../../compute/types.js";

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
        return new Response(
          JSON.stringify({ status: "ok", version: "stub", hostname: "stub", platform: "stub" }),
          { headers: { "content-type": "application/json" } },
        );
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

// ── createWorktreePR: remote dispatch routes through ArkdClient ──────────────

describe("createWorktreePR (remote compute)", () => {
  it("routes git push + fetch + rebase through ArkdClient.run with the remote workdir", async () => {
    const remoteWorkdir = "/home/ubuntu/Projects/pi-event-registry";
    stub = startStubArkd({
      port: arkdPort,
      reply: (call) => {
        // Default: success. Specific calls can be customized later if needed.
        if (call.command === "git" && call.args[0] === "remote") {
          return { exitCode: 0, stdout: "git@bitbucket.org:owner/pi-event-registry.git\n", stderr: "" };
        }
        if (call.command === "git" && call.args[0] === "push") {
          // Simulate Bitbucket's "Create a pull request" stderr output.
          return {
            exitCode: 0,
            stdout: "",
            stderr: [
              "remote:",
              "remote: Create pull request for feat/x:",
              "remote:   https://bitbucket.org/owner/pi-event-registry/pull-requests/new?source=feat/x",
              "remote:",
            ].join("\n"),
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    // Register stub remote provider as "ec2" -- providerOf({ec2,direct}) returns "ec2".
    const provider = makeRemoteStubProvider(`http://localhost:${arkdPort}`, remoteWorkdir);
    app.registerProvider(provider);
    await app.computes.insert({
      name: "stub-remote",
      provider: "ec2" as any,
      compute_kind: "ec2",
      runtime_kind: "direct",
      status: "running",
      config: { instance_id: "i-stub" },
    } as any);

    const session = await app.sessions.create({
      summary: "remote PR test",
      flow: "quick",
      compute_name: "stub-remote",
      repo: "git@bitbucket.org:owner/pi-event-registry.git",
      branch: "feat/x",
    });
    // Mark branch explicitly so createWorktreePR doesn't try to resolve it via git.
    await app.sessions.update(session.id, { branch: "feat/x" });
    // Disable auto_rebase on the session config -- we don't want our Bitbucket
    // stub to have to model the full rebase flow. (Auto-rebase is exercised
    // separately in auto-rebase.test.ts which uses real local git repos.)
    // The repo config file lookup is best-effort; we additionally write it
    // into session.config so loadRepoConfig sees it.
    // (loadRepoConfig only reads .ark.yaml from session.workdir; for this
    // test session.workdir is null, so loadRepoConfig returns {} and rebase
    // runs. We let it run and our stub returns 0 for fetch + rebase.)

    const result = await createWorktreePR(app, session.id, { base: "main" });

    // Push succeeded, parsed URL came from push stderr.
    expect(result.ok).toBe(true);
    expect(result.pr_url).toBe("https://bitbucket.org/owner/pi-event-registry/pull-requests/new?source=feat/x");

    // Verify every git invocation went through arkd /exec.
    const cmds = stub.calls.map((c) => `${c.command} ${c.args.join(" ")}`);
    // fetch + rebase from rebaseOntoBase, then push, then remote get-url for host detection.
    expect(cmds).toContain("git fetch origin main");
    expect(cmds).toContain("git rebase origin/main");
    expect(cmds).toContain("git push -u origin feat/x");
    expect(cmds).toContain("git remote get-url origin");
    // CWD is the remote workdir on every call.
    for (const call of stub.calls) {
      expect(call.cwd).toBe(remoteWorkdir);
    }

    // Session row records the parsed PR URL.
    const updated = await app.sessions.get(session.id);
    expect(updated?.pr_url).toBe("https://bitbucket.org/owner/pi-event-registry/pull-requests/new?source=feat/x");
  });
});

// ── mergeWorktreePR: bitbucket / non-github degrades cleanly ────────────────

describe("mergeWorktreePR", () => {
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
