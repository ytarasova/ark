/**
 * Pure-SSM transport primitives for EC2.
 *
 * Exercises ssmCheckInstance / ssmExec / ssmExecArgs against a mock
 * SSMClient (passed via the `client` injection seam). No AWS calls; no
 * `aws` CLI; no shell-out. Port-forward spawn lives in ssm.ts but its
 * behaviour is integration-only (it spawns the AWS CLI), so we cover the
 * *call shape* via the mocked client and rely on ec2-compute.test.ts for
 * the lifecycle-level assertions.
 */

import { describe, expect, it } from "bun:test";
import { ssmCheckInstance, ssmExec, ssmExecArgs } from "../providers/ec2/ssm.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

interface RecordingClient {
  sends: any[];
  send: (cmd: any) => Promise<any>;
}

function makeClient(responder: (cmd: any) => any): RecordingClient {
  const sends: any[] = [];
  return {
    sends,
    send: async (cmd: any) => {
      sends.push(cmd);
      return responder(cmd);
    },
  };
}

// Mark an object as a particular SSM "command" so the response router in
// each test can branch on it. The real SDK uses class identity; we use the
// constructor name string which is what the mock branches on.
function cmdName(cmd: any): string {
  return cmd?.constructor?.name ?? "";
}

// ── ssmCheckInstance ────────────────────────────────────────────────────────

describe("ssmCheckInstance", () => {
  it("returns true when the instance reports PingStatus=Online", async () => {
    const client = makeClient((cmd: any) => {
      if (cmdName(cmd) === "DescribeInstanceInformationCommand") {
        return { InstanceInformationList: [{ InstanceId: "i-abc", PingStatus: "Online" }] };
      }
      throw new Error(`unexpected cmd ${cmdName(cmd)}`);
    });
    const ok = await ssmCheckInstance({ instanceId: "i-abc", region: "us-east-1", client: client as any });
    expect(ok).toBe(true);
    expect(client.sends.length).toBe(1);
  });

  it("returns false when the agent reports a non-Online status", async () => {
    const client = makeClient(() => ({
      InstanceInformationList: [{ InstanceId: "i-abc", PingStatus: "ConnectionLost" }],
    }));
    const ok = await ssmCheckInstance({ instanceId: "i-abc", region: "us-east-1", client: client as any });
    expect(ok).toBe(false);
  });

  it("returns false when the instance isn't listed at all", async () => {
    const client = makeClient(() => ({ InstanceInformationList: [] }));
    const ok = await ssmCheckInstance({ instanceId: "i-abc", region: "us-east-1", client: client as any });
    expect(ok).toBe(false);
  });

  it("returns false on transient/network SDK errors (treats as offline, never throws)", async () => {
    const client = makeClient(() => {
      throw new Error("network unreachable");
    });
    const ok = await ssmCheckInstance({ instanceId: "i-abc", region: "us-east-1", client: client as any });
    expect(ok).toBe(false);
  });

  it("throws a clear refresh-creds error when AWS reports an expired token", async () => {
    const client = makeClient(() => {
      const err = new Error("The security token included in the request is expired");
      (err as any).name = "ExpiredTokenException";
      throw err;
    });
    await expect(
      ssmCheckInstance({
        instanceId: "i-abc",
        region: "us-east-1",
        awsProfile: "pai-risk-mlops",
        client: client as any,
      }),
    ).rejects.toThrow(/expired or invalid.*aws sso login --profile pai-risk-mlops/);
  });

  it("throws on AccessDenied as well (auth bucket includes IAM denials)", async () => {
    const client = makeClient(() => {
      const err = new Error("User: arn:aws:iam::... is not authorized to perform: ssm:DescribeInstanceInformation");
      (err as any).name = "AccessDeniedException";
      throw err;
    });
    await expect(
      ssmCheckInstance({ instanceId: "i-abc", region: "us-east-1", awsProfile: "p", client: client as any }),
    ).rejects.toThrow(/expired or invalid/);
  });
});

// ── ssmExec ─────────────────────────────────────────────────────────────────

describe("ssmExec", () => {
  it("runs SendCommand with AWS-RunShellScript + executionTimeout, then polls until Success", async () => {
    let pollCount = 0;
    const client = makeClient((cmd: any) => {
      const name = cmdName(cmd);
      if (name === "SendCommandCommand") {
        // Verify the request shape -- doc name + commands param.
        expect((cmd as any).input.DocumentName).toBe("AWS-RunShellScript");
        expect((cmd as any).input.InstanceIds).toEqual(["i-abc"]);
        expect((cmd as any).input.Parameters.commands).toEqual(["echo hello"]);
        // executionTimeout is in seconds, must match our timeoutMs.
        expect((cmd as any).input.Parameters.executionTimeout).toEqual(["10"]);
        return { Command: { CommandId: "cid-1" } };
      }
      if (name === "GetCommandInvocationCommand") {
        pollCount += 1;
        // Two transient "Pending" readings, then "Success".
        if (pollCount < 3) return { Status: "Pending" };
        return {
          Status: "Success",
          StandardOutputContent: "hello\n",
          StandardErrorContent: "",
          ResponseCode: 0,
        };
      }
      throw new Error(`unexpected cmd ${name}`);
    });

    const result = await ssmExec({
      instanceId: "i-abc",
      region: "us-east-1",
      command: "echo hello",
      timeoutMs: 10_000,
      client: client as any,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
    expect(result.stderr).toBe("");
    // The polling loop ran at least 3 times before terminal status.
    expect(pollCount).toBeGreaterThanOrEqual(3);
  });

  it("returns Failed status as a non-zero exitCode + stderr", async () => {
    const client = makeClient((cmd: any) => {
      const name = cmdName(cmd);
      if (name === "SendCommandCommand") return { Command: { CommandId: "cid-2" } };
      if (name === "GetCommandInvocationCommand") {
        return {
          Status: "Failed",
          StandardOutputContent: "",
          StandardErrorContent: "command not found\n",
          ResponseCode: 127,
        };
      }
      throw new Error(`unexpected ${name}`);
    });
    const result = await ssmExec({
      instanceId: "i-abc",
      region: "us-east-1",
      command: "nonexistent",
      client: client as any,
    });
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toBe("command not found\n");
  });

  it("does not throw when SendCommand itself fails", async () => {
    const client = makeClient(() => {
      throw new Error("AccessDenied: ssm:SendCommand");
    });
    const result = await ssmExec({
      instanceId: "i-abc",
      region: "us-east-1",
      command: "echo hi",
      client: client as any,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("AccessDenied");
  });

  it("ignores transient InvocationDoesNotExist and keeps polling", async () => {
    let calls = 0;
    const client = makeClient((cmd: any) => {
      const name = cmdName(cmd);
      if (name === "SendCommandCommand") return { Command: { CommandId: "cid-3" } };
      if (name === "GetCommandInvocationCommand") {
        calls += 1;
        if (calls === 1) {
          const err: any = new Error("invocation not yet visible");
          err.name = "InvocationDoesNotExist";
          throw err;
        }
        return { Status: "Success", StandardOutputContent: "ok", StandardErrorContent: "", ResponseCode: 0 };
      }
      throw new Error(`unexpected ${name}`);
    });
    const result = await ssmExec({
      instanceId: "i-abc",
      region: "us-east-1",
      command: "echo ok",
      client: client as any,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
  });
});

// ── ssmExecArgs ─────────────────────────────────────────────────────────────

describe("ssmExecArgs", () => {
  it("rejects empty argv", async () => {
    await expect(ssmExecArgs({ instanceId: "i", region: "us-east-1", argv: [] })).rejects.toThrow(/non-empty/);
  });

  it("rejects non-string argv elements", async () => {
    await expect(
      // @ts-expect-error -- deliberately bad input
      ssmExecArgs({ instanceId: "i", region: "us-east-1", argv: ["mkdir", 123] }),
    ).rejects.toThrow(/must be strings/);
  });

  it("shell-escapes each argv element before joining", async () => {
    let captured = "";
    const client = makeClient((cmd: any) => {
      const name = cmdName(cmd);
      if (name === "SendCommandCommand") {
        captured = (cmd as any).input.Parameters.commands[0];
        return { Command: { CommandId: "cid-4" } };
      }
      if (name === "GetCommandInvocationCommand") {
        return { Status: "Success", StandardOutputContent: "", StandardErrorContent: "", ResponseCode: 0 };
      }
      throw new Error(`unexpected ${name}`);
    });

    const malicious = "s-abc; rm -rf /";
    await ssmExecArgs({
      instanceId: "i-abc",
      region: "us-east-1",
      argv: ["mkdir", "-p", `/tmp/ark-${malicious}`],
      client: client as any,
    });

    // Every element must come back as a single-quoted token; the `;` from the
    // injection payload must stay inside its surrounding quote.
    expect(captured).toContain("'mkdir'");
    expect(captured).toContain("'-p'");
    expect(captured).toContain("'/tmp/ark-s-abc; rm -rf /'");
    // No bare semicolon outside the quoted token.
    const stripped = captured.replace(/'[^']*'/g, "");
    expect(stripped).not.toContain(";");
  });
});
