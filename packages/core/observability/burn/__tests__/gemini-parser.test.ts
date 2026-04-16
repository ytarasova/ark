import { describe, it, expect } from "bun:test";
import { join } from "path";
import { GeminiBurnParser } from "../parsers/gemini.js";

const FIXTURE_PATH = join(import.meta.dir, "fixtures", "gemini-session.jsonl");

describe("GeminiBurnParser", () => {
  const parser = new GeminiBurnParser();

  it("has kind 'gemini'", () => {
    expect(parser.kind).toBe("gemini");
  });

  it("parses the correct number of turns", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    // 4 user messages -> 4 turns
    expect(turns.length).toBe(4);
  });

  it("classifies debugging turn via keywords", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    // Turn 1: "Fix the bug in the authentication module" -> debugging
    expect(turns[0].category).toBe("debugging");
  });

  it("classifies feature turn via keywords", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    // Turn 2: "Now add a new endpoint for user registration" -> feature
    expect(turns[1].category).toBe("feature");
  });

  it("classifies brainstorming turn via keywords", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    // Turn 3: "Brainstorm ideas for improving the API design" -> brainstorming
    expect(turns[2].category).toBe("brainstorming");
  });

  it("classifies conversation turn (no keywords)", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    // Turn 4: "Thanks, that looks great" -> conversation
    expect(turns[3].category).toBe("conversation");
  });

  it("has empty tools for all turns", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    for (const turn of turns) {
      for (const call of turn.assistantCalls) {
        expect(call.tools).toEqual([]);
      }
    }
  });

  it("has empty mcpTools for all turns", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    for (const turn of turns) {
      for (const call of turn.assistantCalls) {
        expect(call.mcpTools).toEqual([]);
      }
    }
  });

  it("has empty bashCommands for all turns", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    for (const turn of turns) {
      for (const call of turn.assistantCalls) {
        expect(call.bashCommands).toEqual([]);
      }
    }
  });

  it("has_edits is always false", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    for (const turn of turns) {
      expect(turn.hasEdits).toBe(false);
    }
  });

  it("retries is always 0", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    for (const turn of turns) {
      expect(turn.retries).toBe(0);
    }
  });

  it("isOneShot is always false", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    for (const turn of turns) {
      expect(turn.isOneShot).toBe(false);
    }
  });

  it("extracts token usage from gemini messages", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    // Turn 1 has tokens: input=500, output=200, thoughts=50, cached=100
    const call = turns[0].assistantCalls[0];
    expect(call.usage.inputTokens).toBe(500);
    expect(call.usage.outputTokens).toBe(250); // 200 output + 50 thoughts
    expect(call.usage.cacheReadInputTokens).toBe(100);
    expect(call.usage.reasoningTokens).toBe(50);
  });

  it("sets provider to google for all calls", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    for (const turn of turns) {
      for (const call of turn.assistantCalls) {
        expect(call.provider).toBe("google");
      }
    }
  });

  it("sets model from gemini messages", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    for (const turn of turns) {
      for (const call of turn.assistantCalls) {
        expect(call.model).toBe("gemini-2.5-pro");
      }
    }
  });

  it("builds a valid session summary", () => {
    const { summary } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    expect(summary.project).toBe("testproject");
    expect(summary.turns.length).toBe(4);
    expect(summary.apiCalls).toBe(4);
    expect(summary.totalInputTokens).toBeGreaterThan(0);
    expect(summary.totalOutputTokens).toBeGreaterThan(0);
  });

  it("returns empty turns for nonexistent file", () => {
    const { turns, summary } = parser.parseTranscript("/nonexistent/path.jsonl", "test");
    expect(turns.length).toBe(0);
    expect(summary.apiCalls).toBe(0);
  });
});
