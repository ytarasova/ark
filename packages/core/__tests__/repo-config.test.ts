import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadRepoConfig } from "../repo-config.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ark-repo-config-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("loadRepoConfig", () => {
  it("returns empty object when no config file exists", () => {
    const config = loadRepoConfig(tempDir);
    expect(config).toEqual({});
  });

  it("loads .ark.yaml with all fields", () => {
    writeFileSync(
      join(tempDir, ".ark.yaml"),
      [
        "flow: review",
        "compute: gpu-box",
        "group: backend",
        "agent: coder",
        "env:",
        "  NODE_ENV: production",
        "  DEBUG: 'true'",
      ].join("\n"),
    );

    const config = loadRepoConfig(tempDir);
    expect(config.flow).toBe("review");
    expect(config.compute).toBe("gpu-box");
    expect(config.group).toBe("backend");
    expect(config.agent).toBe("coder");
    expect(config.env).toEqual({ NODE_ENV: "production", DEBUG: "true" });
  });

  it("loads .ark.yml variant", () => {
    writeFileSync(join(tempDir, ".ark.yml"), "flow: deploy\ngroup: infra\n");

    const config = loadRepoConfig(tempDir);
    expect(config.flow).toBe("deploy");
    expect(config.group).toBe("infra");
  });

  it("loads ark.yaml variant", () => {
    writeFileSync(join(tempDir, "ark.yaml"), "compute: beefy\n");

    const config = loadRepoConfig(tempDir);
    expect(config.compute).toBe("beefy");
  });

  it("prefers .ark.yaml over .ark.yml", () => {
    writeFileSync(join(tempDir, ".ark.yaml"), "flow: alpha\n");
    writeFileSync(join(tempDir, ".ark.yml"), "flow: beta\n");

    const config = loadRepoConfig(tempDir);
    expect(config.flow).toBe("alpha");
  });

  it("handles malformed YAML gracefully", () => {
    writeFileSync(join(tempDir, ".ark.yaml"), "{{{{invalid yaml: [[[");

    const config = loadRepoConfig(tempDir);
    expect(config).toEqual({});
  });

  it("handles partial config", () => {
    writeFileSync(join(tempDir, ".ark.yaml"), "flow: bare\n");

    const config = loadRepoConfig(tempDir);
    expect(config.flow).toBe("bare");
    expect(config.compute).toBeUndefined();
    expect(config.group).toBeUndefined();
    expect(config.agent).toBeUndefined();
    expect(config.env).toBeUndefined();
  });

  it("returns empty for nonexistent directory", () => {
    const config = loadRepoConfig("/tmp/this-dir-does-not-exist-12345");
    expect(config).toEqual({});
  });

  it("handles empty YAML file", () => {
    writeFileSync(join(tempDir, ".ark.yaml"), "");

    const config = loadRepoConfig(tempDir);
    expect(config).toEqual({});
  });

  it("parses worktree.copy list", () => {
    writeFileSync(
      join(tempDir, ".ark.yaml"),
      ["worktree:", "  copy:", '    - ".env"', '    - "config/*.yaml"'].join("\n"),
    );

    const config = loadRepoConfig(tempDir);
    expect(config.worktree?.copy).toEqual([".env", "config/*.yaml"]);
  });

  it("parses worktree.setup string", () => {
    writeFileSync(join(tempDir, ".ark.yaml"), ["worktree:", '  setup: "bun install"'].join("\n"));

    const config = loadRepoConfig(tempDir);
    expect(config.worktree?.setup).toBe("bun install");
  });

  it("handles partial worktree config -- copy only", () => {
    writeFileSync(join(tempDir, ".ark.yaml"), ["worktree:", "  copy:", '    - ".envrc"'].join("\n"));

    const config = loadRepoConfig(tempDir);
    expect(config.worktree?.copy).toEqual([".envrc"]);
    expect(config.worktree?.setup).toBeUndefined();
  });

  it("handles partial worktree config -- setup only", () => {
    writeFileSync(join(tempDir, ".ark.yaml"), ["worktree:", '  setup: "make deps"'].join("\n"));

    const config = loadRepoConfig(tempDir);
    expect(config.worktree?.setup).toBe("make deps");
    expect(config.worktree?.copy).toBeUndefined();
  });
});
