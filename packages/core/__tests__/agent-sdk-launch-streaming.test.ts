/**
 * Agent-sdk launch tests -- hook streaming + multi-turn flow.
 *
 * Slice of the former `agent-sdk-launch.test.ts` covering conductor hook
 * forwarding (SessionStart, PreToolUse, PostToolUse, Stop, SessionEnd,
 * Notification), multi-tool assistant messages, intervention pickup, and
 * compaction signaling. Transcript/exit semantics live in
 * `agent-sdk-launch-transcript.test.ts`; error/abort paths live in
 * `agent-sdk-launch-errors.test.ts`.
 */

import { test, expect } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentSdkLaunch } from "../runtimes/agent-sdk/launch.js";
import type { SDKUserMessage } from "../runtimes/agent-sdk/launch.js";
import { makeTmpDir, makeFakeFetch, type FetchCall } from "./agent-sdk-launch-helpers.js";

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
    conductorUrl: "http://c:19100",
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
    conductorUrl: "http://c:19100",
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
    conductorUrl: "http://c:19100",
    fetchFn: makeFakeFetch(calls),
  });

  // Two PreToolUse hooks + Stop + SessionEnd = 4 total
  expect(calls.length).toBe(4);
  expect(calls[0].body).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "ta" });
  expect(calls[1].body).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "Glob", tool_use_id: "tb" });
  expect(calls[2].body).toMatchObject({ hook_event_name: "Stop" });
  expect(calls[3].body).toMatchObject({ hook_event_name: "SessionEnd" });
});

test("skips forwarding when conductorUrl is undefined", async () => {
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
    // No conductorUrl
    fetchFn: makeFakeFetch(calls),
  });

  // No fetch calls despite having a fetchFn -- conductorUrl was undefined
  expect(calls.length).toBe(0);
  // Transcript still written
  expect(result.exitCode).toBe(0);
  expect(result.sawResult).toBe(true);
  const transcript = readFileSync(join(dir, "transcript.jsonl"), "utf8");
  expect(transcript.split("\n").filter(Boolean)).toHaveLength(2);
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
    conductorUrl: "http://c:19100",
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
    conductorUrl: "http://c:19100",
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
    conductorUrl: "http://c:19100",
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

// ---------------------------------------------------------------------------
// A3b ordering guarantee: transition-driving hook is always last
// ---------------------------------------------------------------------------

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
    conductorUrl: "http://c:19100",
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
    conductorUrl: "http://c:19100",
    fetchFn: makeFakeFetch(errorCalls),
  });

  const lastError = errorCalls[errorCalls.length - 1];
  expect(lastError.body.hook_event_name).toBe("StopFailure");
  const secondLastError = errorCalls[errorCalls.length - 2];
  expect(secondLastError.body.hook_event_name).toBe("Stop");
});
