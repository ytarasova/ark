/**
 * Deny-path tests for shell-injection through SSM SendCommand.
 *
 * Under the SSM-only transport, AWS-RunShellScript runs `bash -c "<cmd>"`
 * on the remote, which means unescaped user input is the same risk it was
 * with raw ssh. The fix mirrors the SSH-era pattern:
 *
 *   1. A `ssmExecArgs(...)` helper that shell-escapes every element before
 *      concatenation. Preferred for all argv-style calls.
 *   2. Remaining template-string `ssmExec(...)` sites pass every
 *      user-derived interpolant through `shellEscape()` before concatenation.
 *
 * These tests verify:
 *   - `shellEscape` quotes injection payloads into a single POSIX token.
 *   - `ssmExecArgs` validates and escapes its argv (the actual escaping is
 *     covered by `ec2-ssm.test.ts`; this file focuses on the validation
 *     branches and on call-site regression guards in sync.ts and
 *     docker-compose.ts).
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { shellEscape } from "../compute/ec2/shell-escape.js";
import { ssmExecArgs } from "../compute/ec2/ssm.js";

const ROOT = join(import.meta.dir, "..", "..", "..");

describe("shellEscape -- primitive sanity", () => {
  test("wraps benign value in single quotes", () => {
    expect(shellEscape("hello")).toBe("'hello'");
  });

  test("classic injection payload is fully quoted into one token", () => {
    const payload = "s-abc; rm -rf /";
    const escaped = shellEscape(payload);
    expect(escaped.startsWith("'")).toBe(true);
    expect(escaped.endsWith("'")).toBe(true);
    expect(escaped).toBe("'s-abc; rm -rf /'");
    const innards = escaped.slice(1, -1);
    expect(innards).toBe(payload);
  });

  test("embedded single-quote is escaped via the POSIX '\\'' sequence", () => {
    const payload = "foo'bar";
    const escaped = shellEscape(payload);
    expect(escaped).toBe("'foo'\\''bar'");
  });

  test("backtick + dollar stay quoted (no command substitution)", () => {
    const payload = "`whoami`$(id)";
    const escaped = shellEscape(payload);
    expect(escaped).toBe("'`whoami`$(id)'");
  });

  test("newline payload stays quoted", () => {
    const payload = "a\n; cat /etc/passwd";
    const escaped = shellEscape(payload);
    expect(escaped.startsWith("'")).toBe(true);
    expect(escaped.endsWith("'")).toBe(true);
  });
});

describe("ssmExecArgs -- argv-based remote exec validates inputs", async () => {
  test("rejects empty argv", async () => {
    await expect(ssmExecArgs({ instanceId: "i", region: "us-east-1", argv: [] })).rejects.toThrow(/non-empty/);
  });

  test("rejects non-string argv elements", async () => {
    await expect(
      // @ts-expect-error -- deliberately bad input
      ssmExecArgs({ instanceId: "i", region: "us-east-1", argv: ["mkdir", 123] }),
    ).rejects.toThrow(/must be strings/);
  });
});

describe("call-site regression guards -- user-derived vars never land unescaped", () => {
  test("sync.ts syncProjectFiles uses ssmExecArgs, not template-string mkdir", () => {
    const src = readFileSync(join(ROOT, "packages/core/compute/ec2/sync.ts"), "utf-8");
    // Old vulnerable patterns MUST be gone.
    expect(src).not.toMatch(/sshExec\([^)]*,\s*`mkdir -p \$\{remoteDir\}`/);
    expect(src).not.toMatch(/sshExec\([^)]*,\s*`mkdir -p \$\{remoteDir\}\/\$\{subdir\}`/);
    // Safe replacement MUST be present.
    expect(src).toMatch(/ssmExecArgs\([^)]*argv:\s*\[\s*"mkdir"\s*,\s*"-p"\s*,\s*remoteDir/);
  });

  test("sync.ts refreshRemoteToken shell-escapes the token", () => {
    const src = readFileSync(join(ROOT, "packages/core/compute/ec2/sync.ts"), "utf-8");
    // Old pattern (raw '${token}') must be gone.
    expect(src).not.toMatch(/CLAUDE_CODE_SESSION_ACCESS_TOKEN\s+'\$\{token\}'/);
    // Escaped pattern must be used.
    expect(src).toMatch(/shellEscape\(token\)/);
  });

  test("docker-compose isolation uses argv-form exec (no shell -c interpolation)", () => {
    const src = readFileSync(join(ROOT, "packages/core/compute/isolation/docker-compose.ts"), "utf-8");
    expect(src).not.toMatch(/sh\s+-c\s+`[^`]*\$\{/);
    expect(src).toMatch(/composeUpWithFiles/);
  });

  test("docker compose argv helpers exec docker with separated args (no shell)", () => {
    const src = readFileSync(join(ROOT, "packages/core/compute/isolation/compose.ts"), "utf-8");
    expect(src).not.toMatch(/sh\s+-c\s+`[^`]*\$\{/);
    expect(src).not.toMatch(/cd \$\{[a-zA-Z_]+\} && docker compose/);
    expect(src).toMatch(/execFileAsync\("docker",/);
  });
});
