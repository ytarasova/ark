import { describe, it, expect } from "bun:test";
import { buildSandboxCommand, isDockerAvailable } from "../sandbox.js";

describe("sandbox", () => {
  it("builds basic docker command", () => {
    const cmd = buildSandboxCommand("/my/project", "echo hello");
    expect(cmd).toContain("docker run");
    expect(cmd).toContain("-v /my/project:/workspace");
    expect(cmd).toContain("-w /workspace");
    expect(cmd).toContain("ubuntu:22.04");
    expect(cmd).toContain("echo hello");
  });

  it("applies resource limits", () => {
    const cmd = buildSandboxCommand("/proj", "cmd", { cpuLimit: "2.0", memoryLimit: "4g" });
    expect(cmd).toContain("--cpus 2.0");
    expect(cmd).toContain("-m 4g");
  });

  it("uses custom image", () => {
    const cmd = buildSandboxCommand("/proj", "cmd", { image: "node:20" });
    expect(cmd).toContain("node:20");
    expect(cmd).not.toContain("ubuntu:22.04");
  });

  it("mounts SSH when requested", () => {
    const cmd = buildSandboxCommand("/proj", "cmd", { mountSsh: true });
    expect(cmd).toContain(".ssh:/root/.ssh:ro");
  });

  it("adds environment variables", () => {
    const cmd = buildSandboxCommand("/proj", "cmd", { env: { FOO: "bar" } });
    expect(cmd).toContain("-e FOO=bar");
  });

  it("isDockerAvailable returns boolean", () => {
    const result = isDockerAvailable();
    expect(typeof result).toBe("boolean");
  }, 10_000);
});
