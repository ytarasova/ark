/**
 * Tests for the Claude transcript parser class.
 * Verifies polymorphic TranscriptParser implementation for Claude Code.
 */
import { describe, it, expect } from "bun:test";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { ClaudeTranscriptParser } from "../runtimes/claude/parser.js";
import { withTestContext } from "./test-helpers.js";

const { getCtx } = withTestContext();
const parser = new ClaudeTranscriptParser();

function writeTranscript(name: string, lines: Record<string, unknown>[]): string {
  const path = join(getCtx().arkDir, `${name}.jsonl`);
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

describe("ClaudeTranscriptParser.parse", () => {
  it("sums input and output tokens across assistant messages", () => {
    const path = writeTranscript("basic", [
      { type: "user", message: { role: "user", content: "hello" } },
      { type: "assistant", message: { role: "assistant", usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 10 } } },
      { type: "user", message: { role: "user", content: "more" } },
      { type: "assistant", message: { role: "assistant", usage: { input_tokens: 150, output_tokens: 75, cache_read_input_tokens: 300, cache_creation_input_tokens: 5 } } },
    ]);
    const result = parser.parse(path);
    expect(result.usage.input_tokens).toBe(250);
    expect(result.usage.output_tokens).toBe(125);
    expect(result.usage.cache_read_tokens).toBe(500);
    expect(result.usage.cache_write_tokens).toBe(15);
  });

  it("returns zeros for empty transcript", () => {
    const path = writeTranscript("empty", []);
    const result = parser.parse(path);
    expect(result.usage.input_tokens).toBe(0);
    expect(result.usage.output_tokens).toBe(0);
  });

  it("skips non-assistant messages", () => {
    const path = writeTranscript("mixed", [
      { type: "user", message: { role: "user", content: "hi" } },
      { type: "assistant", message: { role: "assistant", usage: { input_tokens: 100, output_tokens: 50 } } },
      { type: "last-prompt", lastPrompt: "test" },
    ]);
    const result = parser.parse(path);
    expect(result.usage.input_tokens).toBe(100);
    expect(result.usage.output_tokens).toBe(50);
  });

  it("handles missing usage fields gracefully", () => {
    const path = writeTranscript("no-usage", [
      { type: "assistant", message: { role: "assistant", content: "no usage" } },
    ]);
    const result = parser.parse(path);
    expect(result.usage.input_tokens).toBe(0);
  });

  it("returns zeros for non-existent file", () => {
    const result = parser.parse("/tmp/does-not-exist.jsonl");
    expect(result.usage.input_tokens).toBe(0);
  });
});

describe("ClaudeTranscriptParser.findForSession", () => {
  it("constructs exact path when sessionIdLookup returns an id", () => {
    const workdir = getCtx().arkDir + "/fake-repo";
    mkdirSync(workdir, { recursive: true });

    // Write a fake transcript at the exact path Claude would use
    const slug = workdir.replace(/\//g, "-").replace(/\./g, "-");
    const projectsDir = join(getCtx().arkDir, "fake-projects");
    const projDir = join(projectsDir, slug);
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "test-session-id.jsonl"),
      JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 42, output_tokens: 7 } } }) + "\n"
    );

    const p = new ClaudeTranscriptParser(projectsDir, () => "test-session-id");
    const found = p.findForSession({ workdir });
    expect(found).toContain("test-session-id.jsonl");

    const r = p.parse(found!);
    expect(r.usage.input_tokens).toBe(42);
    expect(r.usage.output_tokens).toBe(7);
  });

  it("returns null when project dir doesn't exist", () => {
    const p = new ClaudeTranscriptParser("/tmp/nonexistent-claude-projects");
    const found = p.findForSession({ workdir: "/tmp/some-repo" });
    expect(found).toBeNull();
  });
});
