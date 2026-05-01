/**
 * Tests for `pollInlineExecutorUntilTerminal`.
 *
 * Pulled out of `dispatchInlineSubStage` so the polling-loop terminal-state
 * mapping (running -> keep polling, completed -> ok, failed -> not-ok,
 * not_found -> not-ok) is unit-testable without standing up a full
 * dispatch pipeline.
 *
 * Pass-4 silent-failure remediation: previously a `not_found` from
 * `executor.status` was silently mapped to `agentExitOk = true`. That was
 * a real failure mode (handle never registered, or cleaned up before we
 * could observe a terminal state) being treated as success. This test
 * locks in the new behaviour: not_found -> agentExitOk = false.
 */

import { describe, it, expect } from "bun:test";
import { pollInlineExecutorUntilTerminal } from "../dispatch/inline-substage.js";

function makeStaticStatusExecutor(state: string) {
  return {
    async status(_handle: string) {
      return { state };
    },
  };
}

const noSleep = async () => {};

describe("pollInlineExecutorUntilTerminal", () => {
  it("treats `completed` as ok=true, exitOk=true", async () => {
    const out = await pollInlineExecutorUntilTerminal(makeStaticStatusExecutor("completed"), "h", {
      pollMs: 0,
      timeoutMs: 1000,
      sleep: noSleep,
    });
    expect(out).toEqual({ agentOk: true, agentExitOk: true });
  });

  it("treats `failed` as ok=true, exitOk=false", async () => {
    const out = await pollInlineExecutorUntilTerminal(makeStaticStatusExecutor("failed"), "h", {
      pollMs: 0,
      timeoutMs: 1000,
      sleep: noSleep,
    });
    expect(out).toEqual({ agentOk: true, agentExitOk: false });
  });

  it("treats `not_found` as ok=true, exitOk=false (was a silent-success path)", async () => {
    // Pass-4 fix: this previously returned { agentOk: true, agentExitOk: true }.
    // not_found is a real failure mode -- the executor has no record of the
    // handle -- and should not be papered over as success.
    const out = await pollInlineExecutorUntilTerminal(makeStaticStatusExecutor("not_found"), "h", {
      pollMs: 0,
      timeoutMs: 1000,
      sleep: noSleep,
    });
    expect(out).toEqual({ agentOk: true, agentExitOk: false });
  });

  it("returns ok=false on deadline (no terminal state observed)", async () => {
    const exec = makeStaticStatusExecutor("running");
    const out = await pollInlineExecutorUntilTerminal(exec, "h", {
      pollMs: 1,
      timeoutMs: 5,
      sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    });
    expect(out).toEqual({ agentOk: false, agentExitOk: true });
  });

  it("polls through `running` then exits on terminal `completed`", async () => {
    let calls = 0;
    const exec = {
      async status(_handle: string) {
        calls += 1;
        return { state: calls < 3 ? "running" : "completed" };
      },
    };
    const out = await pollInlineExecutorUntilTerminal(exec, "h", { pollMs: 0, timeoutMs: 1000, sleep: noSleep });
    expect(out).toEqual({ agentOk: true, agentExitOk: true });
    expect(calls).toBe(3);
  });
});
