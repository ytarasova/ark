/**
 * Real-filesystem regression: when `ark` is invoked via a PATH symlink
 * (which is the canonical install layout — `~/.local/bin/ark` ->
 * `~/.local/ark/bin/ark`), `process.execPath` reflects the symlink, not
 * the underlying binary. The install-prefix marker check must resolve
 * symlinks before walking up to find `flows/definitions`, otherwise the
 * detection thinks the binary is in dev mode and the agent-sdk launcher
 * tries to spawn `ark <repo>/packages/core/runtimes/agent-sdk/launch.ts`
 * — which exits 1 immediately with "unknown command".
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveInstallPrefixWith, isCompiledBinaryWith } from "../install-paths.js";

function makeEnv(overrides: { execPath: string }) {
  return {
    execPath: overrides.execPath,
    sourceUrl: "file:///dev-mode-irrelevant",
    existsCheck: (p: string) => {
      try {
        statSync(p);
        return true;
      } catch {
        return false;
      }
    },
  };
}

describe("resolveInstallPrefixWith -- symlinked execPath", () => {
  test("resolves prefix correctly when ark is invoked via a PATH symlink", () => {
    // Lay out a fake install:
    //   /tmp/<rand>/install/bin/ark              <-- the real binary
    //   /tmp/<rand>/install/flows/definitions/   <-- the marker
    //   /tmp/<rand>/path/ark   ->                 <-- symlink in PATH
    const root = mkdtempSync(join(tmpdir(), "ark-install-prefix-test-"));
    const installRoot = join(root, "install");
    mkdirSync(join(installRoot, "bin"), { recursive: true });
    mkdirSync(join(installRoot, "flows", "definitions"), { recursive: true });
    const realBinary = join(installRoot, "bin", "ark");
    writeFileSync(realBinary, "#!/bin/sh\nexit 0\n");

    const pathDir = join(root, "path");
    mkdirSync(pathDir, { recursive: true });
    const symlinkBinary = join(pathDir, "ark");
    symlinkSync(realBinary, symlinkBinary);

    // Pre-fix: looking up `flows/definitions` from `<symlink>/..` lands at
    // `/tmp/<rand>/path/flows/definitions` -- which doesn't exist. The
    // detector wrongly returns null and the binary thinks it's in dev mode.
    const env = makeEnv({ execPath: symlinkBinary });
    const prefix = resolveInstallPrefixWith(env);
    expect(prefix).not.toBeNull();
    expect(prefix).toContain(installRoot.replace(/\/private\//, "/")); // macOS /private/tmp -> /tmp realpath
    expect(isCompiledBinaryWith(env)).toBe(true);
  });

  test("still resolves when execPath is the real path directly", () => {
    const root = mkdtempSync(join(tmpdir(), "ark-install-prefix-test-"));
    const installRoot = join(root, "install");
    mkdirSync(join(installRoot, "bin"), { recursive: true });
    mkdirSync(join(installRoot, "flows", "definitions"), { recursive: true });
    const realBinary = join(installRoot, "bin", "ark");
    writeFileSync(realBinary, "#!/bin/sh\nexit 0\n");

    const env = makeEnv({ execPath: realBinary });
    const prefix = resolveInstallPrefixWith(env);
    expect(prefix).not.toBeNull();
    expect(isCompiledBinaryWith(env)).toBe(true);
  });

  test("returns null when the marker is genuinely absent (true dev mode)", () => {
    const root = mkdtempSync(join(tmpdir(), "ark-install-prefix-test-"));
    const fakeBunDir = join(root, "bun");
    mkdirSync(fakeBunDir, { recursive: true });
    const fakeBun = join(fakeBunDir, "bun");
    writeFileSync(fakeBun, "#!/bin/sh\nexit 0\n");

    const env = makeEnv({ execPath: fakeBun });
    expect(resolveInstallPrefixWith(env)).toBeNull();
    expect(isCompiledBinaryWith(env)).toBe(false);
  });
});
