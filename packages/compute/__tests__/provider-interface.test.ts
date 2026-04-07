import { describe, it, expect } from "bun:test";
import { LocalProvider } from "../providers/local/index.js";
import { EC2Provider } from "../providers/ec2/index.js";
import type { Compute, Session } from "../types.js";

describe("ComputeProvider interface", () => {
  const local = new LocalProvider();
  const ec2 = new EC2Provider();

  it("local has capability flags", () => {
    expect(local.canReboot).toBe(false);
    expect(local.canDelete).toBe(false);
    expect(local.supportsWorktree).toBe(true);
    expect(local.initialStatus).toBe("running");
    expect(local.needsAuth).toBe(false);
  });

  it("ec2 has capability flags", () => {
    expect(ec2.canReboot).toBe(true);
    expect(ec2.canDelete).toBe(true);
    expect(ec2.supportsWorktree).toBe(false);
    expect(ec2.initialStatus).toBe("stopped");
    expect(ec2.needsAuth).toBe(true);
  });

  it("local has new methods", () => {
    expect(typeof local.checkSession).toBe("function");
    expect(typeof local.getAttachCommand).toBe("function");
    expect(typeof local.buildChannelConfig).toBe("function");
    expect(typeof local.buildLaunchEnv).toBe("function");
  });

  it("ec2 has new methods", () => {
    expect(typeof ec2.checkSession).toBe("function");
    expect(typeof ec2.getAttachCommand).toBe("function");
    expect(typeof ec2.buildChannelConfig).toBe("function");
    expect(typeof ec2.buildLaunchEnv).toBe("function");
  });

  it("local.buildChannelConfig returns valid config shape", () => {
    const config = local.buildChannelConfig("s-test", "plan", 19200);
    expect(config).toHaveProperty("command");
    expect(config).toHaveProperty("args");
    expect(config).toHaveProperty("env");
    expect(typeof config.command).toBe("string");
  });

  it("local.buildLaunchEnv returns an object", () => {
    const env = local.buildLaunchEnv({} as Session);
    expect(typeof env).toBe("object");
  });

  it("local.getAttachCommand returns array for session with session_id", () => {
    const cmd = local.getAttachCommand({} as Compute, { session_id: "ark-s-test" } as Session);
    expect(Array.isArray(cmd)).toBe(true);
    expect(cmd.length).toBeGreaterThan(0);
    expect(cmd).toContain("ark-s-test");
  });

  it("local.getAttachCommand returns empty array for session without session_id", () => {
    const cmd = local.getAttachCommand({} as Compute, {} as Session);
    expect(cmd).toEqual([]);
  });
});
