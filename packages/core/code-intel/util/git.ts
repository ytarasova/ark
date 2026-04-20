/**
 * git utility -- Bun.spawnSync wrapper around `git`.
 *
 * Uses argv (not a shell command) so caller-supplied paths can never be
 * interpreted as shell metacharacters. All callers in this package go
 * through here.
 */

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function runGit(cwd: string, args: string[]): GitResult {
  try {
    const proc = Bun.spawnSync({
      cmd: ["git", ...args],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = proc.stdout?.toString() ?? "";
    const stderr = proc.stderr?.toString() ?? "";
    const exitCode = proc.exitCode ?? -1;
    return { ok: exitCode === 0, stdout, stderr, exitCode };
  } catch (err: any) {
    return { ok: false, stdout: "", stderr: err?.message ?? String(err), exitCode: -1 };
  }
}
