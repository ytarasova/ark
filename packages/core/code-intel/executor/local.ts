/**
 * LocalBinaryExecutor -- runs a vendored binary as a local subprocess.
 *
 * Resolves the binary path via VendorResolver, spawns via Bun's subprocess,
 * captures stdout / stderr / exit code. Used in local mode; replaced by
 * ArkdBinaryExecutor (RPC to arkd worker) in control-plane mode.
 */

import type { BinaryExecutor, BinaryRunOptions, BinaryRunResult } from "../interfaces/executor.js";
import type { VendorResolver } from "../interfaces/vendor.js";

const DEFAULT_TIMEOUT_MS = 60_000;

export class LocalBinaryExecutor implements BinaryExecutor {
  constructor(private readonly vendor: VendorResolver) {}

  async run(tool: string, args: ReadonlyArray<string>, opts: BinaryRunOptions = {}): Promise<BinaryRunResult> {
    const binary = this.vendor.locateBinary(tool);
    const started = Date.now();
    const proc = Bun.spawn([binary, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdin: (opts.stdin as any) ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeoutHandle = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already exited */
      }
    }, timeoutMs);

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timeoutHandle);

    return {
      exitCode,
      stdout,
      stderr,
      durationMs: Date.now() - started,
    };
  }
}
