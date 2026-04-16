import { describe, it, expect } from "bun:test";
import { extractBashCommands } from "../bash-utils.js";

describe("extractBashCommands", () => {
  it("extracts a simple command", () => {
    expect(extractBashCommands("pytest tests/")).toEqual(["pytest"]);
  });

  it("skips cd and extracts command after && chain", () => {
    expect(extractBashCommands("cd /tmp && npm test")).toEqual(["npm test"]);
  });

  it("extracts both sides of a pipe", () => {
    expect(extractBashCommands("cat file | grep error")).toEqual(["cat", "grep"]);
  });

  it("skips builtins entirely", () => {
    expect(extractBashCommands("cd /tmp")).toEqual([]);
  });

  it("collapses git subcommands", () => {
    expect(extractBashCommands("git push origin main")).toEqual(["git push"]);
  });

  it("collapses npm subcommands", () => {
    expect(extractBashCommands("npm run build")).toEqual(["npm run build"]);
  });

  it("returns empty array for empty string", () => {
    expect(extractBashCommands("")).toEqual([]);
  });

  it("handles semicolons as separators", () => {
    expect(extractBashCommands("make build; make test")).toEqual(["make", "make"]);
  });

  it("handles || separator", () => {
    expect(extractBashCommands("ls /tmp || echo fallback")).toEqual(["ls"]);
  });

  it("handles npx subcommands", () => {
    expect(extractBashCommands("npx vitest run")).toEqual(["npx vitest run"]);
  });
});
