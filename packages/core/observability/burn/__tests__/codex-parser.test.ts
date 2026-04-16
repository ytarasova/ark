import { describe, it, expect } from "bun:test";
import { join } from "path";
import { CodexBurnParser } from "../parsers/codex.js";

const FIXTURE_PATH = join(import.meta.dir, "fixtures", "codex-session.jsonl");

describe("CodexBurnParser", () => {
  const parser = new CodexBurnParser();

  it("has kind 'codex'", () => {
    expect(parser.kind).toBe("codex");
  });

  it("parses the correct number of turns", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    // 6 user messages -> 6 turns:
    //   1: cat (exploration/Read)
    //   2: apply_patch (coding/Edit)
    //   3: pytest (testing/Bash)
    //   4: git add + git commit (git/Bash)
    //   5: apply_patch + pytest(fail) + apply_patch (coding with retry)
    //   6: no tools, conversation
    expect(turns.length).toBe(6);
  });

  it("normalizes cat to Read tool", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    const turn1 = turns[0];
    const tools = turn1.assistantCalls.flatMap((c) => c.tools);
    expect(tools).toContain("Read");
  });

  it("normalizes apply_patch to Edit tool", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    const turn2 = turns[1];
    const tools = turn2.assistantCalls.flatMap((c) => c.tools);
    expect(tools).toContain("Edit");
  });

  it("normalizes pytest to Bash tool", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    const turn3 = turns[2];
    const tools = turn3.assistantCalls.flatMap((c) => c.tools);
    expect(tools).toContain("Bash");
  });

  it("normalizes git commands to Bash tool", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    const turn4 = turns[3];
    const tools = turn4.assistantCalls.flatMap((c) => c.tools);
    expect(tools).toContain("Bash");
  });

  it("detects has_edits for apply_patch turns", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    // Turn 2 (apply_patch) should have edits
    expect(turns[1].hasEdits).toBe(true);
    // Turn 5 (apply_patch + pytest + apply_patch) should have edits
    expect(turns[4].hasEdits).toBe(true);
    // Turn 1 (cat/Read) should not have edits
    expect(turns[0].hasEdits).toBe(false);
    // Turn 3 (pytest/testing) should not have edits
    expect(turns[2].hasEdits).toBe(false);
  });

  it("detects retries in apply_patch -> pytest -> apply_patch sequence", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    // Turn 5: apply_patch -> pytest(fail) -> apply_patch = retry
    expect(turns[4].retries).toBeGreaterThan(0);
    expect(turns[4].isOneShot).toBe(false);
  });

  it("marks single apply_patch as one-shot (no retries)", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    // Turn 2: single apply_patch = one-shot
    expect(turns[1].retries).toBe(0);
    expect(turns[1].isOneShot).toBe(true);
  });

  it("classifies exploration turn correctly", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    // Turn 1: cat -> Read tool -> exploration
    expect(turns[0].category).toBe("exploration");
  });

  it("classifies coding turn correctly", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    // Turn 2: apply_patch -> Edit -> coding (or feature based on keyword)
    expect(["coding", "feature"]).toContain(turns[1].category);
  });

  it("classifies testing turn correctly", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    // Turn 3: pytest -> testing
    expect(turns[2].category).toBe("testing");
  });

  it("classifies git turn correctly", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    // Turn 4: git commit -> git
    expect(turns[3].category).toBe("git");
  });

  it("classifies conversation turn (no tools)", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    // Turn 6: no tools, just text -> conversation
    expect(turns[5].category).toBe("conversation");
  });

  it("extracts token usage per turn", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    // Turn 1 has last_token_usage with input=500, output=100, reasoning=20
    const call = turns[0].assistantCalls[0];
    expect(call.usage.inputTokens).toBe(500);
    expect(call.usage.outputTokens).toBe(120); // 100 + 20 reasoning
  });

  it("sets provider to openai for all calls", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    for (const turn of turns) {
      for (const call of turn.assistantCalls) {
        expect(call.provider).toBe("openai");
      }
    }
  });

  it("sets model from turn_context", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    for (const turn of turns) {
      for (const call of turn.assistantCalls) {
        expect(call.model).toBe("gpt-5.1-codex-max");
      }
    }
  });

  it("builds a valid session summary", () => {
    const { summary } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    expect(summary.project).toBe("testproject");
    expect(summary.turns.length).toBe(6);
    expect(summary.apiCalls).toBeGreaterThan(0);
    expect(summary.totalInputTokens).toBeGreaterThan(0);
    expect(summary.totalOutputTokens).toBeGreaterThan(0);
  });

  it("returns empty turns for nonexistent file", () => {
    const { turns, summary } = parser.parseTranscript("/nonexistent/path.jsonl", "test");
    expect(turns.length).toBe(0);
    expect(summary.apiCalls).toBe(0);
  });

  it("has empty mcpTools for all turns", () => {
    const { turns } = parser.parseTranscript(FIXTURE_PATH, "testproject");
    for (const turn of turns) {
      for (const call of turn.assistantCalls) {
        expect(call.mcpTools).toEqual([]);
      }
    }
  });
});
