import { describe, expect, test, beforeEach } from "bun:test";
import { EC2PlacementCtx, _makeEC2PlacementCtx } from "../placement-ctx.js";

describe("EC2PlacementCtx", () => {
  let sshExecCalls: string[] = [];
  let stubSshExec: (keyPath: string, ip: string, cmd: string) => Promise<string>;

  beforeEach(() => {
    sshExecCalls = [];
    stubSshExec = async (_keyPath, _ip, cmd) => {
      sshExecCalls.push(cmd);
      return "";
    };
  });

  test("setEnv accumulates; getEnv returns merged map", () => {
    const ctx = new EC2PlacementCtx({ sshKeyPath: "/k", ip: "1.2.3.4" });
    ctx.setEnv("FOO", "1");
    ctx.setEnv("BAR", "2");
    expect(ctx.getEnv()).toEqual({ FOO: "1", BAR: "2" });
  });

  test("setProvisionerConfig logs no-op (EC2 does not consume kubeconfig)", () => {
    const ctx = new EC2PlacementCtx({ sshKeyPath: "/k", ip: "1.2.3.4" });
    expect(() => ctx.setProvisionerConfig({ kubeconfig: new Uint8Array([1]) })).not.toThrow();
  });

  test("expandHome substitutes ~/ with /home/ubuntu", () => {
    const ctx = new EC2PlacementCtx({ sshKeyPath: "/k", ip: "1.2.3.4" });
    expect(ctx.expandHome("~/.ssh/config")).toBe("/home/ubuntu/.ssh/config");
    expect(ctx.expandHome("/abs/path")).toBe("/abs/path");
  });

  test("writeFile uses tar pipe + chmod via sshExec", async () => {
    let tarPipeInvoked = false;
    const ctx = _makeEC2PlacementCtx({
      sshKeyPath: "/k",
      ip: "1.2.3.4",
      sshExec: stubSshExec,
      pipeTarToSsh: async (_tarArgs, _remoteCmd) => {
        tarPipeInvoked = true;
      },
    });
    await ctx.writeFile("/home/ubuntu/.ssh/id_x", 0o600, Buffer.from("PEM"));
    expect(tarPipeInvoked).toBe(true);
    // After tar, a chmod is run via sshExec.
    expect(sshExecCalls.some((c) => c.includes("chmod 600") && c.includes("/home/ubuntu/.ssh/id_x"))).toBe(true);
  });

  test("appendFile replaces a stale block keyed by marker (sed BEGIN/END deletion)", async () => {
    const ctx = _makeEC2PlacementCtx({
      sshKeyPath: "/k",
      ip: "1.2.3.4",
      sshExec: stubSshExec,
      pipeTarToSsh: async () => {},
    });
    await ctx.appendFile(
      "/home/ubuntu/.ssh/config",
      "ark:secret:BB",
      Buffer.from("Host bitbucket.org\n  IdentityFile /x\n"),
    );
    const cmd = sshExecCalls.join("\n");
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
    // The marker arg is taken VERBATIM as the BEGIN/END suffix.
    // So `appendFile("...", "ark:secret:BB_KEY", ...)` produces `# BEGIN ark:secret:BB_KEY`.
    const ctx = _makeEC2PlacementCtx({
      sshKeyPath: "/k",
      ip: "1.2.3.4",
      sshExec: stubSshExec,
      pipeTarToSsh: async () => {},
    });
    await ctx.appendFile("/file", "ark:secret:BB_KEY", Buffer.from("X"));
    const cmd = sshExecCalls.join("\n");
    expect(cmd).toMatch(/BEGIN ark:secret:BB_KEY/);
    expect(cmd).toMatch(/END ark:secret:BB_KEY/);
  });
});
