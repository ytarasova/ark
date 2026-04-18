/**
 * LocalProcessRunner adapter -- stub.
 *
 * In Slice 1 this will wrap `Bun.spawn` / `Bun.spawnSync` with execFile-style
 * arg arrays and the streaming callbacks defined in `RunOpts`.
 */

import type { ProcessRunner, RunOpts, RunResult } from "../../ports/process-runner.js";

const NOT_MIGRATED = new Error("LocalProcessRunner: not migrated yet -- Slice 1");

export class LocalProcessRunner implements ProcessRunner {
  async run(_cmd: string, _args: string[], _opts?: RunOpts): Promise<RunResult> {
    throw NOT_MIGRATED;
  }
  runSync(_cmd: string, _args: string[], _opts?: RunOpts): RunResult {
    throw NOT_MIGRATED;
  }
}
