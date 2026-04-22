/**
 * AgentSdkParser tests.
 *
 * These tests write synthetic SDKMessage JSONL transcripts to tmp files so
 * the parser can be exercised without a real agent-sdk install.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AgentSdkParser } from "../runtimes/agent-sdk/parser.js";

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
});
