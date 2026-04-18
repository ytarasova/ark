/**
 * MockProcessRunner adapter -- stub.
 *
 * Slice 1: returns pre-configured `RunResult`s for unit tests and records
 * every call for assertion (`runner.calls`).
 */

import type { ProcessRunner, RunOpts, RunResult } from "../../ports/process-runner.js";

const NOT_MIGRATED = new Error("MockProcessRunner: not migrated yet -- Slice 1");

export class MockProcessRunner implements ProcessRunner {
  async run(_cmd: string, _args: string[], _opts?: RunOpts): Promise<RunResult> {
    throw NOT_MIGRATED;
  }
  runSync(_cmd: string, _args: string[], _opts?: RunOpts): RunResult {
    throw NOT_MIGRATED;
  }
}
