/**
 * Firecracker network-setup tests.
 *
 * We stub `ip` by dropping a shell script on PATH that records its argv to
 * a log file. Each test inspects the log to assert the correct sequence of
 * `ip` invocations. No real TAP/bridge is ever touched.
 *
 * Because PATH is process-scoped, we restore it in afterEach so tests don't
 * leak state.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { assignGuestIp, createTap, ensureBridge, removeTap } from "../core/firecracker/network.js";

const originalPath = process.env.PATH;

let sandbox: string;
let logPath: string;
let shimDir: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "fc-net-"));
  logPath = join(sandbox, "ip.log");
  shimDir = join(sandbox, "bin");
  mkdirSync(shimDir, { recursive: true });

  // Shell shim: append argv as a single newline-delimited record per
  // invocation, with a `---` line between records. We use printf with a
  // real literal tab (U+0009) as the separator to avoid \t-vs-literal
  // escaping ambiguity across /bin/sh implementations.
  //
  // The shim reads FC_TEST_FAIL_PATTERN to simulate ip failures for
  // idempotency tests; if the args match the pattern (using POSIX BRE via
  // grep), exit 2 and write a synthetic stderr line.
  const TAB = "\t";
  const shim =
    "#!/bin/sh\n" +
    "set -u\n" +
    'args="ip"\n' +
    'for a in "$@"; do args="$args' +
    TAB +
    '$a"; done\n' +
    `printf "%s\\n" "$args" >> "${logPath}"\n` +
    'if [ -n "${FC_TEST_FAIL_PATTERN:-}" ]; then\n' +
    '  if printf "%s" "$args" | grep -Eq "${FC_TEST_FAIL_PATTERN}"; then\n' +
    '    printf "%s\\n" "${FC_TEST_FAIL_STDERR:-RTNETLINK answers: File exists}" >&2\n' +
    "    exit 2\n" +
    "  fi\n" +
    "fi\n" +
    "exit 0\n";
  const ipShim = join(shimDir, "ip");
  writeFileSync(ipShim, shim);
  chmodSync(ipShim, 0o755);

  // Prepend so our stub wins even if the host has a real `ip`.
  process.env.PATH = `${shimDir}:${originalPath ?? ""}`;
  delete process.env.FC_TEST_FAIL_PATTERN;
  delete process.env.FC_TEST_FAIL_STDERR;
});

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.FC_TEST_FAIL_PATTERN;
  delete process.env.FC_TEST_FAIL_STDERR;
  rmSync(sandbox, { recursive: true, force: true });
});

/** Parse the log file into one array of argv per `ip` invocation. */
function readInvocations(): string[][] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t"));
}

describe("ensureBridge", () => {
  it("issues `ip link add ... type bridge` then `ip link set up`", async () => {
    await ensureBridge("arkbr-test");
    const invocations = readInvocations();
    expect(invocations.length).toBe(2);
    expect(invocations[0]).toEqual(["ip", "link", "add", "name", "arkbr-test", "type", "bridge"]);
    expect(invocations[1]).toEqual(["ip", "link", "set", "arkbr-test", "up"]);
  });

  it("tolerates `File exists` on bridge add (idempotent)", async () => {
    process.env.FC_TEST_FAIL_PATTERN = "link.*add.*type.*bridge";
    process.env.FC_TEST_FAIL_STDERR = "RTNETLINK answers: File exists";
    // Must not throw.
    await ensureBridge("arkbr-test");
    const invocations = readInvocations();
    // add failed, set still runs
    expect(invocations.length).toBe(2);
    expect(invocations[1]).toEqual(["ip", "link", "set", "arkbr-test", "up"]);
  });

  it("propagates unexpected errors from `ip link add`", async () => {
    process.env.FC_TEST_FAIL_PATTERN = "link.*add.*type.*bridge";
    process.env.FC_TEST_FAIL_STDERR = "Operation not permitted";
    await expect(ensureBridge("arkbr-test")).rejects.toThrow(/Operation not permitted/);
  });
});

describe("createTap", () => {
  it("adds tap, enslaves to bridge, brings up", async () => {
    await createTap("fc-abc", "arkbr-test");
    const invocations = readInvocations();
    expect(invocations).toEqual([
      ["ip", "tuntap", "add", "dev", "fc-abc", "mode", "tap"],
      ["ip", "link", "set", "fc-abc", "master", "arkbr-test"],
      ["ip", "link", "set", "fc-abc", "up"],
    ]);
  });
});

describe("removeTap", () => {
  it("issues `ip link delete`", async () => {
    await removeTap("fc-abc");
    const invocations = readInvocations();
    expect(invocations).toEqual([["ip", "link", "delete", "fc-abc"]]);
  });

  it("swallows `Cannot find device` for absent TAPs", async () => {
    process.env.FC_TEST_FAIL_PATTERN = "link.*delete";
    process.env.FC_TEST_FAIL_STDERR = "Cannot find device";
    await removeTap("fc-abc"); // must not throw
  });

  it("propagates other errors", async () => {
    process.env.FC_TEST_FAIL_PATTERN = "link.*delete";
    process.env.FC_TEST_FAIL_STDERR = "RTNETLINK answers: Operation not permitted";
    await expect(removeTap("fc-abc")).rejects.toThrow(/Operation not permitted/);
  });
});

describe("assignGuestIp", () => {
  it("returns a /30 pair and configures the host side", async () => {
    const addr = await assignGuestIp("fc-xyz");
    expect(addr.prefixLen).toBe(30);
    expect(addr.mask).toBe("255.255.255.252");
    expect(addr.hostIp).toMatch(/^192\.168\.127\.\d+$/);
    expect(addr.guestIp).toMatch(/^192\.168\.127\.\d+$/);

    // Host = block+1, guest = block+2, so guest = host + 1 and both are in
    // the same /30.
    const hostLastOctet = Number(addr.hostIp.split(".")[3]);
    const guestLastOctet = Number(addr.guestIp.split(".")[3]);
    expect(guestLastOctet).toBe(hostLastOctet + 1);
    expect(hostLastOctet % 4).toBe(1); // block+1 where block is multiple of 4

    // And `ip addr add` was called with the /30 on the tap.
    const invocations = readInvocations();
    expect(invocations[0]).toEqual(["ip", "addr", "add", `${addr.hostIp}/30`, "dev", "fc-xyz"]);
  });

  it("is idempotent on `File exists`", async () => {
    process.env.FC_TEST_FAIL_PATTERN = "addr.*add";
    process.env.FC_TEST_FAIL_STDERR = "RTNETLINK answers: File exists";
    const addr = await assignGuestIp("fc-idem");
    expect(addr.hostIp).toMatch(/^192\.168\.127\./);
  });

  it("is deterministic -- same name maps to same /30", async () => {
    const a = await assignGuestIp("fc-stable");
    // Fresh sandbox resets the log, but PATH/stub still work; reuse:
    const b = await assignGuestIp("fc-stable");
    expect(a.hostIp).toBe(b.hostIp);
    expect(a.guestIp).toBe(b.guestIp);
  });
});
