import { describe, test, expect } from "bun:test";
import { sanitizeSummary, splitEditorCommand } from "../helpers.js";

describe("sanitizeSummary", () => {
  test("passes through clean names unchanged", () => {
    expect(sanitizeSummary("my-task")).toBe("my-task");
    expect(sanitizeSummary("fix_bug_123")).toBe("fix_bug_123");
  });

  test("replaces spaces and special chars with dashes", () => {
    expect(sanitizeSummary("Add auth module")).toBe("Add-auth-module");
    expect(sanitizeSummary("fix: login page")).toBe("fix-login-page");
  });

  test("collapses consecutive dashes", () => {
    expect(sanitizeSummary("a  b   c")).toBe("a-b-c");
    expect(sanitizeSummary("a--b")).toBe("a-b"); // consecutive dashes are collapsed
    expect(sanitizeSummary("a!!!b")).toBe("a-b");
  });

  test("strips leading and trailing dashes", () => {
    expect(sanitizeSummary("!hello!")).toBe("hello");
    expect(sanitizeSummary("  spaced  ")).toBe("spaced");
  });

  test("truncates to 60 characters", () => {
    const long = "a".repeat(100);
    expect(sanitizeSummary(long).length).toBe(60);
  });

  test("returns original if sanitized result is empty", () => {
    // When all chars are stripped and result is empty, falls back to raw
    expect(sanitizeSummary("")).toBe("");
    expect(sanitizeSummary("!!!")).toBe("!!!");
  });

  test("returns different value when sanitized (for warning detection)", () => {
    const raw = "Add auth module";
    const sanitized = sanitizeSummary(raw);
    expect(sanitized).not.toBe(raw);
    expect(sanitized).toBe("Add-auth-module");
  });

  test("returns same value for already-clean input", () => {
    const raw = "my-task";
    expect(sanitizeSummary(raw)).toBe(raw);
  });
});

describe("splitEditorCommand", () => {
  test("splits simple editor name", () => {
    const result = splitEditorCommand("vi");
    expect(result.command).toBe("vi");
    expect(result.args).toEqual([]);
  });

  test("splits editor with flags", () => {
    const result = splitEditorCommand("code --wait");
    expect(result.command).toBe("code");
    expect(result.args).toEqual(["--wait"]);
  });

  test("splits editor with multiple flags", () => {
    const result = splitEditorCommand("emacs -nw --no-splash");
    expect(result.command).toBe("emacs");
    expect(result.args).toEqual(["-nw", "--no-splash"]);
  });

  test("handles extra whitespace", () => {
    const result = splitEditorCommand("code   --wait");
    expect(result.command).toBe("code");
    expect(result.args).toEqual(["--wait"]);
  });

  test("can be used safely with execFileSync pattern", () => {
    const editor = "code --wait";
    const configPath = "/tmp/config.yaml";
    const { command, args } = splitEditorCommand(editor);
    // Verify the args array that would be passed to execFileSync
    const fullArgs = [...args, configPath];
    expect(command).toBe("code");
    expect(fullArgs).toEqual(["--wait", "/tmp/config.yaml"]);
  });
});

describe("forkCloneHandler deduplication", () => {
  test("fork and clone share the same handler (verified by source)", async () => {
    // We verify the deduplication by reading the source and confirming
    // both commands reference the same function name
    const { readFileSync } = await import("fs");
    const { join, dirname } = await import("path");
    const { fileURLToPath } = await import("url");

    const cliDir = join(dirname(fileURLToPath(import.meta.url)), "..");
    const source = readFileSync(join(cliDir, "index.ts"), "utf-8");

    // Both fork and clone should use .action(forkCloneHandler)
    const forkMatch = source.match(/session\.command\("fork"\)[\s\S]*?\.action\((\w+)\)/);
    const cloneMatch = source.match(/session\.command\("clone"\)[\s\S]*?\.action\((\w+)\)/);

    expect(forkMatch).toBeTruthy();
    expect(cloneMatch).toBeTruthy();
    expect(forkMatch![1]).toBe("forkCloneHandler");
    expect(cloneMatch![1]).toBe("forkCloneHandler");
    expect(forkMatch![1]).toBe(cloneMatch![1]);
  });
});
