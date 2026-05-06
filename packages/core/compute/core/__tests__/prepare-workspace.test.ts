/**
 * Compute.prepareWorkspace tests.
 *
 * Two surfaces under test:
 *
 *   1. `cloneWorkspaceViaArkd` -- the shared helper used by every Compute
 *      kind whose worktree lives away from the conductor. We stub the
 *      module-level `fetch` (ArkdClient is fetch-shaped under the hood)
 *      so we can assert the exact `mkdir -p <parent>` + `git clone <src>
 *      <dest>` call sequence the legacy `RemoteWorktreeProvider.launch`
 *      body produces. This is the strongest coverage we can give the
 *      "no divergence from legacy" invariant short of a live arkd.
 *
 *   2. `EC2Compute.prepareWorkspace` -- thin wrapper around the helper.
 *      Tests use `setCloneHelperForTesting` to inject a recording stub
 *      so we don't reach into ArkdClient at all. Asserts:
 *        - early-return when `source` is null
 *        - early-return when `remoteWorkdir` is null
 *        - delegation when both are set, with `getArkdUrl(handle)`
 *          threaded through to the helper
 *
 * LocalCompute does not implement prepareWorkspace (the conductor and
 * compute share a filesystem; the worktree is already on the host).
 * That branch is asserted via the same shape the resolve-workdir tests
 * use.
 */

import { describe, expect, test } from "bun:test";
import { LocalCompute } from "../local.js";
import { EC2Compute, type EC2HandleMeta } from "../ec2.js";
import { cloneWorkspaceViaArkd, type RemoteCloneOpts } from "../workspace-clone.js";

const STUB_APP = {} as never;

// ── helper-level tests ──────────────────────────────────────────────────────

describe("cloneWorkspaceViaArkd", () => {
  test("issues mkdir -p <parent> then git clone <source> <workdir> in order", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = init?.body ? JSON.parse(init.body as string) : null;
      calls.push({ url, body });
      return new Response(JSON.stringify({ stdout: "", stderr: "", exitCode: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await cloneWorkspaceViaArkd({
        arkdUrl: "http://localhost:54321",
        arkdToken: null,
        source: "git@example.com:org/repo.git",
        remoteWorkdir: "/home/ubuntu/Projects/s-abc/repo",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("http://localhost:54321/exec");
    expect(calls[0].body).toEqual({
      command: "mkdir",
      args: ["-p", "/home/ubuntu/Projects/s-abc"],
      timeout: 15_000,
    });
    expect(calls[1].url).toBe("http://localhost:54321/exec");
    expect(calls[1].body).toEqual({
      command: "git",
      args: ["clone", "git@example.com:org/repo.git", "/home/ubuntu/Projects/s-abc/repo"],
      timeout: 120_000,
    });
  });

  test("derives the parent directory by stripping the leaf path component", async () => {
    const captured: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      if (body?.command === "mkdir") captured.push(body.args[1]);
      return new Response(JSON.stringify({ stdout: "", stderr: "", exitCode: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await cloneWorkspaceViaArkd({
        arkdUrl: "http://localhost:1",
        arkdToken: null,
        source: "x",
        remoteWorkdir: "/a/b/c/d/leaf",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(captured).toEqual(["/a/b/c/d"]);
  });

  test("forwards bearer token when provided", async () => {
    const headers: Array<Record<string, string>> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      headers.push((init?.headers as Record<string, string>) ?? {});
      return new Response(JSON.stringify({ stdout: "", stderr: "", exitCode: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await cloneWorkspaceViaArkd({
        arkdUrl: "http://localhost:1",
        arkdToken: "secret-token",
        source: "x",
        remoteWorkdir: "/a/b",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(headers).toHaveLength(2);
    for (const h of headers) {
      expect(h.Authorization).toBe("Bearer secret-token");
    }
  });
});

// ── EC2Compute.prepareWorkspace tests ───────────────────────────────────────

function makeHandle(arkdLocalPort: number): { kind: "ec2"; name: string; meta: { ec2: EC2HandleMeta } } {
  return {
    kind: "ec2",
    name: "ec2-test",
    meta: {
      ec2: {
        instanceId: "i-abc",
        publicIp: null,
        privateIp: null,
        arkdLocalPort,
        portForwardPid: 1234,
        region: "us-east-1",
        stackName: "ark-compute-ec2-test",
        size: "m",
        arch: "x64",
      },
    },
  };
}

describe("EC2Compute.prepareWorkspace", () => {
  test("returns silently when source is null (bare-worktree)", async () => {
    const c = new EC2Compute(STUB_APP);
    const calls: RemoteCloneOpts[] = [];
    c.setCloneHelperForTesting(async (opts) => {
      calls.push(opts);
    });

    await c.prepareWorkspace!(makeHandle(54321), {
      source: null,
      remoteWorkdir: "/home/ubuntu/Projects/s-test/repo",
      sessionId: "s-test",
    });

    expect(calls).toHaveLength(0);
  });

  test("returns silently when remoteWorkdir is null", async () => {
    const c = new EC2Compute(STUB_APP);
    const calls: RemoteCloneOpts[] = [];
    c.setCloneHelperForTesting(async (opts) => {
      calls.push(opts);
    });

    await c.prepareWorkspace!(makeHandle(54321), {
      source: "git@example.com:org/repo.git",
      remoteWorkdir: null,
      sessionId: "s-test",
    });

    expect(calls).toHaveLength(0);
  });

  test("delegates to cloneWorkspaceViaArkd with arkdUrl from getArkdUrl(handle)", async () => {
    const c = new EC2Compute(STUB_APP);
    const calls: RemoteCloneOpts[] = [];
    c.setCloneHelperForTesting(async (opts) => {
      calls.push(opts);
    });

    await c.prepareWorkspace!(makeHandle(54321), {
      source: "git@example.com:org/repo.git",
      remoteWorkdir: "/home/ubuntu/Projects/s-test/repo",
      sessionId: "s-test",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].arkdUrl).toBe("http://localhost:54321");
    expect(calls[0].source).toBe("git@example.com:org/repo.git");
    expect(calls[0].remoteWorkdir).toBe("/home/ubuntu/Projects/s-test/repo");
  });
});

// ── LocalCompute (no impl) ──────────────────────────────────────────────────

describe("Compute.prepareWorkspace -- LocalCompute", () => {
  test("LocalCompute does not implement prepareWorkspace (caller skips remote setup)", () => {
    const c = new LocalCompute(STUB_APP);
    // The conductor and the local compute share a filesystem, so the
    // worktree is already on the host -- no remote setup needed. The
    // dispatcher's null/undefined fallback covers both shapes; we
    // assert "undefined" here because LocalCompute deliberately omits
    // the method (matching the resolveWorkdir style).
    expect(c.prepareWorkspace).toBeUndefined();
  });
});
