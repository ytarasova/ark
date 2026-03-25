/**
 * Tests for claude.ts transcript parsing — token usage extraction.
 */
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import {
  createTestContext, setContext, resetContext,
  type TestContext,
} from "../context.js";
import { parseTranscriptUsage } from "../claude.js";

let ctx: TestContext;

beforeEach(() => {
  if (ctx) ctx.cleanup();
  ctx = createTestContext();
  setContext(ctx);
});

afterAll(() => {
  if (ctx) ctx.cleanup();
  resetContext();
});

function writeTranscript(name: string, lines: Record<string, unknown>[]): string {
  const path = join(ctx.arkDir, `${name}.jsonl`);
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

describe("parseTranscriptUsage", () => {
  it("sums input and output tokens across assistant messages", () => {
    const path = writeTranscript("basic", [
      { type: "user", message: { role: "user", content: "hello" } },
      { type: "assistant", message: { role: "assistant", usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 10 } } },
      { type: "user", message: { role: "user", content: "more" } },
      { type: "assistant", message: { role: "assistant", usage: { input_tokens: 150, output_tokens: 75, cache_read_input_tokens: 300, cache_creation_input_tokens: 5 } } },
    ]);
    const usage = parseTranscriptUsage(path);
    expect(usage.input_tokens).toBe(250);
    expect(usage.output_tokens).toBe(125);
    expect(usage.cache_read_input_tokens).toBe(500);
    expect(usage.cache_creation_input_tokens).toBe(15);
  });

  it("returns zeros for empty transcript", () => {
    const path = writeTranscript("empty", []);
    const usage = parseTranscriptUsage(path);
    expect(usage.input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(0);
  });

  it("skips non-assistant messages", () => {
    const path = writeTranscript("mixed", [
      { type: "user", message: { role: "user", content: "hi" } },
      { type: "assistant", message: { role: "assistant", usage: { input_tokens: 100, output_tokens: 50 } } },
      { type: "last-prompt", lastPrompt: "test" },
    ]);
    const usage = parseTranscriptUsage(path);
    expect(usage.input_tokens).toBe(100);
    expect(usage.output_tokens).toBe(50);
  });

  it("handles missing usage fields gracefully", () => {
    const path = writeTranscript("no-usage", [
      { type: "assistant", message: { role: "assistant", content: "no usage" } },
    ]);
    const usage = parseTranscriptUsage(path);
    expect(usage.input_tokens).toBe(0);
  });

  it("returns zeros for non-existent file", () => {
    const usage = parseTranscriptUsage("/tmp/does-not-exist.jsonl");
    expect(usage.input_tokens).toBe(0);
  });

  it("calculates total_tokens as sum of all token fields", () => {
    const path = writeTranscript("totals", [
      { type: "assistant", message: { role: "assistant", usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 10 } } },
    ]);
    const usage = parseTranscriptUsage(path);
    expect(usage.total_tokens).toBe(360);
  });
});
