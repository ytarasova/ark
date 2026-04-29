/**
 * Agent-sdk launch tests -- error, abort, and interrupt paths.
 *
 * Slice of the former `agent-sdk-launch.test.ts` covering result.is_error,
 * mid-stream exceptions, transient forward failures, and the abort/resume
 * flow driven by interventions.jsonl. Transcript-only behaviour lives in
 * `agent-sdk-launch-transcript.test.ts`; hook streaming lives in
 * `agent-sdk-launch-streaming.test.ts`.
 */

import { test, expect } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentSdkLaunch } from "../runtimes/agent-sdk/launch.js";
import type { SDKUserMessage } from "../runtimes/agent-sdk/launch.js";
import { makeTmpDir, makeFakeFetch, type FetchCall } from "./agent-sdk-launch-helpers.js";

test("exits 1 on error result", async () => {
  const dir = makeTmpDir();
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "hi");

  async function* fakeStream() {
    yield {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      total_cost_usd: 0.0001,
      num_turns: 0,
      usage: { input_tokens: 1, output_tokens: 0 },
      stop_reason: null,
      errors: ["boom"],
      duration_ms: 50,
      duration_api_ms: 50,
    } as any;
  }

  const result = await runAgentSdkLaunch({
    sessionId: "s2",
    sessionDir: dir,
    worktree: "/tmp",
    promptFile,
    stream: fakeStream(),
  });

  expect(result.exitCode).toBe(1);
  expect(result.sawResult).toBe(true);
});

test("exits 1 if stream ends without a result message", async () => {
  const dir = makeTmpDir();
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "hi");

  async function* fakeStream() {
    yield { type: "assistant", message: { content: [{ type: "text", text: "half done" }] } } as any;
  }

  const result = await runAgentSdkLaunch({
    sessionId: "s3",
    sessionDir: dir,
    worktree: "/tmp",
    promptFile,
    stream: fakeStream(),
  });

  expect(result.exitCode).toBe(1);
  expect(result.sawResult).toBe(false);

  const transcript = readFileSync(join(dir, "transcript.jsonl"), "utf8");
  const lines = transcript
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  // assistant message + synthetic error sentinel
  expect(lines).toHaveLength(2);
  expect(lines[1].type).toBe("error");
  expect(lines[1].source).toBe("launch");
});

test("exits 1 and writes error line when stream throws", async () => {
  const dir = makeTmpDir();
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "hi");

  async function* fakeStream() {
    yield { type: "assistant", message: { content: [{ type: "text", text: "..." }] } } as any;
    throw new Error("network timeout");
  }

  const result = await runAgentSdkLaunch({
    sessionId: "s4",
    sessionDir: dir,
    worktree: "/tmp",
    promptFile,
    stream: fakeStream(),
  });

  expect(result.exitCode).toBe(1);

  const transcript = readFileSync(join(dir, "transcript.jsonl"), "utf8");
  const lines = transcript
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const errorLine = lines.find((l) => l.type === "error");
  expect(errorLine).toBeDefined();
  expect(errorLine.message).toContain("network timeout");
});

test("forwards Stop then StopFailure with error details when result is an error", async () => {
  const calls: FetchCall[] = [];
  const dir = makeTmpDir();
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "hi");

  async function* stream() {
    yield {
      type: "result",
      subtype: "error_max_budget_usd",
      is_error: true,
      total_cost_usd: 1.5,
      num_turns: 5,
      usage: { input_tokens: 100, output_tokens: 50 },
      stop_reason: null,
      errors: ["budget exceeded"],
      duration_ms: 500,
      duration_api_ms: 490,
    } as any;
  }

  await runAgentSdkLaunch({
    sessionId: "ark-sess-4",
    sessionDir: dir,
    worktree: "/tmp",
    promptFile,
    stream: stream(),
    conductorUrl: "http://c:19100",
    fetchFn: makeFakeFetch(calls),
  });

  // Stop (observability) then StopFailure (drives state transition to "failed")
  expect(calls.length).toBe(2);
  expect(calls[0].body).toMatchObject({
    hook_event_name: "Stop",
    session_id: "ark-sess-4",
    is_error: true,
    subtype: "error_max_budget_usd",
    errors: ["budget exceeded"],
    total_cost_usd: 1.5,
  });
  expect(calls[1].body).toMatchObject({
    hook_event_name: "StopFailure",
    session_id: "ark-sess-4",
    subtype: "error_max_budget_usd",
    errors: ["budget exceeded"],
    total_cost_usd: 1.5,
    num_turns: 5,
  });
  expect(typeof calls[1].body.error).toBe("string");
  expect(calls[1].body.error).toBeTruthy();
});

test("forward errors are logged but do not crash the loop", async () => {
  const dir = makeTmpDir();
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "hi");

  const throwingFetch: typeof fetch = async () => {
    throw new Error("connection refused");
  };

  async function* stream() {
    yield { type: "system", subtype: "init", cwd: "/tmp" } as any;
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0,
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
      result: "ok",
      duration_ms: 10,
      duration_api_ms: 9,
    } as any;
  }

  // Should complete cleanly despite fetch throwing on every call
  const result = await runAgentSdkLaunch({
    sessionId: "ark-sess-6",
    sessionDir: dir,
    worktree: "/tmp",
    promptFile,
    stream: stream(),
    conductorUrl: "http://c:19100",
    fetchFn: throwingFetch,
  });

  expect(result.exitCode).toBe(0);
  expect(result.sawResult).toBe(true);
});

// ---------------------------------------------------------------------------
// D3: interrupt-resume flow via streamFactory + control flag
// ---------------------------------------------------------------------------

test("interrupt aborts current turn and resumes with correction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-sdk-interrupt-"));
  writeFileSync(join(dir, "prompt.txt"), "initial task");

  const queries: Array<{ options: Record<string, unknown> }> = [];
  let streamCallCount = 0;

  const streamFactory = (prompt: AsyncIterable<SDKUserMessage>, options: Record<string, unknown>) => {
    streamCallCount++;
    const callIndex = streamCallCount;
    queries.push({ options });
    return (async function* () {
      const iter = prompt[Symbol.asyncIterator]();

      if (callIndex === 1) {
        // Consume the initial prompt.
        await iter.next();

        // Simulate a long-running first turn. Write the interrupt signal to the
        // intervention file so the tail fires the abort callback. Then yield
        // system/init so sdkSessionId is captured before abort fires.
        yield {
          type: "system",
          subtype: "init",
          session_id: "sdk-test-1",
          cwd: "/tmp",
          tools: [],
          model: "sonnet",
          mcp_servers: [],
          permissionMode: "bypassPermissions",
          apiKeySource: "user",
          slash_commands: [],
          output_style: "default",
          uuid: "u0",
        } as any;

        // Write the interrupt to the interventions file. The tail will call
        // onInterrupt -> abortHolder.ref.abort() asynchronously.
        // Note: the tail starts polling at 200ms when the file doesn't exist yet.
        // We sleep 350ms to give the poll timer time to fire and process the line.
        appendFileSync(
          join(dir, "interventions.jsonl"),
          JSON.stringify({ role: "user", content: "stop, do X instead", control: "interrupt", ts: Date.now() }) + "\n",
        );

        // Wait long enough for the 200ms poll timer to fire and set interruptFlag.
        await Bun.sleep(350);

        // The abort signal should have fired. The for-await-of in drainStream
        // checks signal.aborted; if the SDK throws AbortError-like we propagate
        // to the catch block. Since we're in a pure test generator (no real SDK)
        // we simulate it by throwing ourselves.
        throw new DOMException("Aborted", "AbortError");
      }

      // Second call (resume turn): the correction "stop, do X instead" is
      // already in the queue (pushed by the tail's onMessage before onInterrupt).
      await iter.next(); // consumes "stop, do X instead"
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "ok, doing X" }] },
        session_id: "sdk-test-1",
        uuid: "u2",
        parent_tool_use_id: null,
      } as any;
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        total_cost_usd: 0.002,
        num_turns: 2,
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: "end_turn",
        result: "done",
        duration_ms: 200,
        duration_api_ms: 180,
        uuid: "u3",
        session_id: "sdk-test-1",
        modelUsage: {},
        permission_denials: [],
      } as any;
    })();
  };

  const result = await runAgentSdkLaunch({
    sessionId: "s-intr",
    sessionDir: dir,
    worktree: "/tmp",
    promptFile: join(dir, "prompt.txt"),
    streamFactory,
  });

  expect(result.exitCode).toBe(0);
  expect(result.sawResult).toBe(true);
  expect(streamCallCount).toBe(2);
  expect(queries[0].options.resume).toBeUndefined();
  expect(queries[1].options.resume).toBe("sdk-test-1");
});

test("interrupt without sdkSessionId captured still resumes (no crash)", async () => {
  // If the stream is interrupted before system/init is seen, sdkSessionId is
  // undefined and the resume option is omitted. This tests the loop doesn't
  // crash with undefined resume.
  const dir = mkdtempSync(join(tmpdir(), "agent-sdk-interrupt-nosdk-"));
  writeFileSync(join(dir, "prompt.txt"), "task");

  let callCount = 0;

  const streamFactory = (prompt: AsyncIterable<SDKUserMessage>, options: Record<string, unknown>) => {
    callCount++;
    const callIndex = callCount;
    return (async function* () {
      const iter = prompt[Symbol.asyncIterator]();
      if (callIndex === 1) {
        // Consume the initial prompt first.
        await iter.next();
        // Write interrupt before yielding system/init (no sdkSessionId captured yet).
        // Sleep 350ms to let the 200ms poll timer fire and set interruptFlag.
        appendFileSync(
          join(dir, "interventions.jsonl"),
          JSON.stringify({ role: "user", content: "abort early", control: "interrupt", ts: Date.now() }) + "\n",
        );
        await Bun.sleep(350);
        throw new DOMException("Aborted", "AbortError");
      }
      // Second call: consume the "abort early" correction then succeed.
      // No resume id because sdkSessionId was never captured (no system/init yielded).
      expect(options.resume).toBeUndefined();
      await iter.next(); // consume "abort early" correction
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        total_cost_usd: 0,
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
        result: "ok",
        duration_ms: 1,
        duration_api_ms: 1,
        uuid: "u",
        session_id: "sdk-x",
        modelUsage: {},
        permission_denials: [],
      } as any;
    })();
  };

  const result = await runAgentSdkLaunch({
    sessionId: "s-nosdk",
    sessionDir: dir,
    worktree: "/tmp",
    promptFile: join(dir, "prompt.txt"),
    streamFactory,
  });

  expect(result.exitCode).toBe(0);
  expect(callCount).toBe(2);
});
