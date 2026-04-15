import { describe, it, expect } from "bun:test";
import {
  resolveWebDistWith,
  resolveStoreBaseDirWith,
  resolveInstallPrefixWith,
  isCompiledBinaryWith,
  channelLaunchSpecWith,
  type ResolveEnv,
} from "../install-paths.js";

function makeEnv(overrides: Partial<ResolveEnv>): ResolveEnv {
  return {
    execPath: "/unused",
    sourceUrl: "file:///repo/packages/core/install-paths.ts",
    existsCheck: () => false,
    ...overrides,
  };
}

describe("resolveWebDistWith", () => {
  it("returns installed layout when <prefix>/web/index.html exists", () => {
    const env = makeEnv({
      execPath: "/home/user/.ark/bin/ark",
      existsCheck: (p) => p === "/home/user/.ark/flows/definitions" || p === "/home/user/.ark/web/index.html",
    });
    expect(resolveWebDistWith(env)).toBe("/home/user/.ark/web");
  });

  it("returns source-tree layout when running from source", () => {
    const env = makeEnv({
      execPath: "/home/user/.bun/bin/bun",
      sourceUrl: "file:///repo/packages/core/install-paths.ts",
      existsCheck: (p) => p === "/repo/packages/web/dist",
    });
    expect(resolveWebDistWith(env)).toBe("/repo/packages/web/dist");
  });

  it("prefers installed layout over source layout when both would match", () => {
    const env = makeEnv({
      execPath: "/home/user/.ark/bin/ark",
      sourceUrl: "file:///repo/packages/core/install-paths.ts",
      existsCheck: () => true,
    });
    expect(resolveWebDistWith(env)).toBe("/home/user/.ark/web");
  });

  it("falls back to installed layout path when nothing exists", () => {
    const env = makeEnv({
      execPath: "/home/user/.ark/bin/ark",
      sourceUrl: "file:///repo/packages/core/install-paths.ts",
      existsCheck: (p) => p === "/home/user/.ark/flows/definitions",
    });
    // flows/definitions exists but web/index.html doesn't -- prefix detected,
    // fallback returns the installed-layout path for error clarity.
    expect(resolveWebDistWith(env)).toBe("/home/user/.ark/web");
  });
});

describe("resolveStoreBaseDirWith", () => {
  it("returns install prefix when <prefix>/flows/definitions exists", () => {
    const env = makeEnv({
      execPath: "/home/user/.ark/bin/ark",
      existsCheck: (p) => p === "/home/user/.ark/flows/definitions",
    });
    expect(resolveStoreBaseDirWith(env)).toBe("/home/user/.ark");
  });

  it("falls back to source repo root in dev mode", () => {
    const env = makeEnv({
      execPath: "/home/user/.bun/bin/bun",
      sourceUrl: "file:///repo/packages/core/install-paths.ts",
      existsCheck: () => false,
    });
    expect(resolveStoreBaseDirWith(env)).toBe("/repo");
  });
});

describe("resolveInstallPrefixWith", () => {
  it("returns null when the marker dir does not exist", () => {
    const env = makeEnv({
      execPath: "/home/user/.bun/bin/bun",
      existsCheck: () => false,
    });
    expect(resolveInstallPrefixWith(env)).toBeNull();
  });

  it("returns the prefix when the marker dir exists", () => {
    const env = makeEnv({
      execPath: "/home/user/.ark/bin/ark",
      existsCheck: (p) => p === "/home/user/.ark/flows/definitions",
    });
    expect(resolveInstallPrefixWith(env)).toBe("/home/user/.ark");
  });
});

describe("isCompiledBinaryWith", () => {
  it("true when install prefix is detectable", () => {
    const env = makeEnv({
      execPath: "/home/user/.ark/bin/ark",
      existsCheck: (p) => p === "/home/user/.ark/flows/definitions",
    });
    expect(isCompiledBinaryWith(env)).toBe(true);
  });

  it("false in dev mode", () => {
    const env = makeEnv({
      execPath: "/home/user/.bun/bin/bun",
      existsCheck: () => false,
    });
    expect(isCompiledBinaryWith(env)).toBe(false);
  });
});

describe("channelLaunchSpecWith", () => {
  it("compiled mode self-spawns with 'channel' subcommand", () => {
    const env = makeEnv({
      execPath: "/home/user/.ark/bin/ark",
      existsCheck: (p) => p === "/home/user/.ark/flows/definitions",
    });
    const spec = channelLaunchSpecWith(env);
    expect(spec.command).toBe("/home/user/.ark/bin/ark");
    expect(spec.args).toEqual(["channel"]);
  });

  it("dev mode spawns bun runtime with source path + 'channel'", () => {
    const env = makeEnv({
      execPath: "/home/user/.bun/bin/bun",
      sourceUrl: "file:///repo/packages/core/install-paths.ts",
      existsCheck: () => false,
    });
    const spec = channelLaunchSpecWith(env);
    expect(spec.command).toBe("/home/user/.bun/bin/bun");
    expect(spec.args).toEqual(["/repo/packages/cli/index.ts", "channel"]);
  });
});
