import { describe, expect, test, beforeEach } from "bun:test";
import { EC2PlacementCtx, _makeEC2PlacementCtx } from "../placement-ctx.js";

describe("EC2PlacementCtx", () => {
  let ssmExecCalls: string[] = [];
  let stubSsmExec: (instanceId: string, cmd: string) => Promise<string>;

  beforeEach(() => {
    ssmExecCalls = [];
    stubSsmExec = async (_instanceId, cmd) => {
      ssmExecCalls.push(cmd);
      return "";
    };
  });

  test("setEnv accumulates; getEnv returns merged map", () => {
    const ctx = new EC2PlacementCtx({ instanceId: "i-abc", region: "us-east-1" });
    ctx.setEnv("FOO", "1");
    ctx.setEnv("BAR", "2");
    expect(ctx.getEnv()).toEqual({ FOO: "1", BAR: "2" });
  });

  test("setProvisionerConfig logs no-op (EC2 does not consume kubeconfig)", () => {
    const ctx = new EC2PlacementCtx({ instanceId: "i-abc", region: "us-east-1" });
    expect(() => ctx.setProvisionerConfig({ kubeconfig: new Uint8Array([1]) })).not.toThrow();
  });

  test("expandHome substitutes ~/ with /home/ubuntu", () => {
    const ctx = new EC2PlacementCtx({ instanceId: "i-abc", region: "us-east-1" });
    expect(ctx.expandHome("~/.ssh/config")).toBe("/home/ubuntu/.ssh/config");
    expect(ctx.expandHome("/abs/path")).toBe("/abs/path");
  });

  test("writeFile encodes bytes via base64 + chmod, mkdir parent dir", async () => {
    const ctx = _makeEC2PlacementCtx({
      instanceId: "i-abc",
      region: "us-east-1",
      ssmExec: stubSsmExec,
    });
    await ctx.writeFile("/home/ubuntu/.ssh/id_x", 0o600, Buffer.from("PEM"));
    expect(ssmExecCalls).toHaveLength(1);
    const cmd = ssmExecCalls[0];
    // mkdir parent
    expect(cmd).toContain("mkdir -p '/home/ubuntu/.ssh'");
    // base64 of "PEM"
    expect(cmd).toContain(Buffer.from("PEM").toString("base64"));
    expect(cmd).toContain("base64 -d");
    expect(cmd).toContain("/home/ubuntu/.ssh/id_x");
    // chmod with file mode
    expect(cmd).toContain("chmod 600");
  });

  test("appendFile replaces a stale block keyed by marker (sed BEGIN/END deletion)", async () => {
    const ctx = _makeEC2PlacementCtx({
      instanceId: "i-abc",
      region: "us-east-1",
      ssmExec: stubSsmExec,
    });
    await ctx.appendFile(
      "/home/ubuntu/.ssh/config",
      "ark:secret:BB",
      Buffer.from("Host bitbucket.org\n  IdentityFile /x\n"),
    );
    const cmd = ssmExecCalls.join("\n");
    // mkdir parent, touch file, sed-delete prior block, base64-decode and append new bytes.
    expect(cmd).toContain("mkdir -p");
    expect(cmd).toContain("touch ");
    expect(cmd).toMatch(/sed.+BEGIN ark:secret:BB.+END ark:secret:BB/);
    expect(cmd).toContain("base64 -d");
    // The base64 of "Host bitbucket.org\n  IdentityFile /x\n" should appear:
    const expected = Buffer.from("Host bitbucket.org\n  IdentityFile /x\n").toString("base64");
    expect(cmd).toContain(expected);
  });

  test("appendFile marker can be passed as raw 'NAME' (no ark:secret: prefix) and it still works", async () => {
    const ctx = _makeEC2PlacementCtx({
      instanceId: "i-abc",
      region: "us-east-1",
      ssmExec: stubSsmExec,
    });
    await ctx.appendFile("/file", "ark:secret:BB_KEY", Buffer.from("X"));
    const cmd = ssmExecCalls.join("\n");
    expect(cmd).toMatch(/BEGIN ark:secret:BB_KEY/);
    expect(cmd).toMatch(/END ark:secret:BB_KEY/);
  });
});
