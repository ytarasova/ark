/**
 * CodexTranscriptParser tests.
 *
 * These tests write synthetic JSONL transcripts to a tmp sessions dir so the
 * parser can be exercised without a real Codex install.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { CodexTranscriptParser } from "../runtimes/codex/parser.js";

const TEST_DIR = join(tmpdir(), `ark-codex-parser-${process.pid}-${Date.now()}`);
const SESSIONS_DIR = join(TEST_DIR, "sessions");

beforeAll(() => {
  mkdirSync(SESSIONS_DIR, { recursive: true });
});

afterAll(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* already gone */ }
});

function writeTranscript(name: string, cwd: string, lines: object[]): string {
  const dayDir = join(SESSIONS_DIR, "2026", "04", "11");
  mkdirSync(dayDir, { recursive: true });
  const path = join(dayDir, name);
  const content = [
    { type: "session_meta", payload: { cwd } },
    ...lines,
  ].map(l => JSON.stringify(l)).join("\n");
  writeFileSync(path, content);
  return path;
}

describe("CodexTranscriptParser.parse", () => {
  const parser = new CodexTranscriptParser(SESSIONS_DIR);

  it("returns zero usage for a missing file", () => {
    const result = parser.parse(join(SESSIONS_DIR, "does-not-exist.jsonl"));
    expect(result.usage.input_tokens).toBe(0);
    expect(result.usage.output_tokens).toBe(0);
  });

  it("extracts the LAST cumulative token_count event (Codex emits incremental totals)", () => {
    const path = writeTranscript("rollout-cumulative.jsonl", "/tmp/wd1", [
      { type: "turn_context", payload: { model: "gpt-5-codex" } },
      { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 10 } } } },
      { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 500, output_tokens: 300, cached_input_tokens: 80 } } } },
    ]);
    const result = parser.parse(path);
    expect(result.usage.input_tokens).toBe(500);
    expect(result.usage.output_tokens).toBe(300);
    expect(result.usage.cache_read_tokens).toBe(80);
    expect(result.model).toBe("gpt-5-codex");
  });

  it("adds reasoning_output_tokens to output", () => {
    const path = writeTranscript("rollout-reasoning.jsonl", "/tmp/wd2", [
      { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 5 } } } },
    ]);
    const result = parser.parse(path);
    expect(result.usage.output_tokens).toBe(25); // 20 + 5
  });

  it("skips malformed lines without crashing", () => {
    const path = join(SESSIONS_DIR, "2026", "04", "11", "rollout-bad.jsonl");
    writeFileSync(path,
      '{"type":"session_meta","payload":{"cwd":"/tmp/wd3"}}\n' +
      "not-valid-json\n" +
      '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":42,"output_tokens":7}}}}\n'
    );
    const result = parser.parse(path);
    expect(result.usage.input_tokens).toBe(42);
    expect(result.usage.output_tokens).toBe(7);
  });
});

describe("CodexTranscriptParser.findForSession", () => {
  const parser = new CodexTranscriptParser(SESSIONS_DIR);

  it("returns null when the sessions directory does not exist", () => {
    const p = new CodexTranscriptParser("/tmp/ark-codex-nonexistent-xyz");
    expect(p.findForSession({ workdir: "/tmp/anything" })).toBeNull();
  });

  it("matches a rollout file via session_meta.cwd", () => {
    writeTranscript("rollout-match.jsonl", "/tmp/match-me", [
      { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1, output_tokens: 1 } } } },
    ]);
    const found = parser.findForSession({ workdir: "/tmp/match-me" });
    expect(found).not.toBeNull();
    expect(found).toContain("rollout-match.jsonl");
  });

  it("returns null when no rollout file has a matching cwd", () => {
    const found = parser.findForSession({ workdir: "/tmp/not-in-any-transcript" });
    expect(found).toBeNull();
  });

  it("respects the startTime filter", () => {
    writeTranscript("rollout-recent.jsonl", "/tmp/time-filter", []);
    // 1 hour in the future -> everything is "before" so nothing matches
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const found = parser.findForSession({ workdir: "/tmp/time-filter", startTime: future });
    expect(found).toBeNull();
  });
});
