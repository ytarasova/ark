/**
 * Integration tests for `ark token` subcommands.
 *
 * Spawns the CLI as a subprocess so we hit the real Commander wiring + the
 * real loadConfig() path (the latter is sensitive to ARK_DIR / ARK_PROFILE,
 * so the only honest way to exercise the show/rotate guards is end-to-end).
 *
 * Each test allocates a fresh ARK_DIR via mkdtempSync so the suite parallel-
 * runs cleanly.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let arkDir: string;

beforeEach(() => {
  arkDir = mkdtempSync(join(tmpdir(), "ark-token-test-"));
});

afterEach(() => {
  try {
    rmSync(arkDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const CLI_PATH = join(import.meta.dir, "..", "index.ts");

/** Spawn the CLI with the given args and return { code, stdout, stderr }. */
async function runCli(
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn({
    cmd: ["bun", CLI_PATH, ...args],
    env: {
      ...process.env,
      ARK_DIR: arkDir,
      // Force local-mode by default; tests that need hosted-mode override
      // ARK_PROFILE explicitly via extraEnv.
      ARK_PROFILE: "local",
      ARK_AUTH_REQUIRE_TOKEN: "false",
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe("ark token (local mode)", () => {
  test("`ark token` prints the on-disk token", async () => {
    writeFileSync(join(arkDir, "arkd.token"), "test-token-123\n", { mode: 0o600 });
    const { code, stdout } = await runCli(["token"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("test-token-123");
  });

  test("`ark token rotate` writes a new value atomically", async () => {
    writeFileSync(join(arkDir, "arkd.token"), "old-token\n", { mode: 0o600 });
    const { code } = await runCli(["token", "rotate"]);
    expect(code).toBe(0);

    const written = readFileSync(join(arkDir, "arkd.token"), "utf-8").trim();
    expect(written).not.toBe("old-token");
    expect(written.length).toBeGreaterThan(20);
    // Mode preserved at 0o600 -- the rotate path explicitly chmods after the
    // tmp-write to defeat umask stripping.
    const stat = statSync(join(arkDir, "arkd.token"));
    expect(stat.mode & 0o777).toBe(0o600);
    // No leftover .tmp file.
    expect(existsSync(join(arkDir, "arkd.token.tmp"))).toBe(false);
  });

  test("`ark token list` prints file metadata", async () => {
    writeFileSync(join(arkDir, "arkd.token"), "anything\n", { mode: 0o600 });
    const { code, stdout } = await runCli(["token", "list"]);
    expect(code).toBe(0);
    expect(stdout).toContain("local:");
    expect(stdout).toContain("arkd.token");
    expect(stdout).toContain("mode 0600");
  });

  test("`ark token` exits 1 when the file is missing", async () => {
    const { code, stderr } = await runCli(["token"]);
    expect(code).toBe(1);
    expect(stderr.toLowerCase()).toContain("no token");
  });
});

describe("ark token (hosted-mode guard)", () => {
  test("`ark token` refuses with a friendly error when auth.requireToken=true", async () => {
    writeFileSync(join(arkDir, "arkd.token"), "should-not-leak\n", { mode: 0o600 });
    const { code, stdout, stderr } = await runCli(["token"], {
      ARK_AUTH_REQUIRE_TOKEN: "true",
    });
    expect(code).toBe(1);
    // The token value must NEVER appear on stdout in hosted mode -- the
    // operator's master key is not an end-user credential.
    expect(stdout).not.toContain("should-not-leak");
    expect(stderr.toLowerCase()).toContain("hosted mode");
  });

  test("`ark token rotate` refuses in hosted mode", async () => {
    writeFileSync(join(arkDir, "arkd.token"), "stable\n", { mode: 0o600 });
    const { code, stderr } = await runCli(["token", "rotate"], {
      ARK_AUTH_REQUIRE_TOKEN: "true",
    });
    expect(code).toBe(1);
    expect(stderr.toLowerCase()).toContain("hosted mode");
    // File untouched.
    const after = readFileSync(join(arkDir, "arkd.token"), "utf-8").trim();
    expect(after).toBe("stable");
  });
});
