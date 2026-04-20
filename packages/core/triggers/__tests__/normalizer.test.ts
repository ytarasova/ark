import { describe, expect, test } from "bun:test";
import { buildEvent, evalJsonPath, parseJsonBody, renderTemplate, timingSafeStringEqual } from "../normalizer.js";

describe("parseJsonBody", () => {
  test("round-trips valid JSON", () => {
    const v = parseJsonBody('{"x":1}') as { x: number };
    expect(v.x).toBe(1);
  });

  test("throws SyntaxError for malformed input", () => {
    expect(() => parseJsonBody("not json")).toThrow(SyntaxError);
  });
});

describe("buildEvent", () => {
  test("stamps receivedAt when not supplied", () => {
    const before = Date.now();
    const e = buildEvent({ source: "x", event: "y", payload: {} });
    expect(e.receivedAt).toBeGreaterThanOrEqual(before);
  });

  test("preserves caller-provided receivedAt", () => {
    const e = buildEvent({ source: "x", event: "y", payload: {}, receivedAt: 42 });
    expect(e.receivedAt).toBe(42);
  });
});

describe("evalJsonPath", () => {
  const ev = buildEvent({
    source: "github",
    event: "pr.opened",
    ref: "feature/x",
    payload: { pull_request: { number: 7, head: { ref: "branchy" } }, labels: ["a", "b"] },
  });

  test("resolves dotted path under payload", () => {
    expect(evalJsonPath("$.payload.pull_request.head.ref", ev)).toBe("branchy");
  });

  test("resolves top-level event fields", () => {
    expect(evalJsonPath("$.ref", ev)).toBe("feature/x");
    expect(evalJsonPath("$.event", ev)).toBe("pr.opened");
  });

  test("array indexing", () => {
    expect(evalJsonPath("$.payload.labels[1]", ev)).toBe("b");
  });

  test("missing fields return undefined", () => {
    expect(evalJsonPath("$.payload.missing.deep", ev)).toBeUndefined();
  });

  test("non-$ expressions are returned verbatim (literal mode)", () => {
    expect(evalJsonPath("just-a-string", ev)).toBe("just-a-string");
  });

  test("lone $ returns the full envelope", () => {
    const root = evalJsonPath("$", ev) as { source: string };
    expect(root.source).toBe("github");
  });
});

describe("renderTemplate", () => {
  const ev = buildEvent({
    source: "github",
    event: "pr.opened",
    payload: { title: "Fix bug", number: 42 },
  });

  test("expands $.payload.x placeholders", () => {
    expect(renderTemplate("PR $.payload.number: $.payload.title", ev)).toBe("PR 42: Fix bug");
  });

  test("returns input as-is when no $ present", () => {
    expect(renderTemplate("plain literal", ev)).toBe("plain literal");
  });

  test("missing placeholder collapses to empty string", () => {
    expect(renderTemplate("user=$.payload.user", ev)).toBe("user=");
  });
});

describe("timingSafeStringEqual", () => {
  test("equal strings", () => {
    expect(timingSafeStringEqual("abc", "abc")).toBe(true);
  });

  test("different length returns false without oracle", () => {
    expect(timingSafeStringEqual("abc", "abcd")).toBe(false);
  });

  test("different strings same length", () => {
    expect(timingSafeStringEqual("abc", "xyz")).toBe(false);
  });
});
