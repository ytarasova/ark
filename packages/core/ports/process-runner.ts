/**
 * ProcessRunner port -- abstracts sub-process execution.
 *
 * Owner: session bounded context.
 *
 * Replaces ad-hoc spawn / execFile / Bun.spawn calls scattered through
 * `session-lifecycle.ts`, `stage-orchestrator.ts`, and `services/worktree/*`.
 *
 * Local binding: `LocalProcessRunner` (thin wrapper around Bun.spawn).
 * Control-plane binding: `RemoteProcessRunner` (SSH via the existing pool).
 * Test binding: `MockProcessRunner` returning pre-configured results.
 *
 * All adapters MUST pass args as an array (execFile-style) -- never
 * concatenate user input into a shell string.
 */

export interface RunOpts {
  cwd?: string;
  env?: Record<string, string>;
  /** Milliseconds before SIGKILL. Omit for no timeout. */
  timeout?: number;
  /** If provided, stdin data is fed once then closed. */
  stdin?: string | Uint8Array;
  /** Stream stdout line-by-line (optional). */
  onStdout?: (chunk: string) => void;
  /** Stream stderr line-by-line (optional). */
  onStderr?: (chunk: string) => void;
}

export interface RunResult {
  /** Numeric exit code. Null if killed by signal. */
  exitCode: number | null;
  /** Full stdout captured. Empty string if streaming consumed it. */
  stdout: string;
  /** Full stderr captured. Empty string if streaming consumed it. */
  stderr: string;
  /** Wall-clock duration in ms. */
  durationMs: number;
}

export interface ProcessRunner {
  /**
   * Run a command asynchronously. Rejects only on spawn failure, never on
   * non-zero exit -- callers inspect `exitCode`.
   */
  run(cmd: string, args: string[], opts?: RunOpts): Promise<RunResult>;

  /**
   * Run a command synchronously. Present for parity with existing
   * execSync call sites; new code should prefer the async variant.
   */
  runSync(cmd: string, args: string[], opts?: RunOpts): RunResult;
}
