/**
 * F2 regression: RemoteArkdBase.cleanupSession must NOT pass the conductor's
 * local-filesystem `session.workdir` to a remote `rm -rf`. Pre-fix, sessions
 * dispatched to EC2 with `session.workdir = /Users/<name>/Projects/ark`
 * resulted in `rm -rf /Users/<name>/Projects/ark` being executed on the
 * Ubuntu host -- a no-op (path doesn't exist), but the actual remote clone at
 * `${REMOTE_HOME}/Projects/<sid>/<repo>` accumulated forever.
 *
 * Fix: resolve through `provider.resolveWorkdir(compute, session)`. When
 * the provider doesn't implement it (RemoteDocker / RemoteFirecracker /
 * RemoteDevcontainer), skip the rm rather than guess. Defensive guard
 * also refuses any path that doesn't start with `${REMOTE_HOME}/` or
 * `/workspace/`.
 */
import { describe, it, expect } from "bun:test";

import {
  RemoteWorktreeProvider,
  RemoteDockerProvider,
  RemoteFirecrackerProvider,
  RemoteDevcontainerProvider,
} from "../providers/remote-arkd.js";
import { ArkdClient } from "../../arkd/client.js";
import type { Compute, Session } from "../types.js";

const CONDUCTOR_PATH = "/Users/paytmlabs/Projects/ark";

function makeCompute(overrides?: Partial<Compute>): Compute {
  return {
    name: "test-remote",
    provider: "ec2",
    status: "running",
    config: {
      instance_id: "i-test",
      region: "us-east-1",
      // Forward port so getArkdUrl resolves cleanly without throwing.
      arkd_local_forward_port: 49999,
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as Compute;
}

function makeSession(overrides?: Partial<Session>): Session {
  return {
    id: "s-cleanup-test",
    session_id: "ark-s-cleanup-test",
    workdir: CONDUCTOR_PATH,
    repo: "git@github.com:ytarasova/ark.git",
    config: { remoteRepo: "git@github.com:ytarasova/ark.git" },
    ...overrides,
  } as Session;
}

interface RunCall {
  command: string;
  args: string[];
}

/**
 * Stub `getClient` on the provider instance so `client.run({...})` records
 * the invocation instead of going to the network. Returns the recorded
 * calls plus a restore handle.
 */
function stubGetClient(provider: unknown): RunCall[] {
  const calls: RunCall[] = [];
  const fakeClient = {
    run: async (opts: { command: string; args: string[] }) => {
      calls.push({ command: opts.command, args: opts.args });
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  } as unknown as ArkdClient;
  // `getClient` is `protected` -- punch through with a typed cast.
  (provider as { getClient: (c: Compute) => ArkdClient }).getClient = () => fakeClient;
  return calls;
}

describe("RemoteWorktreeProvider.cleanupSession (F2)", () => {
  it("does NOT pass the conductor's session.workdir to remote rm -rf", async () => {
    const provider = new RemoteWorktreeProvider();
    const calls = stubGetClient(provider);

    await provider.cleanupSession(makeCompute(), makeSession());

    // Whatever rm calls happened (zero or one), none of them may target the
    // conductor-shaped path.
    for (const call of calls) {
      for (const arg of call.args) {
        expect(arg.includes("/Users/")).toBe(false);
      }
    }
  });

  it("targets a remote-safe path under /home/ubuntu/ when remoteRepo is set", async () => {
    const provider = new RemoteWorktreeProvider();
    const calls = stubGetClient(provider);

    await provider.cleanupSession(makeCompute(), makeSession());

    expect(calls.length).toBe(1);
    const rm = calls[0];
    expect(rm.command).toBe("rm");
    expect(rm.args[0]).toBe("-rf");
    expect(rm.args[1]).toMatch(/^\/(home\/ubuntu|workspace)\//);
    // Concrete shape: ${REMOTE_HOME}/Projects/<sid>/<repoBasename>
    expect(rm.args[1]).toContain("/Projects/s-cleanup-test/");
  });

  it("skips rm entirely when no clone source is set (resolveWorkdir returns null)", async () => {
    const provider = new RemoteWorktreeProvider();
    const calls = stubGetClient(provider);

    // No remoteRepo, no repo -- resolveWorkdir returns null.
    const session = makeSession({ repo: null, config: {} } as Partial<Session>);
    await provider.cleanupSession(makeCompute(), session);

    // Either zero rm calls (preferred) OR if any happened, none touch /Users/.
    expect(calls.length).toBe(0);
  });
});

describe("RemoteDockerProvider.cleanupSession (F2)", () => {
  it("inherits the safe behaviour: never rm /Users/ on the remote", async () => {
    const provider = new RemoteDockerProvider();
    const calls = stubGetClient(provider);

    await provider.cleanupSession(makeCompute(), makeSession());

    for (const call of calls) {
      for (const arg of call.args) {
        expect(arg.includes("/Users/")).toBe(false);
      }
    }
  });
});

describe("RemoteFirecrackerProvider.cleanupSession (F2)", () => {
  it("inherits the safe behaviour: never rm /Users/ on the remote", async () => {
    const provider = new RemoteFirecrackerProvider();
    const calls = stubGetClient(provider);

    await provider.cleanupSession(makeCompute(), makeSession());

    for (const call of calls) {
      for (const arg of call.args) {
        expect(arg.includes("/Users/")).toBe(false);
      }
    }
  });
});

describe("RemoteDevcontainerProvider.cleanupSession (F2)", () => {
  it("inherits the safe behaviour: never rm /Users/ on the remote", async () => {
    const provider = new RemoteDevcontainerProvider();
    const calls = stubGetClient(provider);

    await provider.cleanupSession(makeCompute(), makeSession());

    for (const call of calls) {
      for (const arg of call.args) {
        expect(arg.includes("/Users/")).toBe(false);
      }
    }
  });
});
