import { describe, it, expect } from "bun:test";
import { resolveWebDist } from "../hosted/web.js";

describe("resolveWebDist", () => {
  it("returns installed layout (execDir/../web) for a tarball install", () => {
    const result = resolveWebDist({
      execDir: "/home/user/.ark/bin",
      sourceDir: "/$bunfs/root/packages/core/hosted",
      existsCheck: (p) => p === "/home/user/.ark/web",
    });
    expect(result).toBe("/home/user/.ark/web");
  });

  it("returns source-tree layout when running from source", () => {
    const result = resolveWebDist({
      execDir: "/home/user/.bun/bin",
      sourceDir: "/repo/packages/core/hosted",
      existsCheck: (p) => p === "/repo/packages/web/dist",
    });
    expect(result).toBe("/repo/packages/web/dist");
  });

  it("prefers installed layout over source layout when both exist", () => {
    const result = resolveWebDist({
      execDir: "/home/user/.ark/bin",
      sourceDir: "/repo/packages/core/hosted",
      existsCheck: () => true,
    });
    expect(result).toBe("/home/user/.ark/web");
  });

  it("falls back to installed layout when no candidate exists", () => {
    const result = resolveWebDist({
      execDir: "/home/user/.ark/bin",
      sourceDir: "/repo/packages/core/hosted",
      existsCheck: () => false,
    });
    expect(result).toBe("/home/user/.ark/web");
  });
});
