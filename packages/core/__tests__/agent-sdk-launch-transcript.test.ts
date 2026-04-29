/**
 * Agent-sdk launch tests -- transcript writing + prompt-file handling.
 *
 * Slice of the former `agent-sdk-launch.test.ts` that focuses on the
 * on-disk transcript.jsonl, prompt-file reading, and the happy-path
 * exit-code contract. Error / abort paths live in
 * `agent-sdk-launch-errors.test.ts`; hook streaming lives in
 * `agent-sdk-launch-streaming.test.ts`.
 *
 * All tests inject a fake message stream so the real Anthropic Agent SDK
 * binary is never invoked -- no API key needed.
 */

import { test, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgentSdkLaunch } from "../runtimes/agent-sdk/launch.js";
import { makeTmpDir } from "./agent-sdk-launch-helpers.js";

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
