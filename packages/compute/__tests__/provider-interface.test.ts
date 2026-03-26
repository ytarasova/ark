import { describe, it, expect } from "bun:test";
import { LocalProvider } from "../providers/local/index.js";
import { EC2Provider } from "../providers/ec2/index.js";

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
});
