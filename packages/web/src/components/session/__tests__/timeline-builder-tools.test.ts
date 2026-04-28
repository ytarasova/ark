/**
 * Smoke test for tool-call rendering in buildConversationTimeline.
 *
 * Covers the three shapes the UI has to handle:
 *
 *   1. Agent-SDK shape. PreToolUse carries {tool_name, tool_use_id,
 *      tool_input}; PostToolUse carries only {tool_use_id,
 *      tool_result_content, is_error}. The builder must pair them by
 *      tool_use_id and end up with a single row that keeps the Pre's name
 *      and inherits the Post's output -- not a ghost `tool {}` row.
 *
 *   2. Legacy / conductor shape. Both events carry {tool_name} and Post
 *      carries the output under tool_response. The builder still pairs.
 *
 *   3. Orphan PostToolUse. A PostToolUse with no matching PreToolUse is
 *      dropped rather than rendered as a synthesized empty card.
 *
 * Pre-fix, shape (1) produced exactly the `tool {}` empties the user
 * reported (Post fell through the pending-name lookup, the fallback branch
 * pushed a row with name "tool" and no output).
 */

import { describe, expect, test } from "bun:test";
import { buildConversationTimeline } from "../timeline-builder.js";

function ev(type: string, data: Record<string, unknown>, createdAt = "2026-04-24T10:00:00Z") {
  return { type, data, created_at: createdAt };
}

describe("buildConversationTimeline -- tool pairing", () => {
  test("agent-sdk shape: pairs by tool_use_id even when Post lacks tool_name", () => {
    const events = [
      ev(
        "hook_status",
        {
          event: "PreToolUse",
          tool_name: "Read",
          tool_use_id: "toolu_ABC",
          tool_input: { file_path: "/tmp/foo.txt" },
        },
        "2026-04-24T10:00:00Z",
      ),
      ev(
        "hook_status",
        {
          event: "PostToolUse",
          tool_use_id: "toolu_ABC",
          tool_result_content: "hello world",
          is_error: false,
        },
        "2026-04-24T10:00:01Z",
      ),
    ];

    const items = buildConversationTimeline(events, [], null);
    const tools = items.filter((i) => i.kind === "tool");

    expect(tools).toHaveLength(1);
    expect(tools[0].toolName).toBe("Read");
    expect(tools[0].status).toBe("done");
    expect(tools[0].toolOutput).toBe("hello world");
    expect(tools[0].toolInput).toEqual({ file_path: "/tmp/foo.txt" });
  });

  test("agent-sdk shape with is_error: marks the merged row failed", () => {
    const events = [
      ev("hook_status", {
        event: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "toolu_ERR",
        tool_input: { command: "false" },
      }),
      ev("hook_status", {
        event: "PostToolUse",
        tool_use_id: "toolu_ERR",
        tool_result_content: "exit 1",
        is_error: true,
      }),
    ];

    const items = buildConversationTimeline(events, [], null);
    const tools = items.filter((i) => i.kind === "tool");

    expect(tools).toHaveLength(1);
    expect(tools[0].status).toBe("error");
    expect(tools[0].toolOutput).toBe("exit 1");
  });

  test("legacy shape: Pre + Post both carry tool_name, Post carries tool_response", () => {
    const events = [
      ev("hook_status", {
        event: "PreToolUse",
        tool_name: "Grep",
        tool_input: { pattern: "foo" },
      }),
      ev("hook_status", {
        event: "PostToolUse",
        tool_name: "Grep",
        tool_response: "match found",
      }),
    ];

    const items = buildConversationTimeline(events, [], null);
    const tools = items.filter((i) => i.kind === "tool");

    expect(tools).toHaveLength(1);
    expect(tools[0].toolName).toBe("Grep");
    expect(tools[0].toolOutput).toBe("match found");
  });

  test("parallel same-name tool calls pair by id, not by name", () => {
    // Two Bash calls in flight at once; without id-based matching they'd
    // collide on the name key and one Post would look orphaned.
    const events = [
      ev(
        "hook_status",
        {
          event: "PreToolUse",
          tool_name: "Bash",
          tool_use_id: "toolu_A",
          tool_input: { command: "ls" },
        },
        "2026-04-24T10:00:00Z",
      ),
      ev(
        "hook_status",
        {
          event: "PreToolUse",
          tool_name: "Bash",
          tool_use_id: "toolu_B",
          tool_input: { command: "pwd" },
        },
        "2026-04-24T10:00:01Z",
      ),
      ev(
        "hook_status",
        {
          event: "PostToolUse",
          tool_use_id: "toolu_B",
          tool_result_content: "/tmp",
        },
        "2026-04-24T10:00:02Z",
      ),
      ev(
        "hook_status",
        {
          event: "PostToolUse",
          tool_use_id: "toolu_A",
          tool_result_content: "file1\nfile2",
        },
        "2026-04-24T10:00:03Z",
      ),
    ];

    const items = buildConversationTimeline(events, [], null);
    const tools = items.filter((i) => i.kind === "tool");

    expect(tools).toHaveLength(2);
    // Order matches the Pre ordering -- the Post merges back into its Pre row.
    expect(tools[0].toolInput).toEqual({ command: "ls" });
    expect(tools[0].toolOutput).toBe("file1\nfile2");
    expect(tools[1].toolInput).toEqual({ command: "pwd" });
    expect(tools[1].toolOutput).toBe("/tmp");
  });

  test("orphan PostToolUse is dropped, not rendered as an empty ghost row", () => {
    // A PostToolUse arriving with no prior PreToolUse (snapshot boundary,
    // stream resync, whatever). Pre-fix this produced `tool {}` with no
    // output. Now: silently skipped.
    const events = [
      ev("hook_status", {
        event: "PostToolUse",
        tool_use_id: "toolu_ORPHAN",
        tool_result_content: "whatever",
      }),
    ];

    const items = buildConversationTimeline(events, [], null);
    const tools = items.filter((i) => i.kind === "tool");

    expect(tools).toHaveLength(0);
  });

  test("orphan PreToolUse on a terminal session flips to interrupted, not stuck running", () => {
    // The session ended (timeout / stop / kill) before the runtime emitted
    // a PostToolUse. Pre-fix this rendered as RUNNING with a spinner and a
    // "stop ^C" affordance forever -- visually wrong on a finished flow.
    // Real incident: PAI-31995 dispatch hit the for_each timeout while a
    // bash gradle find was in flight.
    const events = [
      ev("hook_status", {
        event: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "toolu_STUCK",
        tool_input: { command: "find /root/.gradle -name spring-webflux*" },
      }),
    ];
    const session = { status: "completed" };

    const items = buildConversationTimeline(events, [], session);
    const tools = items.filter((i) => i.kind === "tool");

    expect(tools).toHaveLength(1);
    expect(tools[0].status).toBe("interrupted");
  });

  test("agent_message events render as inline agent narration", () => {
    // The agent-sdk runtime emits an AgentMessage hook for the model's
    // narration text between tool calls. The conductor logs these as
    // `agent_message` events. The timeline must surface them as agent
    // items so the user can see what the agent is thinking, not just a
    // stream of opaque tool blocks.
    const events = [
      {
        type: "agent_message",
        data: { text: "Looking at the file structure first." },
        created_at: "2026-04-26T10:00:00Z",
      },
      ev(
        "hook_status",
        { event: "PreToolUse", tool_name: "Read", tool_use_id: "t1", tool_input: { path: "x" } },
        "2026-04-26T10:00:01Z",
      ),
      ev(
        "hook_status",
        { event: "PostToolUse", tool_use_id: "t1", tool_result_content: "data" },
        "2026-04-26T10:00:02Z",
      ),
      { type: "agent_message", data: { text: "Now updating the function." }, created_at: "2026-04-26T10:00:03Z" },
    ];
    const items = buildConversationTimeline(events, [], { agent: "implementer" });
    const agentItems = items.filter((i) => i.kind === "agent");
    expect(agentItems).toHaveLength(2);
    expect(agentItems[0].content).toBe("Looking at the file structure first.");
    expect(agentItems[0].isThinking).toBeFalsy();
    expect(agentItems[1].content).toBe("Now updating the function.");
  });

  test("agent_message with thinking:true is tagged for the renderer to dim", () => {
    const events = [
      {
        type: "agent_message",
        data: { text: "Let me think about this carefully...", thinking: true },
        created_at: "2026-04-26T10:00:00Z",
      },
    ];
    const items = buildConversationTimeline(events, [], {});
    const agentItems = items.filter((i) => i.kind === "agent");
    expect(agentItems).toHaveLength(1);
    expect(agentItems[0].isThinking).toBe(true);
  });

  test("agent_message with empty/whitespace text is dropped", () => {
    const events = [
      { type: "agent_message", data: { text: "" }, created_at: "2026-04-26T10:00:00Z" },
      { type: "agent_message", data: { text: "   \n  " }, created_at: "2026-04-26T10:00:01Z" },
    ];
    const items = buildConversationTimeline(events, [], {});
    expect(items.filter((i) => i.kind === "agent")).toHaveLength(0);
  });

  test("Task subagent body containing API Error is promoted to error status", () => {
    // Real incident: SDK Task tool returns success-shaped response whose
    // body is `[{type:"text", text:"Failed to authenticate. API Error: 403
    // ... not authorized to access model"}]`. is_error stays false because
    // the tool itself returned, but the user-visible body is a 403. The
    // builder must surface that as an error pill so the UI doesn't render
    // an OK status above an obvious failure.
    const events = [
      ev("hook_status", {
        event: "PreToolUse",
        tool_name: "Task",
        tool_use_id: "toolu_TASK_403",
        tool_input: { description: "Explore worktree setup" },
      }),
      ev("hook_status", {
        event: "PostToolUse",
        tool_use_id: "toolu_TASK_403",
        tool_result_content: [
          {
            type: "text",
            text: "Failed to authenticate. API Error: 403 User foo-key is not authorized to access model claude-haiku-4-5-20251001/undefined or model does not exist",
          },
        ],
        is_error: false,
      }),
    ];

    const items = buildConversationTimeline(events, [], null);
    const tools = items.filter((i) => i.kind === "tool");

    expect(tools).toHaveLength(1);
    expect(tools[0].status).toBe("error");
  });

  test("orphan PreToolUse on a still-running session stays running (live tail)", () => {
    // While the session is genuinely live, an unmatched PreToolUse means
    // the tool is in flight -- do NOT prematurely flip it to interrupted.
    const events = [
      ev("hook_status", {
        event: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "toolu_LIVE",
        tool_input: { command: "sleep 10" },
      }),
    ];
    const session = { status: "running" };

    const items = buildConversationTimeline(events, [], session);
    const tools = items.filter((i) => i.kind === "tool");

    expect(tools).toHaveLength(1);
    expect(tools[0].status).toBe("running");
  });
});
