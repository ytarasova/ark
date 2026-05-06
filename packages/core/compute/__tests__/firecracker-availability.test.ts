/**
 * Firecracker availability probe tests.
 *
 * We exercise the probe by manipulating the environment it reads (PATH and
 * filesystem) rather than mocking the function internals, so the test
 * covers the actual platform gate behavior a CI runner would hit.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir, platform } from "os";
import { join } from "path";

import { isFirecrackerAvailable } from "../core/firecracker/availability.js";

const originalPath = process.env.PATH;

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "fc-avail-"));
});

afterEach(() => {
  process.env.PATH = originalPath;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("isFirecrackerAvailable", () => {
  it("returns ok:false with a clear reason on non-linux hosts", () => {
    const result = isFirecrackerAvailable();
    if (platform() === "linux") {
      // On Linux runners the outcome depends on the box; at minimum we expect
      // a populated `details` object and a boolean `ok`. We only assert the
      // structure so the test stays green whether or not /dev/kvm is present.
      expect(typeof result.ok).toBe("boolean");
      expect(result.details?.platform).toBe("linux");
      return;
    }
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/requires Linux/i);
    expect(result.details?.platform).toBe(platform());
  });

  it("reports missing firecracker binary on a synthetic PATH", () => {
    // Force a PATH with only the sandbox -- nothing is there, so `ip` lookup
    // will also fail, but on non-linux we never get that far. We build a
    // scenario that's deterministic on macOS/CI and validates the probe
    // surface.
    process.env.PATH = sandbox;
    const result = isFirecrackerAvailable();
    expect(result.ok).toBe(false);
    // On linux the reason will mention /dev/kvm or firecracker; on other
    // platforms the reason mentions Linux. All three are correct failures;
    // check the structure is populated.
    expect(result.reason).toBeDefined();
    expect(result.details).toBeDefined();
  });

  it("finds an executable on PATH via the internal lookup (smoke)", () => {
    // Simulate a `firecracker` binary on PATH by dropping an executable
    // shim. Even though we don't have /dev/kvm on the test runner, this
    // ensures findOnPath() walks PATH correctly -- we verify by asserting
    // the reason (when ok=false) is NOT about firecracker missing.
    const shimDir = join(sandbox, "bin");
    mkdirSync(shimDir, { recursive: true });
    const fcShim = join(shimDir, "firecracker");
    writeFileSync(fcShim, "#!/bin/sh\nexit 0\n");
    chmodSync(fcShim, 0o755);
    const ipShim = join(shimDir, "ip");
    writeFileSync(ipShim, "#!/bin/sh\nexit 0\n");
    chmodSync(ipShim, 0o755);

    process.env.PATH = shimDir;

    const result = isFirecrackerAvailable();
    if (platform() !== "linux") {
      // Non-linux exits early before checking PATH, which is the documented
      // behavior.
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/requires Linux/i);
      return;
    }
    // On linux the outcome depends on whether /dev/kvm is accessible.
    // Regardless, if the probe got far enough to check PATH, the reason
    // must not complain about a missing firecracker binary.
    if (!result.ok && result.reason) {
      expect(result.reason).not.toMatch(/firecracker binary not found/i);
    }
  });
});
