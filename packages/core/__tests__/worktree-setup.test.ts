import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { copyWorktreeFiles, runWorktreeSetup } from "../services/session-orchestration.js";

let sourceDir: string;
let worktreeDir: string;

beforeEach(() => {
  sourceDir = mkdtempSync(join(tmpdir(), "ark-wt-src-"));
  worktreeDir = mkdtempSync(join(tmpdir(), "ark-wt-dst-"));
});

afterEach(() => {
  rmSync(sourceDir, { recursive: true, force: true });
  rmSync(worktreeDir, { recursive: true, force: true });
});

describe("copyWorktreeFiles", async () => {
  it("copies matching untracked files", async () => {
    writeFileSync(join(sourceDir, ".env"), "SECRET=abc");
    mkdirSync(join(sourceDir, "config"), { recursive: true });
    writeFileSync(join(sourceDir, "config", "local.yaml"), "key: value");

    const copied = await copyWorktreeFiles(sourceDir, worktreeDir, [".env", "config/*.yaml"]);

    expect(copied).toContain(".env");
    expect(copied).toContain("config/local.yaml");
    expect(readFileSync(join(worktreeDir, ".env"), "utf-8")).toBe("SECRET=abc");
    expect(readFileSync(join(worktreeDir, "config", "local.yaml"), "utf-8")).toBe("key: value");
  });

  it("skips files that already exist in worktree", async () => {
    writeFileSync(join(sourceDir, ".env"), "SOURCE_CONTENT");
    writeFileSync(join(worktreeDir, ".env"), "EXISTING_CONTENT");

    const copied = await copyWorktreeFiles(sourceDir, worktreeDir, [".env"]);

    expect(copied).toEqual([]);
    expect(readFileSync(join(worktreeDir, ".env"), "utf-8")).toBe("EXISTING_CONTENT");
  });

  it("handles nested glob patterns", async () => {
    mkdirSync(join(sourceDir, "config", "sub"), { recursive: true });
    writeFileSync(join(sourceDir, "config", "a.yaml"), "a");
    writeFileSync(join(sourceDir, "config", "sub", "b.yaml"), "b");

    const copied = await copyWorktreeFiles(sourceDir, worktreeDir, ["config/**/*.yaml"]);

    expect(copied).toContain("config/a.yaml");
    expect(copied).toContain("config/sub/b.yaml");
    expect(readFileSync(join(worktreeDir, "config", "a.yaml"), "utf-8")).toBe("a");
    expect(readFileSync(join(worktreeDir, "config", "sub", "b.yaml"), "utf-8")).toBe("b");
  });

  it("rejects .. traversal patterns", async () => {
    writeFileSync(join(sourceDir, ".env"), "secret");

    const copied = await copyWorktreeFiles(sourceDir, worktreeDir, ["../../etc/passwd"]);

    expect(copied).toEqual([]);
  });

  it("handles no matches gracefully", async () => {
    const copied = await copyWorktreeFiles(sourceDir, worktreeDir, ["*.nonexistent"]);

    expect(copied).toEqual([]);
  });
});

describe("runWorktreeSetup", async () => {
  it("executes command in worktree directory", async () => {
    const logs: string[] = [];
    await runWorktreeSetup(worktreeDir, "echo hello > marker.txt", (msg) => logs.push(msg));

    expect(existsSync(join(worktreeDir, "marker.txt"))).toBe(true);
    expect(readFileSync(join(worktreeDir, "marker.txt"), "utf-8").trim()).toBe("hello");
  });

  it("is non-fatal on failure", async () => {
    const logs: string[] = [];
    await runWorktreeSetup(worktreeDir, "exit 1", (msg) => logs.push(msg));

    expect(logs.some((l) => l.includes("non-fatal"))).toBe(true);
  });
});
