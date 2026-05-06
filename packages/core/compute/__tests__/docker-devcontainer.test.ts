import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  detectDevcontainer,
  resolveDevcontainerPorts,
  buildLaunchCommand,
  devcontainerMounts,
  buildDevcontainer,
  execInDevcontainer,
} from "../providers/docker/devcontainer.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "devcontainer-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("detectDevcontainer", () => {
  it("returns path when .devcontainer/devcontainer.json exists", () => {
    mkdirSync(join(tmpDir, ".devcontainer"));
    writeFileSync(join(tmpDir, ".devcontainer", "devcontainer.json"), "{}");

    const result = detectDevcontainer(tmpDir);
    expect(result).toBe(join(tmpDir, ".devcontainer", "devcontainer.json"));
  });

  it("returns path when .devcontainer.json exists", () => {
    writeFileSync(join(tmpDir, ".devcontainer.json"), "{}");

    const result = detectDevcontainer(tmpDir);
    expect(result).toBe(join(tmpDir, ".devcontainer.json"));
  });

  it("returns null when neither exists", () => {
    const result = detectDevcontainer(tmpDir);
    expect(result).toBeNull();
  });
});

describe("resolveDevcontainerPorts", () => {
  it("extracts forwardPorts from devcontainer.json", () => {
    mkdirSync(join(tmpDir, ".devcontainer"));
    writeFileSync(
      join(tmpDir, ".devcontainer", "devcontainer.json"),
      JSON.stringify({ forwardPorts: [3000, 5432, 8080] }),
    );

    const result = resolveDevcontainerPorts(tmpDir);
    expect(result).toEqual([3000, 5432, 8080]);
  });

  it("returns empty array when no devcontainer", () => {
    const result = resolveDevcontainerPorts(tmpDir);
    expect(result).toEqual([]);
  });
});

describe("buildLaunchCommand", () => {
  it("returns a string containing devcontainer up and devcontainer exec", () => {
    const cmd = buildLaunchCommand("/workspace/project", "claude --task foo");

    expect(cmd).toContain("devcontainer up");
    expect(cmd).toContain("devcontainer exec");
    expect(cmd).toContain("/workspace/project");
    expect(cmd).toContain("claude --task foo");
  });
});

describe("devcontainerMounts", () => {
  it("returns mount strings for provided dirs", () => {
    const mounts = devcontainerMounts({
      awsDir: "/home/ubuntu/.aws",
      claudeDir: "/home/ubuntu/.claude",
      sshDir: "/home/ubuntu/.ssh",
      gitconfig: "/home/ubuntu/.gitconfig",
    });

    expect(mounts.length).toBe(8); // 4 pairs of --mount + value
    expect(mounts).toContain("--mount");
    expect(mounts.some((m) => m.includes("source=/home/ubuntu/.aws"))).toBe(true);
    expect(mounts.some((m) => m.includes("source=/home/ubuntu/.claude"))).toBe(true);
    expect(mounts.some((m) => m.includes("source=/home/ubuntu/.ssh"))).toBe(true);
    expect(mounts.some((m) => m.includes("source=/home/ubuntu/.gitconfig"))).toBe(true);
  });

  it("with no opts returns empty array", () => {
    const mounts = devcontainerMounts({});
    expect(mounts).toEqual([]);
  });
});

describe("buildDevcontainer", () => {
  it("is a function", () => {
    expect(typeof buildDevcontainer).toBe("function");
  });
});

describe("execInDevcontainer", () => {
  it("is a function", () => {
    expect(typeof execInDevcontainer).toBe("function");
  });
});
