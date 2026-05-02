/**
 * agent-sdk runtime: emit AgentMessage hooks for assistant text + thinking
 * blocks so the UI can show what the agent is reasoning about between
 * tool calls.
 *
 * Pre-fix `messageToHooks` only emitted PreToolUse for tool_use blocks and
 * silently dropped every other content block. Users saw a stream of
 * Bash/Edit/Read with no human-readable narration -- couldn't tell what
 * the agent was doing or planning.
 */

import { describe, expect, test } from "bun:test";
import { messageToHooks } from "../launch.js";

const SID = "s-test";

describe("messageToHooks -- AgentMessage emission", () => {
  test("emits AgentMessage for assistant text blocks", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Looking at the file structure first." }],
      },
    };
    const hooks = messageToHooks(msg, SID);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].hook_event_name).toBe("AgentMessage");
    expect(hooks[0].text).toBe("Looking at the file structure first.");
    expect(hooks[0].thinking).toBeUndefined();
  });

  test("tags thinking blocks with thinking:true", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [{ type: "thinking", thinking: "Let me reason through this..." }],
      },
    };
    const hooks = messageToHooks(msg, SID);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].hook_event_name).toBe("AgentMessage");
    expect(hooks[0].text).toBe("Let me reason through this...");
    expect(hooks[0].thinking).toBe(true);
  });

  test("interleaves text + tool_use in source order", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "I'll read the file first." },
          { type: "tool_use", id: "t1", name: "Read", input: { path: "/x" } },
          { type: "text", text: "Now I'll edit it." },
          { type: "tool_use", id: "t2", name: "Edit", input: { path: "/x", new: "..." } },
        ],
      },
    };
    const hooks = messageToHooks(msg, SID);
    expect(hooks).toHaveLength(4);
    expect(hooks[0].hook_event_name).toBe("AgentMessage");
    expect(hooks[1].hook_event_name).toBe("PreToolUse");
    expect(hooks[2].hook_event_name).toBe("AgentMessage");
    expect(hooks[3].hook_event_name).toBe("PreToolUse");
  });

  test("drops empty/whitespace text blocks", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "" },
          { type: "text", text: "   \n  " },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        ],
      },
    };
    const hooks = messageToHooks(msg, SID);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].hook_event_name).toBe("PreToolUse");
  });

  test("non-assistant message types still pass through unchanged", () => {
    // Sanity: tool_result handling shouldn't change.
    const msg = {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false }],
      },
    };
    const hooks = messageToHooks(msg, SID);
    expect(hooks).toHaveLength(1);
    expect(hooks[0].hook_event_name).toBe("PostToolUse");
  });
});
