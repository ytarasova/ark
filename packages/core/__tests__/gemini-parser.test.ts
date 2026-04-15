/**
 * GeminiTranscriptParser tests.
 *
 * Validates token accumulation (Gemini uses per-message deltas, not cumulative totals),
 * the projectHash = sha256(workdir) matching, and malformed-line tolerance.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { GeminiTranscriptParser } from "../runtimes/gemini/parser.js";

const TEST_DIR = join(tmpdir(), `ark-gemini-parser-${process.pid}-${Date.now()}`);
const TMP_DIR = join(TEST_DIR, "tmp");

beforeAll(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
});

function writeTranscript(projectSlug: string, fileName: string, workdir: string, messages: object[]): string {
  const chatsDir = join(TMP_DIR, projectSlug, "chats");
  mkdirSync(chatsDir, { recursive: true });
  const path = join(chatsDir, fileName);
  const projectHash = createHash("sha256").update(resolve(workdir)).digest("hex");
  const header = { sessionId: "test-session", projectHash, startTime: new Date().toISOString() };
  const content = [header, ...messages].map((m) => JSON.stringify(m)).join("\n");
  writeFileSync(path, content);
  return path;
}

describe("GeminiTranscriptParser.parse", () => {
  const parser = new GeminiTranscriptParser(TMP_DIR);

  it("returns zero usage for a missing file", () => {
    const result = parser.parse(join(TMP_DIR, "does-not-exist.jsonl"));
    expect(result.usage.input_tokens).toBe(0);
    expect(result.usage.output_tokens).toBe(0);
  });

  it("accumulates token deltas across gemini messages (non-cumulative)", () => {
    const path = writeTranscript("proj1", "session-accum.jsonl", "/tmp/wd-gemini-1", [
      { type: "user", content: "hi" },
      {
        type: "gemini",
        model: "gemini-pro",
        content: "hello",
        tokens: { input: 100, output: 50, cached: 10, thoughts: 5, tool: 2 },
      },
      { type: "gemini", content: "again", tokens: { input: 200, output: 80, cached: 20 } },
    ]);
    const result = parser.parse(path);
    // Input: 100 + 200 = 300
    expect(result.usage.input_tokens).toBe(300);
    // Output: (50+5+2) + (80+0+0) = 137
    expect(result.usage.output_tokens).toBe(137);
    // Cached: 10 + 20 = 30
    expect(result.usage.cache_read_tokens).toBe(30);
    expect(result.model).toBe("gemini-pro");
  });

  it("ignores non-gemini messages", () => {
    const path = writeTranscript("proj2", "session-noise.jsonl", "/tmp/wd-gemini-2", [
      { type: "user", content: "q" },
      { type: "info", content: "i" },
      { type: "error", content: "boom" },
      { type: "gemini", tokens: { input: 5, output: 3 } },
    ]);
    const result = parser.parse(path);
    expect(result.usage.input_tokens).toBe(5);
    expect(result.usage.output_tokens).toBe(3);
  });

  it("skips malformed lines without crashing", () => {
    const dir = join(TMP_DIR, "proj-bad", "chats");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "session-bad.jsonl");
    writeFileSync(
      path,
      JSON.stringify({ projectHash: "xxx" }) +
        "\n" +
        "not-json\n" +
        JSON.stringify({ type: "gemini", tokens: { input: 1, output: 2 } }) +
        "\n",
    );
    const result = parser.parse(path);
    expect(result.usage.input_tokens).toBe(1);
    expect(result.usage.output_tokens).toBe(2);
  });
});

describe("GeminiTranscriptParser.findForSession", () => {
  const parser = new GeminiTranscriptParser(TMP_DIR);

  it("returns null when tmpDir does not exist", () => {
    const p = new GeminiTranscriptParser("/tmp/ark-gemini-nonexistent-xyz");
    expect(p.findForSession({ workdir: "/tmp/anything" })).toBeNull();
  });

  it("matches a chat file by sha256(workdir) projectHash", () => {
    writeTranscript("proj-match", "session-find.jsonl", "/tmp/wd-find", [
      { type: "gemini", tokens: { input: 1, output: 1 } },
    ]);
    const found = parser.findForSession({ workdir: "/tmp/wd-find" });
    expect(found).not.toBeNull();
    expect(found).toContain("session-find.jsonl");
  });

  it("returns null when no file has a matching projectHash", () => {
    const found = parser.findForSession({ workdir: "/tmp/wd-no-match-anywhere" });
    expect(found).toBeNull();
  });

  it("respects the startTime filter", () => {
    writeTranscript("proj-time", "session-time.jsonl", "/tmp/wd-time", []);
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const found = parser.findForSession({ workdir: "/tmp/wd-time", startTime: future });
    expect(found).toBeNull();
  });
});
