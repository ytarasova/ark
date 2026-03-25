import { describe, it, expect } from "bun:test";
import { buildUserData } from "../providers/ec2/cloud-init.js";

describe("buildUserData", () => {
  it("produces a bash script starting with #!/bin/bash", () => {
    const script = buildUserData();
    expect(script.startsWith("#!/bin/bash")).toBe(true);
  });

  it("contains required packages: nodejs, docker, gh, tmux, bun, claude", () => {
    const script = buildUserData();
    expect(script).toContain("nodejs");
    expect(script).toContain("docker");
    expect(script).toContain("gh");
    expect(script).toContain("tmux");
    expect(script).toContain("bun.sh/install");
    expect(script).toContain("claude.ai/install.sh");
  });

  it("includes idle shutdown script with ark-idle-shutdown", () => {
    const script = buildUserData();
    expect(script).toContain("ark-idle-shutdown");
  });

  it("includes shutdown -h now", () => {
    const script = buildUserData();
    expect(script).toContain("shutdown -h now");
  });

  it("custom idle timeout: idleMinutes 120 produces tick count 12", () => {
    const script = buildUserData({ idleMinutes: 120 });
    expect(script).toContain("idle tick $COUNT/12");
    expect(script).toContain('"$COUNT" -ge 12');
  });

  it("default idle timeout: 60 minutes produces tick count 6", () => {
    const script = buildUserData();
    expect(script).toContain("idle tick $COUNT/6");
    expect(script).toContain('"$COUNT" -ge 6');
  });

  it("includes devcontainer CLI", () => {
    const script = buildUserData();
    expect(script).toContain("@devcontainers/cli");
  });

  it("includes .ark-ready marker", () => {
    const script = buildUserData();
    expect(script).toContain(".ark-ready");
  });
});
