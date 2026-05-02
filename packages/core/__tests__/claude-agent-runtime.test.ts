/**
 * AgentSdkParser tests.
 *
 * These tests write synthetic SDKMessage JSONL transcripts to tmp files so
 * the parser can be exercised without a real agent-sdk install.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AgentSdkParser } from "../runtimes/claude-agent/parser.js";

const TEST_DIR = join(tmpdir(), `ark-agent-sdk-parser-${process.pid}-${Date.now()}`);
// tracksDir mirrors ~/.ark/tracks: subdirs are session IDs, each contains transcript.jsonl
const TRACKS_DIR = join(TEST_DIR, "tracks");

beforeAll(() => {
  mkdirSync(TRACKS_DIR, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
});

/** Write a transcript.jsonl inside a named session subdir of TRACKS_DIR. */
function writeTranscript(sessionId: string, lines: object[]): string {
  const sessionDir = join(TRACKS_DIR, sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const path = join(sessionDir, "transcript.jsonl");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

test("parses SDKMessage JSONL", () => {
  const path = writeTranscript("sess-full", [
    { type: "user", message: { content: [{ type: "text", text: "hi" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "README.md" } }] },
    },
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "contents...", is_error: false }] },
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 2,
      duration_ms: 1200,
      duration_api_ms: 900,
      stop_reason: "end_turn",
      total_cost_usd: 0.0042,
      usage: { input_tokens: 120, output_tokens: 35, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      modelUsage: { "claude-sonnet-4-6": { input_tokens: 120, output_tokens: 35 } },
      result: "done",
    },
  ]);
  const parsed = new AgentSdkParser().parse(path);
  expect(parsed.usage.input_tokens).toBe(120);
  expect(parsed.usage.output_tokens).toBe(35);
  expect(parsed.cost_usd).toBeCloseTo(0.0042);
  expect(parsed.num_turns).toBe(2);
  expect(parsed.stop_reason).toBe("end_turn");
  expect(parsed.transcript_path).toBe(path);
});

test("ignores unknown message types -- usage comes from result line only", () => {
  const path = writeTranscript("sess-unknown-types", [
    { type: "system", subtype: "init", info: "boot" },
    { type: "partial_assistant", message: { content: [{ type: "text", text: "partial" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "final" }] } },
    {
      type: "result",
      is_error: false,
      num_turns: 1,
      duration_ms: 100,
      total_cost_usd: 0.001,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      stop_reason: "end_turn",
      result: "ok",
    },
  ]);
  const parsed = new AgentSdkParser().parse(path);
  expect(parsed.usage.input_tokens).toBe(10);
  expect(parsed.usage.output_tokens).toBe(5);
});

test("returns zero usage for a missing file", () => {
  const parsed = new AgentSdkParser().parse(join(TEST_DIR, "does-not-exist.jsonl"));
  expect(parsed.usage.input_tokens).toBe(0);
  expect(parsed.usage.output_tokens).toBe(0);
  expect(parsed.cost_usd).toBe(0);
  expect(parsed.num_turns).toBe(0);
  expect(parsed.stop_reason).toBeNull();
});

test("stops at first result line -- a second result does not overwrite the first", () => {
  const path = writeTranscript("sess-double-result", [
    { type: "user", message: { content: [{ type: "text", text: "go" }] } },
    {
      type: "result",
      is_error: false,
      num_turns: 1,
      duration_ms: 100,
      total_cost_usd: 0.001,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      stop_reason: "end_turn",
      result: "first",
    },
    // A second result line (e.g. corrupted or resumed session) should be ignored.
    {
      type: "result",
      is_error: false,
      num_turns: 99,
      duration_ms: 999,
      total_cost_usd: 9.99,
      usage: { input_tokens: 9999, output_tokens: 8888, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      stop_reason: "max_tokens",
      result: "second",
    },
  ]);
  const parsed = new AgentSdkParser().parse(path);
  // Must reflect the first result line only.
  expect(parsed.num_turns).toBe(1);
  expect(parsed.cost_usd).toBeCloseTo(0.001);
  expect(parsed.usage.input_tokens).toBe(10);
  expect(parsed.stop_reason).toBe("end_turn");
});

test("skips malformed lines without crashing", () => {
  const sessionDir = join(TRACKS_DIR, "sess-malformed");
  mkdirSync(sessionDir, { recursive: true });
  const path = join(sessionDir, "transcript.jsonl");
  writeFileSync(
    path,
    '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}\n' +
      "not-valid-json\n" +
      '{"type":"result","is_error":false,"num_turns":1,"duration_ms":50,"total_cost_usd":0.0005,"usage":{"input_tokens":5,"output_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"stop_reason":"end_turn","result":"done"}\n',
  );
  const parsed = new AgentSdkParser().parse(path);
  expect(parsed.usage.input_tokens).toBe(5);
  expect(parsed.usage.output_tokens).toBe(2);
});

describe("AgentSdkParser.findForSession", () => {
  test("returns null when workdir is empty", () => {
    expect(new AgentSdkParser().findForSession({ workdir: "" })).toBeNull();
  });

  test("returns null when the tracks directory does not exist", () => {
    const parser = new AgentSdkParser(join(TEST_DIR, "nonexistent"));
    expect(parser.findForSession({ workdir: "/tmp/anything" })).toBeNull();
  });

  test("matches a transcript file by cwd annotation", () => {
    const workdir = "/tmp/ark-agent-sdk-test-wd";
    const path = writeTranscript("sess-cwd-match", [
      { type: "system", subtype: "init", info: { cwd: workdir } },
      {
        type: "result",
        is_error: false,
        num_turns: 1,
        duration_ms: 100,
        total_cost_usd: 0.001,
        usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        stop_reason: "end_turn",
        result: "done",
      },
    ]);
    const parser = new AgentSdkParser(TRACKS_DIR);
    const found = parser.findForSession({ workdir });
    expect(found).not.toBeNull();
    expect(found).toBe(path);
  });

  test("respects the startTime filter", () => {
    const workdir = "/tmp/ark-agent-sdk-time-filter";
    writeTranscript("sess-time-filter", [{ type: "system", subtype: "init", info: { cwd: workdir } }]);
    // A future startTime means the transcript was written before the session started -- no match.
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const parser = new AgentSdkParser(TRACKS_DIR);
    const found = parser.findForSession({ workdir, startTime: future });
    expect(found).toBeNull();
  });

  test("returns null when no transcript cwd matches", () => {
    const parser = new AgentSdkParser(TRACKS_DIR);
    const found = parser.findForSession({ workdir: "/tmp/ark-no-such-workdir-xyz" });
    expect(found).toBeNull();
  });

  test("matches when workdir is a symlink pointing to the real path stored in the transcript", () => {
    // Create a real directory and a symlink pointing to it.
    const realDir = join(TEST_DIR, "real-workdir-symlink-test");
    const symlinkDir = join(TEST_DIR, "symlink-workdir");
    mkdirSync(realDir, { recursive: true });
    // Remove any stale symlink from a previous run.
    if (existsSync(symlinkDir)) rmSync(symlinkDir, { recursive: true, force: true });
    symlinkSync(realDir, symlinkDir);

    // Transcript stores the real path in info.cwd.
    const path = writeTranscript("sess-symlink-match", [
      { type: "system", subtype: "init", info: { cwd: realDir } },
      {
        type: "result",
        is_error: false,
        num_turns: 1,
        duration_ms: 100,
        total_cost_usd: 0.001,
        usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        stop_reason: "end_turn",
        result: "done",
      },
    ]);

    // The caller passes the symlink path; the parser must resolve both sides and still match.
    const parser = new AgentSdkParser(TRACKS_DIR);
    const found = parser.findForSession({ workdir: symlinkDir });
    expect(found).not.toBeNull();
    expect(found).toBe(path);
  });
});

// ---------------------------------------------------------------------------
// Message + tool-call extraction tests
// ---------------------------------------------------------------------------

describe("AgentSdkParser -- messages and toolCalls extraction", () => {
  test("extracts text messages from user and assistant blocks in order", () => {
    const path = writeTranscript("sess-messages-order", [
      { type: "user", message: { content: [{ type: "text", text: "hi" }] } },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "thinking..." },
            { type: "tool_use", id: "t1", name: "Read", input: { path: "a.ts" } },
          ],
        },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "data", is_error: false }] },
      },
      { type: "assistant", message: { content: [{ type: "text", text: "done" }] } },
      {
        type: "result",
        is_error: false,
        num_turns: 2,
        duration_ms: 100,
        total_cost_usd: 0.001,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        stop_reason: "end_turn",
        result: "done",
      },
    ]);
    const parsed = new AgentSdkParser().parse(path);
    expect(parsed.messages).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", text: "thinking..." },
      { role: "assistant", text: "done" },
    ]);
  });

  test("extracts tool calls with matching results", () => {
    const path = writeTranscript("sess-tool-calls-match", [
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "a" } }],
        },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "data", is_error: false }] },
      },
      {
        type: "result",
        is_error: false,
        num_turns: 1,
        duration_ms: 50,
        total_cost_usd: 0.0001,
        usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        stop_reason: "end_turn",
        result: "ok",
      },
    ]);
    const parsed = new AgentSdkParser().parse(path);
    expect(parsed.toolCalls).toEqual([
      { id: "t1", name: "Read", input: { path: "a" }, output: "data", is_error: false },
    ]);
  });

  test("tool_result without matching tool_use is kept as orphan", () => {
    const path = writeTranscript("sess-orphan-result", [
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "orphan-1", content: "mystery", is_error: false }] },
      },
      {
        type: "result",
        is_error: false,
        num_turns: 1,
        duration_ms: 50,
        total_cost_usd: 0.0001,
        usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        stop_reason: "end_turn",
        result: "ok",
      },
    ]);
    const parsed = new AgentSdkParser().parse(path);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].id).toBe("orphan-1");
    expect(parsed.toolCalls[0].name).toBe("");
    expect(parsed.toolCalls[0].input).toBeNull();
    expect(parsed.toolCalls[0].output).toBe("mystery");
  });

  test("tool_result.content that is an array is json-stringified", () => {
    const content = [{ type: "text", text: "x" }];
    const path = writeTranscript("sess-array-content", [
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: {} }] },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t2", content, is_error: false }] },
      },
      {
        type: "result",
        is_error: false,
        num_turns: 1,
        duration_ms: 50,
        total_cost_usd: 0.0001,
        usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        stop_reason: "end_turn",
        result: "ok",
      },
    ]);
    const parsed = new AgentSdkParser().parse(path);
    expect(parsed.toolCalls[0].output).toBe('[{"type":"text","text":"x"}]');
  });

  test("skips blocks with unknown types without throwing", () => {
    const path = writeTranscript("sess-unknown-block-types", [
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", text: "inner monologue..." },
            { type: "text", text: "visible output" },
          ],
        },
      },
      {
        type: "result",
        is_error: false,
        num_turns: 1,
        duration_ms: 50,
        total_cost_usd: 0.0001,
        usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        stop_reason: "end_turn",
        result: "ok",
      },
    ]);
    // Should not throw, and only the text block should appear in messages.
    const parsed = new AgentSdkParser().parse(path);
    expect(parsed.messages).toEqual([{ role: "assistant", text: "visible output" }]);
    expect(parsed.toolCalls).toEqual([]);
  });

  test("empty transcript yields empty messages and toolCalls arrays", () => {
    const parsed = new AgentSdkParser().parse(join(TEST_DIR, "nonexistent-for-empty.jsonl"));
    expect(parsed.messages).toEqual([]);
    expect(parsed.toolCalls).toEqual([]);
  });
});
