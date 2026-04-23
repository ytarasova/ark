/**
 * Unit tests for formatTranscriptLine and formatTranscriptStream.
 *
 * Each test exercises one SDKMessage type and verifies the one-line summary
 * contains the expected substrings. No AppContext needed -- pure unit tests.
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatTranscriptLine, formatTranscriptStream } from "../runtimes/agent-sdk/format.js";

// ── formatTranscriptLine --------------------------------------------------

test("formatTranscriptLine: invalid JSON returns raw input", () => {
  const raw = "not json at all";
  expect(formatTranscriptLine(raw)).toBe(raw);
});

test("formatTranscriptLine: system/init includes model and cwd", () => {
  const line = JSON.stringify({
    type: "system",
    subtype: "init",
    cwd: "/workspace/myrepo",
    model: "claude-sonnet-4-6",
    tools: ["Read", "Write", "Bash"],
  });
  const formatted = formatTranscriptLine(line);
  expect(formatted).toContain("system/init");
  expect(formatted).toContain("claude-sonnet-4-6");
  expect(formatted).toContain("/workspace/myrepo");
  expect(formatted).toContain("Read");
});

test("formatTranscriptLine: system/init truncates tools list beyond 6", () => {
  const tools = ["A", "B", "C", "D", "E", "F", "G", "H"];
  const line = JSON.stringify({
    type: "system",
    subtype: "init",
    cwd: "/tmp",
    model: "claude-opus-4",
    tools,
  });
  const formatted = formatTranscriptLine(line);
  expect(formatted).toContain("...");
});

test("formatTranscriptLine: system/api_retry includes attempt and error", () => {
  const line = JSON.stringify({
    type: "system",
    subtype: "api_retry",
    attempt: 2,
    max_retries: 10,
    error_status: 401,
    error: "authentication_failed",
  });
  const formatted = formatTranscriptLine(line);
  expect(formatted).toContain("api_retry");
  expect(formatted).toContain("2/10");
  expect(formatted).toContain("401");
  expect(formatted).toContain("authentication_failed");
});

test("formatTranscriptLine: assistant with text block", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text: "I will start by reading the README." }],
    },
  });
  const formatted = formatTranscriptLine(line);
  expect(formatted).toContain("assistant");
  expect(formatted).toContain("I will start");
});

test("formatTranscriptLine: assistant with tool_use block", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "README.md" } }],
    },
  });
  const formatted = formatTranscriptLine(line);
  expect(formatted).toContain("tool_use");
  expect(formatted).toContain("Read");
  expect(formatted).toContain("README.md");
});

test("formatTranscriptLine: user with tool_result block shows byte count", () => {
  const content = "file content here with 30 chars!!";
  const line = JSON.stringify({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "t1", content, is_error: false }],
    },
  });
  const formatted = formatTranscriptLine(line);
  expect(formatted).toContain("tool_result");
  expect(formatted).toContain(`${content.length}b`);
});

test("formatTranscriptLine: user with errored tool_result shows ERR flag", () => {
  const line = JSON.stringify({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "t2", content: "permission denied", is_error: true }],
    },
  });
  const formatted = formatTranscriptLine(line);
  expect(formatted).toContain("ERR");
});

test("formatTranscriptLine: result/success shows OK cost and turns", () => {
  const line = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    total_cost_usd: 0.0042,
    num_turns: 3,
    duration_ms: 6000,
  });
  const formatted = formatTranscriptLine(line);
  expect(formatted).toContain("result/success");
  expect(formatted).toContain("OK");
  expect(formatted).toContain("$0.0042");
  expect(formatted).toContain("turns=3");
  expect(formatted).toContain("duration=6s");
});

test("formatTranscriptLine: result with is_error shows FAIL", () => {
  const line = JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    total_cost_usd: 0.001,
    num_turns: 1,
    duration_ms: 2000,
  });
  const formatted = formatTranscriptLine(line);
  expect(formatted).toContain("FAIL");
  expect(formatted).toContain("error_during_execution");
});

test("formatTranscriptLine: generic system message", () => {
  const line = JSON.stringify({
    type: "system",
    subtype: "something_new",
    message: "some diagnostic text",
  });
  const formatted = formatTranscriptLine(line);
  expect(formatted).toContain("system/something_new");
  expect(formatted).toContain("some diagnostic text");
});

test("formatTranscriptLine: unknown type falls back to truncated JSON", () => {
  const line = JSON.stringify({ type: "future_type", data: { x: 1 } });
  const formatted = formatTranscriptLine(line);
  expect(formatted).toContain("future_type");
});

// ── formatTranscriptStream ------------------------------------------------

test("formatTranscriptStream: yields nothing for nonexistent file", async () => {
  const lines: string[] = [];
  for await (const line of formatTranscriptStream("/tmp/__no_such_transcript__.jsonl")) {
    lines.push(line);
  }
  expect(lines).toHaveLength(0);
});

test("formatTranscriptStream: yields formatted lines from a real file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "format-stream-test-"));
  const path = join(dir, "transcript.jsonl");

  const messages = [
    JSON.stringify({ type: "system", subtype: "init", cwd: "/repo", model: "claude-sonnet-4-6", tools: ["Bash"] }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0.001,
      num_turns: 1,
      duration_ms: 1000,
    }),
  ];
  writeFileSync(path, messages.join("\n") + "\n");

  const lines: string[] = [];
  for await (const line of formatTranscriptStream(path)) {
    lines.push(line);
  }

  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain("system/init");
  expect(lines[0]).toContain("claude-sonnet-4-6");
  expect(lines[1]).toContain("result/success");
  expect(lines[1]).toContain("OK");

  rmSync(dir, { recursive: true });
});
