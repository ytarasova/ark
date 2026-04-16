/**
 * Tests for review.ts -- structured review output parser.
 */

import { describe, it, expect } from "bun:test";
import { parseReviewOutput, type ReviewIssue } from "../review.js";

describe("structured review output", () => {
  it("parses review JSON from agent output", () => {
    const output = `
Here are the issues I found:

\`\`\`json
{
  "issues": [
    {"severity": "P0", "file": "src/auth.ts", "line": 42, "title": "SQL injection", "description": "User input passed directly to query"},
    {"severity": "P2", "file": "src/api.ts", "line": 10, "title": "Missing error handling", "description": "Fetch call has no catch"}
  ],
  "summary": "Found 1 critical and 1 minor issue",
  "approved": false
}
\`\`\`
    `;

    const review = parseReviewOutput(output);
    expect(review).not.toBeNull();
    expect(review!.issues).toHaveLength(2);
    expect(review!.issues[0].severity).toBe("P0");
    expect(review!.issues[0].file).toBe("src/auth.ts");
    expect(review!.issues[0].line).toBe(42);
    expect(review!.issues[0].title).toBe("SQL injection");
    expect(review!.issues[1].severity).toBe("P2");
    expect(review!.summary).toBe("Found 1 critical and 1 minor issue");
    expect(review!.approved).toBe(false);
  });

  it("returns null for non-structured output", () => {
    const output = "Looks good to me, no issues found.";
    expect(parseReviewOutput(output)).toBeNull();
  });

  it("handles approved reviews with empty issues", () => {
    const output = '```json\n{"issues": [], "summary": "All clear", "approved": true}\n```';
    const review = parseReviewOutput(output);
    expect(review).not.toBeNull();
    expect(review!.approved).toBe(true);
    expect(review!.issues).toHaveLength(0);
    expect(review!.summary).toBe("All clear");
  });

  it("returns null for invalid JSON in code fence", () => {
    const output = "```json\n{not valid json}\n```";
    expect(parseReviewOutput(output)).toBeNull();
  });

  it("returns null when issues is not an array", () => {
    const output = '```json\n{"issues": "none", "summary": "ok", "approved": true}\n```';
    expect(parseReviewOutput(output)).toBeNull();
  });

  it("defaults missing fields in issues", () => {
    const output = '```json\n{"issues": [{"severity": "P1"}], "summary": "partial", "approved": false}\n```';
    const review = parseReviewOutput(output);
    expect(review).not.toBeNull();
    expect(review!.issues[0].file).toBe("unknown");
    expect(review!.issues[0].title).toBe("");
    expect(review!.issues[0].line).toBeUndefined();
  });
});
