import { describe, it, expect } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { withTestContext } from "../../core/__tests__/test-helpers.js";

describe("tool sync paths", () => {
  const { getCtx } = withTestContext();

  it("identifies syncable tool directories", () => {
    const dir = getCtx().arkDir;
    const projectDir = join(dir, "project");
    mkdirSync(join(projectDir, ".claude", "commands"), { recursive: true });
    mkdirSync(join(projectDir, ".claude", "skills"), { recursive: true });
    writeFileSync(join(projectDir, ".claude", "commands", "deploy.md"), "# Deploy\nRun deploy script");
    writeFileSync(join(projectDir, ".claude", "skills", "review.md"), "# Review\nReview code");
    writeFileSync(join(projectDir, "CLAUDE.md"), "# Project\nContext here");

    expect(existsSync(join(projectDir, ".claude", "commands"))).toBe(true);
    expect(existsSync(join(projectDir, ".claude", "skills"))).toBe(true);
    expect(existsSync(join(projectDir, "CLAUDE.md"))).toBe(true);
  });
});
