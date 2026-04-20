/**
 * Integration test for the PTY geometry sentinel handshake in the claude
 * launcher script.
 *
 * Strategy: generate the launcher via `buildLauncher`, swap out the claude
 * invocation with a `printf` that dumps COLUMNS/LINES + sentinel state, then
 * run the script with `bash` and verify the exported geometry matches:
 *   - the sentinel when present before launch
 *   - the sentinel when the bridge writes it during the wait window
 *   - the 120x50 fallback when no sentinel ever arrives
 *   - the 120x50 fallback when the sentinel content is malformed
 *
 * We only exercise the bash preamble -- we do not actually run `claude`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildLauncher } from "../claude/claude.js";

/**
 * Turn a real `buildLauncher` script into a standalone bash harness that:
 *  - keeps the PATH / env / geometry preamble intact
 *  - replaces the `if claude ...` body with an `echo` so we don't need the
 *    claude binary on PATH
 *  - strips the trailing `exec bash` so the script exits after printing
 */
function buildHarness(sessionDir: string): string {
  const { content } = buildLauncher({
    workdir: sessionDir, // cd target; any writable dir works
    claudeArgs: ["claude"],
    mcpConfigPath: join(sessionDir, ".mcp.json"),
  });

  // Replace the whole `if claude ...` block with a marker echo.
  // The `if claude ...` invocation takes multiple lines; match from `if claude`
  // through the matching `fi`.
  const withoutClaude = content.replace(/if claude[\s\S]*?\nfi/, 'echo "COLUMNS=$COLUMNS LINES=$LINES"');

  // `exec bash` at the end would hang forever; drop it.
  const withoutExecBash = withoutClaude.replace(/\nexec bash\s*\n?$/, "\n");

  return withoutExecBash;
}

async function runHarness(script: string, env: Record<string, string>): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["bash", "-c", script],
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "ark-launcher-geom-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("launcher geometry sentinel -- integration", () => {
  it("reads COLUMNS/LINES from the sentinel when it exists before launch", async () => {
    writeFileSync(join(workDir, "geometry"), "180 55\n");
    const script = buildHarness(workDir);
    const out = await runHarness(script, { ARK_SESSION_DIR: workDir });
    expect(out).toBe("COLUMNS=180 LINES=55");
  });

  it("waits for the sentinel when it arrives during the wait window", async () => {
    const script = buildHarness(workDir);
    // Race: start the harness, then drop the sentinel ~100ms in. The
    // launcher polls every 50ms for up to 500ms so this lands comfortably.
    const proc = Bun.spawn({
      cmd: ["bash", "-c", script],
      env: { ...process.env, ARK_SESSION_DIR: workDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    await Bun.sleep(100);
    writeFileSync(join(workDir, "geometry"), "200 60\n");
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    expect(out).toBe("COLUMNS=200 LINES=60");
  });

  it("falls back to 120x50 when no sentinel ever arrives (CLI-only dispatch)", async () => {
    const script = buildHarness(workDir);
    const out = await runHarness(script, { ARK_SESSION_DIR: workDir });
    expect(out).toBe("COLUMNS=120 LINES=50");
  });

  it("falls back to 120x50 when the sentinel content is malformed", async () => {
    writeFileSync(join(workDir, "geometry"), "not a number\n");
    const script = buildHarness(workDir);
    const out = await runHarness(script, { ARK_SESSION_DIR: workDir });
    expect(out).toBe("COLUMNS=120 LINES=50");
  });

  it("falls back to 120x50 when the sentinel is empty", async () => {
    writeFileSync(join(workDir, "geometry"), "");
    const script = buildHarness(workDir);
    const out = await runHarness(script, { ARK_SESSION_DIR: workDir });
    expect(out).toBe("COLUMNS=120 LINES=50");
  });

  it("handles cols-only / rows-only partial writes by falling back", async () => {
    writeFileSync(join(workDir, "geometry"), "150\n");
    const script = buildHarness(workDir);
    const out = await runHarness(script, { ARK_SESSION_DIR: workDir });
    expect(out).toBe("COLUMNS=120 LINES=50");
  });

  it("rejects a sentinel with zero dims (0 x N or N x 0) and uses the fallback", async () => {
    // A COLS=0 export would break every TUI; the launcher validates both
    // dimensions are positive before committing.
    writeFileSync(join(workDir, "geometry"), "0 50\n");
    const script = buildHarness(workDir);
    const out = await runHarness(script, { ARK_SESSION_DIR: workDir });
    expect(out).toBe("COLUMNS=120 LINES=50");
  });
});
