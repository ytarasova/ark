/**
 * RemoteProcessRunner adapter -- stub.
 *
 * Control-plane process runner that dispatches sub-process work over SSH via
 * the existing pool. Slice 1 migration.
 */

import type { ProcessRunner, RunOpts, RunResult } from "../../ports/process-runner.js";

const NOT_MIGRATED = new Error("RemoteProcessRunner: not migrated yet -- Slice 1");

export class RemoteProcessRunner implements ProcessRunner {
  async run(_cmd: string, _args: string[], _opts?: RunOpts): Promise<RunResult> {
    throw NOT_MIGRATED;
  }
  runSync(_cmd: string, _args: string[], _opts?: RunOpts): RunResult {
    throw NOT_MIGRATED;
  }
}
