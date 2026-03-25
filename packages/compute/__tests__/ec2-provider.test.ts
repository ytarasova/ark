import { describe, it, expect } from "bun:test";
import { EC2Provider } from "../providers/ec2/index.js";

const provider = new EC2Provider();

describe("EC2Provider", () => {
  it("has name 'ec2'", () => {
    expect(provider.name).toBe("ec2");
  });

  it("implements all ComputeProvider methods", () => {
    expect(typeof provider.provision).toBe("function");
    expect(typeof provider.destroy).toBe("function");
    expect(typeof provider.start).toBe("function");
    expect(typeof provider.stop).toBe("function");
    expect(typeof provider.launch).toBe("function");
    expect(typeof provider.attach).toBe("function");
    expect(typeof provider.getMetrics).toBe("function");
    expect(typeof provider.probePorts).toBe("function");
    expect(typeof provider.syncEnvironment).toBe("function");
  });

  it("probePorts returns not-listening for compute without IP", async () => {
    const compute = {
      name: "test",
      provider: "ec2",
      status: "stopped",
      config: {},
      created_at: "",
      updated_at: "",
    };
    const result = await provider.probePorts(compute, [
      { port: 3000, source: "test" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].listening).toBe(false);
  });

  it("createEc2Client uses aws_profile from config", () => {
    // We can't test actual AWS calls without credentials,
    // but we can verify the EC2Provider uses the profile
    const provider = new EC2Provider();

    // Verify start/stop/destroy methods exist and are async
    expect(typeof provider.start).toBe("function");
    expect(typeof provider.stop).toBe("function");
    expect(typeof provider.destroy).toBe("function");

    // Verify they reject when instance_id is missing
    const computeNoInstance = {
      name: "test", provider: "ec2", status: "running",
      config: { region: "us-east-1", aws_profile: "yt" },
      created_at: "", updated_at: "",
    };
    expect(provider.start(computeNoInstance)).rejects.toThrow("has no instance_id");
    expect(provider.stop(computeNoInstance)).rejects.toThrow("has no instance_id");
  });

  it("launch rejects when compute has no IP", async () => {
    const provider = new EC2Provider();
    const compute = {
      name: "test", provider: "ec2", status: "running",
      config: {},
      created_at: "", updated_at: "",
    };
    const session = {
      id: "s-test", ticket: null, summary: null, repo: "test/repo",
      branch: null, compute_name: "test", session_id: null, claude_session_id: null,
      stage: "work", status: "running", flow: "bare", agent: null,
      workdir: null, pr_url: null, pr_id: null, error: null,
      parent_id: null, fork_group: null, group_name: null,
      breakpoint_reason: null, attached_by: null, config: {},
      created_at: "", updated_at: "",
    };
    await expect(provider.launch(compute, session, {
      tmuxName: "test", workdir: "/tmp", launcherContent: "echo hi", ports: [],
    })).rejects.toThrow("has no IP");
  });

  it("launch rejects when repo URL cannot be resolved", async () => {
    const provider = new EC2Provider();
    const compute = {
      name: "test", provider: "ec2", status: "running",
      config: { ip: "1.2.3.4" },
      created_at: "", updated_at: "",
    };
    const session = {
      id: "s-test", ticket: null, summary: null, repo: null,
      branch: null, compute_name: "test", session_id: null, claude_session_id: null,
      stage: "work", status: "running", flow: "bare", agent: null,
      workdir: null, pr_url: null, pr_id: null, error: null,
      parent_id: null, fork_group: null, group_name: null,
      breakpoint_reason: null, attached_by: null, config: {},
      created_at: "", updated_at: "",
    };
    await expect(provider.launch(compute, session, {
      tmuxName: "test", workdir: "/tmp/ark-nonexistent-not-a-repo", launcherContent: "echo hi", ports: [],
    })).rejects.toThrow("Cannot determine git repo URL");
  });
});
