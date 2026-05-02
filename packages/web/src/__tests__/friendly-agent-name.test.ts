/**
 * `friendlyAgentName(session)` -- pick a display label that doesn't leak the
 * literal "inline" placeholder into the UI.
 *
 * Pre-fix the typing indicator and a couple of fallback labels showed
 * "inline is typing" on inline-flow dispatches, because the agent's
 * `name` field in the YAML defaulted to "inline" and that propagated all
 * the way to `session.agent`. We now strip the placeholder at the display
 * layer and fall back to the inline-flow stage's runtime ("claude-agent"),
 * with a final default of null so callers can substitute "agent".
 */

import { describe, expect, test } from "bun:test";
import { friendlyAgentName } from "../lib/inline-display.js";

describe("friendlyAgentName", () => {
  test("returns the real agent name when set and not the placeholder", () => {
    expect(friendlyAgentName({ agent: "implementer" })).toBe("implementer");
  });

  test("ignores the literal 'inline' placeholder and falls back to runtime", () => {
    const session = {
      agent: "inline",
      stage: "implement",
      config: {
        inline_flow: {
          stages: [{ name: "implement", agent: { runtime: "claude-agent", model: "sonnet" } }],
        },
      },
    };
    expect(friendlyAgentName(session)).toBe("claude-agent");
  });

  test("uses the matching stage's runtime, not just the first stage", () => {
    const session = {
      agent: "inline",
      stage: "review",
      config: {
        inline_flow: {
          stages: [
            { name: "implement", agent: { runtime: "claude-agent" } },
            { name: "review", agent: { runtime: "claude-code" } },
          ],
        },
      },
    };
    expect(friendlyAgentName(session)).toBe("claude-code");
  });

  test("handles runtime as an object with a `name` field", () => {
    const session = {
      agent: "inline",
      config: {
        inline_flow: {
          stages: [{ name: "main", agent: { runtime: { name: "goose", version: "1" } } }],
        },
      },
    };
    expect(friendlyAgentName(session)).toBe("goose");
  });

  test("returns null when there is nothing to display", () => {
    expect(friendlyAgentName({ agent: "inline" })).toBeNull();
    expect(friendlyAgentName({})).toBeNull();
    expect(friendlyAgentName(null)).toBeNull();
  });

  test("falls back to first stage when session.stage doesn't match any defined stage", () => {
    const session = {
      agent: "inline",
      stage: "unknown-stage",
      config: {
        inline_flow: {
          stages: [{ name: "implement", agent: { runtime: "claude-agent" } }],
        },
      },
    };
    expect(friendlyAgentName(session)).toBe("claude-agent");
  });
});
