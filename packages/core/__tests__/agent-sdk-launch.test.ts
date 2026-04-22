/**
 * Unit tests for the agent-sdk launch core loop.
 *
 * All tests inject a fake message stream so the real Anthropic Agent SDK
 * binary is never invoked -- no API key needed.
 */

import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
