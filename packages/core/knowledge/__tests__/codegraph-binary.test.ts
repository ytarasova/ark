import { describe, it, expect } from "bun:test";
import { findCodegraphBinary, isCodegraphInstalled } from "../indexer.js";
import { existsSync } from "fs";

describe("findCodegraphBinary", () => {
  it("finds codegraph in node_modules/.bin", () => {
    const bin = findCodegraphBinary();
    // After bun install, codegraph should be in node_modules/.bin
    expect(typeof bin).toBe("string");
    expect(bin.length).toBeGreaterThan(0);
  });

  it("returns a path that exists on disk", () => {
    const bin = findCodegraphBinary();
    // If it found a local binary, it should exist
    if (bin !== "codegraph") {
      expect(existsSync(bin)).toBe(true);
    }
  });
});

describe("isCodegraphInstalled", () => {
  it("returns true when codegraph binary is available", () => {
    // codegraph is installed as a dependency
    const result = isCodegraphInstalled();
    expect(result).toBe(true);
  });
});
