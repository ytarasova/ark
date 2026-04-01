import { describe, it, expect } from "bun:test";
import { execFileSync } from "child_process";

const ark = (args: string) => execFileSync("bun", ["packages/cli/index.ts", ...args.split(" ")], {
  encoding: "utf-8",
  timeout: 10_000,
  cwd: "/Users/yana/Projects/ark",
}).trim();

describe("ark skill CLI", () => {
  it("lists skills", () => {
    const output = ark("skill list");
    expect(output).toContain("code-review");
    expect(output).toContain("test-writing");
  });

  it("shows a skill", () => {
    const output = ark("skill show code-review");
    expect(output).toContain("code-review");
    expect(output).toContain("Review");
  });
});

describe("ark recipe CLI", () => {
  it("lists recipes", () => {
    const output = ark("recipe list");
    expect(output).toContain("quick-fix");
    expect(output).toContain("feature-build");
  });

  it("shows a recipe", () => {
    const output = ark("recipe show quick-fix");
    expect(output).toContain("quick-fix");
    expect(output).toContain("bare");
  });
});
