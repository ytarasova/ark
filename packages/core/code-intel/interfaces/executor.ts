/**
 * BinaryExecutor -- how extractors run an external tool.
 *
 * Local mode: direct subprocess (spawn the binary on disk).
 * Control-plane mode: RPC to an arkd worker that runs the binary in its
 *   container image, streams output back. Same interface, different impl.
 *
 * Extractors MUST go through this; they must not call `spawn` / `exec`
 * directly. That's the layering rule that lets control-plane execute
 * binaries remotely without any extractor code change.
 *
 * Example (local):
 *   const res = await deployment.executor.run("syft", ["scan", repoPath, "-o", "cyclonedx-json"]);
 *   if (res.exitCode !== 0) throw new Error(res.stderr);
 *   return JSON.parse(res.stdout);
 */

export interface BinaryRunOptions {
  /** Working directory (local) / workspace path on the remote (control-plane). */
  cwd?: string;
  /** Env vars merged on top of the process / remote env. */
  env?: Record<string, string>;
  /** Stdin payload. */
  stdin?: string | Buffer;
  /** Timeout in ms. Defaults to 60_000. */
  timeoutMs?: number;
}

export interface BinaryRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface BinaryExecutor {
  /** Run a vendored binary by name and return its captured output. */
  run(tool: string, args: ReadonlyArray<string>, opts?: BinaryRunOptions): Promise<BinaryRunResult>;
}
