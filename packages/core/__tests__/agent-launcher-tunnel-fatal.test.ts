/**
 * Regression: a missing reverse-tunnel PID is fatal in practice but used
 * to only emit a `WARNING` log line. Without the reverse tunnel the
 * agent's `ark hooks` and `ark-channel` MCP server have no path back to
 * the conductor -- the session sits silent at status=running until manual
 * cancel. Now we throw so the dispatcher's error path takes over and the
 * session flips to `failed` with the underlying reason.
 *
 * Mirrors the throw shape Pass 1 added for the new arkd forward tunnel.
 */

import { describe, it, expect, afterAll, spyOn } from "bun:test";
import * as ssh from "../../compute/providers/ec2/ssh.js";
import * as ports from "../../compute/providers/ec2/ports.js";
import { prepareRemoteEnvironment } from "../services/agent-launcher.js";
import { withTestContext, getApp } from "./test-helpers.js";
import type { Compute, Session } from "../../types/index.js";
import type { ComputeProvider } from "../../compute/types.js";

withTestContext();

// ── SSH connectivity stub: always pass ─────────────────────────────────────
const sshSpy = spyOn(ssh, "sshExecAsync").mockImplementation(
  async () => ({ stdout: "ok", stderr: "", exitCode: 0 }) as any,
);

afterAll(() => {
  sshSpy.mockRestore();
});

function makeStubCompute(): Compute {
  return {
    name: "stub-compute-tunnel-fatal",
    provider: "ec2" as any,
    compute_kind: "ec2" as any,
    runtime_kind: "direct" as any,
    status: "running",
    config: { instance_id: "i-deadbeef", region: "us-east-1" } as any,
    last_used: null,
    last_error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    tenant_id: null,
  } as Compute;
}

function makeStubProvider(): ComputeProvider {
  return {
    name: "stub",
    supportsWorktree: false,
    async start() {},
    async stop() {},
    async destroy() {},
    async status() {
      return "running" as const;
    },
    async syncEnvironment() {},
    async launch() {
      return "stub-handle";
    },
    async killAgent() {},
    async captureOutput() {
      return "";
    },
    buildChannelConfig() {
      return {};
    },
  } as unknown as ComputeProvider;
}

describe("prepareRemoteEnvironment reverse-tunnel pid=null is fatal", () => {
  it("throws when setupReverseTunnel returns pid=null (no path back to conductor)", async () => {
    const app = getApp();
    const session: Session = await app.sessions.create({ summary: "tunnel fatal test", flow: "bare" });
    const compute = makeStubCompute();
    const provider = makeStubProvider();

    const reverseTunnelSpy = spyOn(ports, "setupReverseTunnel").mockImplementation(
      async () => ({ pid: null, reused: false, port: 19100 }) as any,
    );
    // The forward-tunnel call would also fire; stub it to a happy path so
    // the test isolates the reverse-tunnel branch (otherwise we'd need to
    // explain whichever throws first).
    const forwardTunnelSpy = spyOn(ports, "setupForwardTunnel").mockImplementation(
      async () => ({ pid: 12345, reused: false, localPort: 9999 }) as any,
    );

    try {
      await expect(
        prepareRemoteEnvironment(app, session, compute, provider, "" /* no workdir */, { onLog: () => {} }),
      ).rejects.toThrow(/Reverse tunnel did not register a PID/);
    } finally {
      reverseTunnelSpy.mockRestore();
      forwardTunnelSpy.mockRestore();
    }
  });

  it("does NOT throw when setupReverseTunnel returns a valid pid", async () => {
    const app = getApp();
    const session: Session = await app.sessions.create({ summary: "tunnel ok test", flow: "bare" });
    const compute = makeStubCompute();
    const provider = makeStubProvider();

    const reverseTunnelSpy = spyOn(ports, "setupReverseTunnel").mockImplementation(
      async () => ({ pid: 54321, reused: false, port: 19100 }) as any,
    );
    const forwardTunnelSpy = spyOn(ports, "setupForwardTunnel").mockImplementation(
      async () => ({ pid: 12345, reused: false, localPort: 9999 }) as any,
    );

    try {
      // Should NOT throw -- both tunnels reported a pid.
      const result = await prepareRemoteEnvironment(app, session, compute, provider, "", { onLog: () => {} });
      expect(result).toBeDefined();
      expect(result.ports).toEqual([]);
    } finally {
      reverseTunnelSpy.mockRestore();
      forwardTunnelSpy.mockRestore();
    }
  });
});
