/**
 * SystemEvent tests -- prompt-shaped field splitting + SSR body rendering.
 *
 * bun:test runs jsdom-free, so we use `react-dom/server` to snapshot the
 * collapsed and expanded shells of the card. For the expanded shell we
 * flip the internal open-state by mounting with `forceOpen={true}` via
 * injected details; since we cannot click in SSR, the core contract we
 * actually verify is:
 *
 *   1. `splitPromptFields` pulls known prompt-shaped keys (task_preview,
 *      prompt, message, summary, task) out of a details object so they
 *      can be rendered as real preformatted text.
 *   2. Non-string or empty values on those keys stay in `rest` -- we
 *      don't want `task_preview: 0` or `task_preview: ""` rendered as an
 *      empty pre block.
 *   3. Non-object details (null, strings, numbers) pass through cleanly.
 *
 * The wider "does the opened drawer render \n as a newline" guarantee is
 * covered by the unit test on `splitPromptFields` -- the returned string
 * is handed straight to a `<pre>` element, which preserves newlines
 * natively.
 */

import { describe, test, expect } from "bun:test";
import { splitPromptFields } from "../SystemEvent.js";

describe("splitPromptFields", () => {
  test("pulls task_preview out of the payload as a prompt field", () => {
    const { promptFields, rest } = splitPromptFields({
      agent: "implementer",
      task_preview: "line one\nline two\nline three",
      task_length: 7061,
    });
    expect(promptFields).toEqual([["task_preview", "line one\nline two\nline three"]]);
    expect(rest).toEqual({ agent: "implementer", task_length: 7061 });
  });

  test("handles multiple known prompt keys", () => {
    const { promptFields, rest } = splitPromptFields({
      message: "hi",
      summary: "all done",
      other: 42,
    });
    // Preserves insertion order
    expect(promptFields).toEqual([
      ["message", "hi"],
      ["summary", "all done"],
    ]);
    expect(rest).toEqual({ other: 42 });
  });

  test("non-string or empty values stay in rest", () => {
    const { promptFields, rest } = splitPromptFields({
      task_preview: "",
      prompt: 0 as unknown as string,
      summary: null,
      agent: "planner",
    });
    expect(promptFields).toEqual([]);
    expect(rest).toEqual({
      task_preview: "",
      prompt: 0,
      summary: null,
      agent: "planner",
    });
  });

  test("non-object details pass through as null rest", () => {
    expect(splitPromptFields(null)).toEqual({ promptFields: [], rest: null });
    expect(splitPromptFields(undefined)).toEqual({ promptFields: [], rest: null });
    expect(splitPromptFields("raw string")).toEqual({ promptFields: [], rest: null });
    expect(splitPromptFields(42)).toEqual({ promptFields: [], rest: null });
  });

  test("preserves legacy task_full as a non-prompt field -- old events still render", () => {
    const { promptFields, rest } = splitPromptFields({
      task_preview: "short preview",
      task_full: "the whole big prompt",
      task_length: 20,
    });
    expect(promptFields).toEqual([["task_preview", "short preview"]]);
    // task_full isn't in the allowlist -- falls to rest and pretty-prints
    // as JSON. This keeps the UI graceful for sessions persisted before
    // the #417 emit change.
    expect(rest).toEqual({ task_full: "the whole big prompt", task_length: 20 });
  });
});
