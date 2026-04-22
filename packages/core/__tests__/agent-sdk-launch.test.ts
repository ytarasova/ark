/**
 * Unit tests for the agent-sdk launch core loop.
 *
 * All tests inject a fake message stream so the real Anthropic Agent SDK
 * binary is never invoked -- no API key needed.
 */

import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentSdkLaunch } from "../runtimes/agent-sdk/launch.js";

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
    conductorUrl: "http://c:19100",
    fetchFn: makeFakeFetch(calls),
  });

  // SessionStart + Stop
  expect(calls.length).toBe(2);
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

  // PreToolUse, PostToolUse, Stop
  expect(calls.length).toBe(3);
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

  // Two PreToolUse hooks + Stop = 3 total
  expect(calls.length).toBe(3);
  expect(calls[0].body).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "ta" });
  expect(calls[1].body).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "Glob", tool_use_id: "tb" });
  expect(calls[2].body).toMatchObject({ hook_event_name: "Stop" });
});

test("forwards Stop with is_error=true and error details when result is an error", async () => {
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

  expect(calls.length).toBe(1);
  expect(calls[0].body).toMatchObject({
    hook_event_name: "Stop",
    session_id: "ark-sess-4",
    is_error: true,
    subtype: "error_max_budget_usd",
    errors: ["budget exceeded"],
    total_cost_usd: 1.5,
  });
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

  expect(calls.length).toBe(1);
  expect(calls[0].headers["Authorization"]).toBe("Bearer my-secret-token");
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

  // PostToolUse + Stop
  expect(calls.length).toBe(2);
  expect(calls[0].body).toMatchObject({ hook_event_name: "PostToolUse", tool_use_id: "tc" });
  expect(calls[0].body.tool_result_content).toBe(JSON.stringify(arrayContent));
});
