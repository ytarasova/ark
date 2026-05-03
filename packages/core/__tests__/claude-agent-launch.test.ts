/**
 * Unit tests for the agent-sdk launch core loop.
 *
 * All tests inject a fake message stream so the real Anthropic Agent SDK
 * binary is never invoked -- no API key needed.
 */

import { test, expect } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentSdkLaunch } from "../runtimes/claude-agent/launch.js";
import type { SDKUserMessage } from "../runtimes/claude-agent/launch.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "agent-sdk-launch-"));
}

test("writes each message verbatim and exits clean on success result", async () => {
  const dir = makeTmpDir();
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "hi");

  async function* fakeStream() {
    yield { type: "system", subtype: "init", cwd: "/tmp" } as any;
    yield { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } } as any;
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0.001,
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
      result: "ok",
      duration_ms: 100,
      duration_api_ms: 90,
    } as any;
  }

  const result = await runAgentSdkLaunch({
    sessionId: "s1",
    sessionDir: dir,
    worktree: "/tmp",
    promptFile,
    stream: fakeStream(),
  });

  expect(result.exitCode).toBe(0);
  expect(result.sawResult).toBe(true);

  const transcript = readFileSync(join(dir, "transcript.jsonl"), "utf8");
  const lines = transcript
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(lines).toHaveLength(3);
  expect(lines[0].type).toBe("system");
  expect(lines[1].type).toBe("assistant");
  expect(lines[2].type).toBe("result");
});

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

test("reads prompt from promptFile and includes it in processing", async () => {
  const dir = makeTmpDir();
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "implement feature X");

  let capturedPromptLength = 0;

  async function* fakeStream() {
    // The prompt is read inside runAgentSdkLaunch before streaming starts.
    // We verify indirectly that the file was readable (no exception thrown).
    capturedPromptLength = readFileSync(promptFile, "utf8").length;
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0,
      num_turns: 1,
      usage: { input_tokens: 5, output_tokens: 10 },
      stop_reason: "end_turn",
      result: "done",
      duration_ms: 10,
      duration_api_ms: 10,
    } as any;
  }

  const result = await runAgentSdkLaunch({
    sessionId: "s5",
    sessionDir: dir,
    worktree: "/tmp",
    promptFile,
    stream: fakeStream(),
  });

  expect(result.exitCode).toBe(0);
  expect(capturedPromptLength).toBeGreaterThan(0);
});

test("throws when promptFile is missing (no transcript written)", async () => {
  const dir = makeTmpDir();
  await expect(
    runAgentSdkLaunch({
      sessionId: "s",
      sessionDir: dir,
      worktree: "/tmp",
      promptFile: join(dir, "nonexistent.txt"),
      stream: (async function* () {})(),
    }),
  ).rejects.toThrow();
  // verify transcript.jsonl was not created
  expect(existsSync(join(dir, "transcript.jsonl"))).toBe(false);
});

// ---------------------------------------------------------------------------
// A3b: conductor hook forwarding tests
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  method: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function makeFakeFetch(calls: FetchCall[]): typeof fetch {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(url),
      method: (init?.method ?? "GET").toUpperCase(),
      body: init?.body ? JSON.parse(init.body as string) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
  };
}

test("forwards SessionStart on system/init", async () => {
  const calls: FetchCall[] = [];
  const dir = makeTmpDir();
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "hi");

  async function* stream() {
    yield {
      type: "system",
      subtype: "init",
      cwd: "/workspace",
      tools: ["Read", "Bash"],
      model: "claude-sonnet-4-6",
      mcp_servers: [],
      permissionMode: "bypassPermissions",
    } as any;
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0.001,
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
      result: "ok",
      duration_ms: 100,
      duration_api_ms: 90,
    } as any;
  }

  await runAgentSdkLaunch({
    sessionId: "ark-sess-1",
    sessionDir: dir,
    worktree: "/tmp",
    promptFile,
    stream: stream(),
    hookEndpoint: "http://c:19100/hooks/status",
    fetchFn: makeFakeFetch(calls),
  });

  // SessionStart + Stop + SessionEnd
  expect(calls.length).toBe(3);
  expect(calls[0].url).toContain("/hooks/status?session=ark-sess-1");
  expect(calls[0].method).toBe("POST");
  expect(calls[0].body).toMatchObject({
    hook_event_name: "SessionStart",
    session_id: "ark-sess-1",
    cwd: "/workspace",
    model: "claude-sonnet-4-6",
  });
  expect(calls[1].body).toMatchObject({
    hook_event_name: "Stop",
    session_id: "ark-sess-1",
    total_cost_usd: 0.001,
    num_turns: 1,
  });
  expect(calls[2].body).toMatchObject({
    hook_event_name: "SessionEnd",
    session_id: "ark-sess-1",
    total_cost_usd: 0.001,
    num_turns: 1,
  });
});

test("forwards PreToolUse and PostToolUse for a tool call", async () => {
  const calls: FetchCall[] = [];
  const dir = makeTmpDir();
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "hi");

  async function* stream() {
    // Assistant message with a tool_use block
    yield {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
      },
    } as any;
    // User message with the tool_result
    yield {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", content: "file1\nfile2", is_error: false }],
      },
    } as any;
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0.002,
      num_turns: 2,
      usage: { input_tokens: 5, output_tokens: 5 },
      stop_reason: "end_turn",
      result: "done",
      duration_ms: 200,
      duration_api_ms: 180,
    } as any;
  }

  await runAgentSdkLaunch({
    sessionId: "ark-sess-2",
    sessionDir: dir,
    worktree: "/tmp",
    promptFile,
    stream: stream(),
    hookEndpoint: "http://c:19100/hooks/status",
    fetchFn: makeFakeFetch(calls),
  });

  // PreToolUse, PostToolUse, Stop, SessionEnd
  expect(calls.length).toBe(4);
  expect(calls[0].body).toMatchObject({
    hook_event_name: "PreToolUse",
    session_id: "ark-sess-2",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    tool_use_id: "t1",
  });
  expect(calls[1].body).toMatchObject({
    hook_event_name: "PostToolUse",
    session_id: "ark-sess-2",
    tool_use_id: "t1",
    tool_result_content: "file1\nfile2",
    is_error: false,
  });
  expect(calls[2].body).toMatchObject({ hook_event_name: "Stop" });
  expect(calls[3].body).toMatchObject({ hook_event_name: "SessionEnd" });
});

test("forwards one PreToolUse per tool_use block when multiple in same assistant message", async () => {
  const calls: FetchCall[] = [];
  const dir = makeTmpDir();
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "hi");

  async function* stream() {
    yield {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "ta", name: "Read", input: { file_path: "/a" } },
          { type: "tool_use", id: "tb", name: "Glob", input: { pattern: "*.ts" } },
        ],
      },
    } as any;
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0,
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
      result: "done",
      duration_ms: 10,
      duration_api_ms: 9,
    } as any;
  }

  await runAgentSdkLaunch({
    sessionId: "ark-sess-3",
    sessionDir: dir,
    worktree: "/tmp",
    promptFile,
    stream: stream(),
    hookEndpoint: "http://c:19100/hooks/status",
    fetchFn: makeFakeFetch(calls),
  });

  // Two PreToolUse hooks + Stop + SessionEnd = 4 total
  expect(calls.length).toBe(4);
  expect(calls[0].body).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "ta" });
  expect(calls[1].body).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "Glob", tool_use_id: "tb" });
  expect(calls[2].body).toMatchObject({ hook_event_name: "Stop" });
  expect(calls[3].body).toMatchObject({ hook_event_name: "SessionEnd" });
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
    hookEndpoint: "http://c:19100/hooks/status",
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

test("skips forwarding when hookEndpoint is undefined", async () => {
  const calls: FetchCall[] = [];
  const dir = makeTmpDir();
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "hi");

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

  const result = await runAgentSdkLaunch({
    sessionId: "ark-sess-5",
    sessionDir: dir,
    worktree: "/tmp",
    promptFile,
    stream: stream(),
    // No hookEndpoint
    fetchFn: makeFakeFetch(calls),
  });

  // No fetch calls despite having a fetchFn -- hookEndpoint was undefined
  expect(calls.length).toBe(0);
  // Transcript still written
  expect(result.exitCode).toBe(0);
  expect(result.sawResult).toBe(true);
  const transcript = readFileSync(join(dir, "transcript.jsonl"), "utf8");
  expect(transcript.split("\n").filter(Boolean)).toHaveLength(2);
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
    hookEndpoint: "http://c:19100/hooks/status",
    fetchFn: throwingFetch,
  });

  expect(result.exitCode).toBe(0);
  expect(result.sawResult).toBe(true);
});

test("includes Authorization header when authToken is provided", async () => {
  const calls: FetchCall[] = [];
  const dir = makeTmpDir();
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "hi");

  async function* stream() {
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

  await runAgentSdkLaunch({
    sessionId: "ark-sess-7",
    sessionDir: dir,
    worktree: "/tmp",
    promptFile,
    stream: stream(),
    hookEndpoint: "http://c:19100/hooks/status",
    authToken: "my-secret-token",
    fetchFn: makeFakeFetch(calls),
  });

  // Stop + SessionEnd = 2 calls; auth header present on all
  expect(calls.length).toBe(2);
  expect(calls[0].headers["Authorization"]).toBe("Bearer my-secret-token");
  expect(calls[1].headers["Authorization"]).toBe("Bearer my-secret-token");
});

test("PostToolUse with array content is JSON-stringified", async () => {
  const calls: FetchCall[] = [];
  const dir = makeTmpDir();
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "hi");

  const arrayContent = [{ type: "text", text: "result output" }];

  async function* stream() {
    yield {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tc", content: arrayContent, is_error: false }],
      },
    } as any;
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

  await runAgentSdkLaunch({
    sessionId: "ark-sess-8",
    sessionDir: dir,
    worktree: "/tmp",
    promptFile,
    stream: stream(),
    hookEndpoint: "http://c:19100/hooks/status",
    fetchFn: makeFakeFetch(calls),
  });

  // PostToolUse + Stop + SessionEnd
  expect(calls.length).toBe(3);
  expect(calls[0].body).toMatchObject({ hook_event_name: "PostToolUse", tool_use_id: "tc" });
  expect(calls[0].body.tool_result_content).toBe(JSON.stringify(arrayContent));
  expect(calls[1].body).toMatchObject({ hook_event_name: "Stop" });
  expect(calls[2].body).toMatchObject({ hook_event_name: "SessionEnd" });
});

// ---------------------------------------------------------------------------
// A3b ordering guarantee: transition-driving hook is always last
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// D1: mid-session intervention via interventions.jsonl + streamFactory
// ---------------------------------------------------------------------------

test("picks up mid-session intervention from interventions.jsonl", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-sdk-intervene-"));
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "initial");

  const promptMessages: SDKUserMessage[] = [];

  async function* fakeStream(prompt: AsyncIterable<SDKUserMessage>) {
    const iter = prompt[Symbol.asyncIterator]();

    // Read first message (the seed prompt).
    const first = await iter.next();
    if (!first.done) promptMessages.push(first.value);

    // Simulate sage writing an intervention while the agent is mid-turn.
    appendFileSync(
      join(dir, "interventions.jsonl"),
      JSON.stringify({ role: "user", content: "also do X", ts: Date.now() }) + "\n",
    );

    // Read second message (the intervention).
    const second = await iter.next();
    if (!second.done) promptMessages.push(second.value);

    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0,
      num_turns: 2,
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
      result: "ok",
      duration_ms: 1,
      duration_api_ms: 1,
      uuid: "u",
      session_id: "s",
      modelUsage: {},
      permission_denials: [],
    } as any;
  }

  const result = await runAgentSdkLaunch({
    sessionId: "s1",
    sessionDir: dir,
    worktree: "/tmp",
    promptFile,
    streamFactory: (prompt) => fakeStream(prompt as AsyncIterable<SDKUserMessage>),
  });

  expect(result.exitCode).toBe(0);
  expect(result.sawResult).toBe(true);
  expect(promptMessages).toHaveLength(2);
  expect(promptMessages[0].message.content).toBe("initial");
  expect(promptMessages[1].message.content).toBe("also do X");
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

// ---------------------------------------------------------------------------
// Compaction: compact_boundary emits Notification hook + re-feeds prompt
// ---------------------------------------------------------------------------

test("compact_boundary emits Notification hook AND re-feeds original prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-sdk-compact-"));
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "the original task is to refactor the database layer");

  const promptMessages: SDKUserMessage[] = [];
  const hookCalls: FetchCall[] = [];

  async function* stream(prompt: AsyncIterable<SDKUserMessage>) {
    const iter = prompt[Symbol.asyncIterator]();

    // Read initial prompt
    const first = await iter.next();
    if (!first.done) promptMessages.push(first.value);

    // Yield system/init then compact_boundary
    yield {
      type: "system",
      subtype: "init",
      session_id: "sdk-1",
      cwd: "/tmp",
      tools: [],
      model: "sonnet",
      mcp_servers: [],
      permissionMode: "bypassPermissions",
      apiKeySource: "user",
      slash_commands: [],
      output_style: "default",
      uuid: "u1",
    } as any;
    yield {
      type: "system",
      subtype: "compact_boundary",
      session_id: "sdk-1",
      uuid: "u2",
      compact_metadata: { trigger: "auto", pre_tokens: 12345 },
    } as any;

    // The launch should have pushed a reminder; read it from the queue
    const reminder = await iter.next();
    if (!reminder.done) promptMessages.push(reminder.value);

    // Then result
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0.001,
      num_turns: 2,
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
      result: "ok",
      duration_ms: 100,
      duration_api_ms: 90,
      uuid: "u3",
      session_id: "sdk-1",
      modelUsage: {},
      permission_denials: [],
    } as any;
  }

  const result = await runAgentSdkLaunch({
    sessionId: "ark-cmp",
    sessionDir: dir,
    worktree: "/tmp",
    promptFile,
    streamFactory: (prompt) => stream(prompt as AsyncIterable<SDKUserMessage>),
    hookEndpoint: "http://c:19100/hooks/status",
    fetchFn: makeFakeFetch(hookCalls),
  });

  expect(result.exitCode).toBe(0);

  // Both messages should have been read: initial prompt + compaction reminder
  expect(promptMessages).toHaveLength(2);
  expect(promptMessages[0].message.content).toContain("the original task");
  expect(promptMessages[1].message.content).toContain("Compaction occurred");
  expect(promptMessages[1].message.content).toContain("the original task is to refactor the database layer");

  // Notification hook should have been forwarded
  const notif = hookCalls.find((c) => c.body.hook_event_name === "Notification");
  expect(notif).toBeDefined();
  expect(notif!.body.notification_type).toBe("compaction");
  expect(notif!.body.trigger).toBe("auto");
  expect(notif!.body.pre_tokens).toBe(12345);
  expect(notif!.body.session_id).toBe("ark-cmp");
});

test("transition-driving hook (SessionEnd/StopFailure) is always the final hook for a result message", async () => {
  // Verify for a success result: Stop comes before SessionEnd
  const successCalls: FetchCall[] = [];
  const dir1 = makeTmpDir();
  const promptFile1 = join(dir1, "prompt.txt");
  writeFileSync(promptFile1, "hi");

  async function* successStream() {
    yield {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "u1", name: "Bash", input: { command: "ls" } }] },
    } as any;
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0.005,
      num_turns: 2,
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: "end_turn",
      result: "ok",
      duration_ms: 200,
      duration_api_ms: 190,
    } as any;
  }

  await runAgentSdkLaunch({
    sessionId: "ark-sess-order-ok",
    sessionDir: dir1,
    worktree: "/tmp",
    promptFile: promptFile1,
    stream: successStream(),
    hookEndpoint: "http://c:19100/hooks/status",
    fetchFn: makeFakeFetch(successCalls),
  });

  // Last hook must be the state-transition driver
  const lastSuccess = successCalls[successCalls.length - 1];
  expect(lastSuccess.body.hook_event_name).toBe("SessionEnd");
  // Stop must appear immediately before SessionEnd
  const secondLast = successCalls[successCalls.length - 2];
  expect(secondLast.body.hook_event_name).toBe("Stop");

  // Verify for an error result: StopFailure is last
  const errorCalls: FetchCall[] = [];
  const dir2 = makeTmpDir();
  const promptFile2 = join(dir2, "prompt.txt");
  writeFileSync(promptFile2, "hi");

  async function* errorStream() {
    yield {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      total_cost_usd: 0.001,
      num_turns: 1,
      usage: { input_tokens: 5, output_tokens: 0 },
      stop_reason: null,
      error: "execution failed",
      errors: ["execution failed"],
      duration_ms: 50,
      duration_api_ms: 45,
    } as any;
  }

  await runAgentSdkLaunch({
    sessionId: "ark-sess-order-err",
    sessionDir: dir2,
    worktree: "/tmp",
    promptFile: promptFile2,
    stream: errorStream(),
    hookEndpoint: "http://c:19100/hooks/status",
    fetchFn: makeFakeFetch(errorCalls),
  });

  const lastError = errorCalls[errorCalls.length - 1];
  expect(lastError.body.hook_event_name).toBe("StopFailure");
  const secondLastError = errorCalls[errorCalls.length - 2];
  expect(secondLastError.body.hook_event_name).toBe("Stop");
});
