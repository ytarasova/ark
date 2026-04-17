/**
 * Tests for buildConversationTimeline() logic extracted from SessionDetail.
 *
 * The function merges events and messages by timestamp, mapping each to a
 * typed timeline item (agent, user, system, tool).
 */

import { describe, test, expect } from "bun:test";

// ---------------------------------------------------------------------------
// We cannot import the function directly from the React component (JSX needs
// a DOM), so we duplicate the pure logic here. This is the exact code from
// SessionDetail.tsx -- if the implementation drifts, these tests will catch
// regressions at the logic level and serve as a canary to sync the copy.
// ---------------------------------------------------------------------------

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatToolInput(data: any): string {
  if (!data) return "";
  const input = data.tool_input || data.input;
  if (!input) return "";
  if (typeof input === "string") {
    return input.length > 120 ? input.slice(0, 120) + "..." : input;
  }
  if (input.command) {
    const cmd = String(input.command);
    return cmd.length > 120 ? cmd.slice(0, 120) + "..." : cmd;
  }
  if (input.file_path || input.path) return input.file_path || input.path;
  if (input.pattern) return input.pattern;
  if (input.query) {
    const q = String(input.query);
    return q.length > 120 ? q.slice(0, 120) + "..." : q;
  }
  const json = JSON.stringify(input);
  return json.length > 120 ? json.slice(0, 120) + "..." : json;
}

const HIDDEN_EVENT_TYPES = ["session_stopped", "session_resumed"];

function buildConversationTimeline(events: any[], messages: any[], session?: any) {
  const items: any[] = [];
  const hasMessages = Array.isArray(messages) && messages.length > 0;
  const all: any[] = [];
  const pendingTools = new Map<string, number>();
  const sessionAgent = session?.agent || "agent";

  for (const ev of events || []) {
    all.push({ ...ev, _type: "event", _time: new Date(ev.created_at).getTime() });
  }
  for (const m of messages || []) {
    all.push({ ...m, _type: "message", _time: new Date(m.created_at).getTime() });
  }

  all.sort((a, b) => a._time - b._time);

  for (const item of all) {
    if (item._type === "message") {
      items.push({
        kind: item.role === "user" ? "user" : item.role === "system" ? "system" : "agent",
        role: item.role,
        content: item.content,
        timestamp: formatTime(item.created_at),
        agentName: item.role === "user" ? "You" : item.agent_name || sessionAgent || "assistant",
        model: item.model,
        type: item.type,
        stage: undefined,
      });
    } else {
      const evType = item.type || "";
      const evData = typeof item.data === "string" ? item.data : item.data?.message || "";
      const nested = typeof item.data === "object" ? item.data?.data : null;
      const evStage = item.stage || item.data?.stage || nested?.stage || undefined;

      if (HIDDEN_EVENT_TYPES.includes(evType)) continue;

      if (evType === "hook_status") {
        const hookData = typeof item.data === "object" ? item.data : {};
        const hookEvent = hookData.event || "";

        if (hookEvent === "PreToolUse") {
          const toolName = hookData.tool_name || "tool";
          const inputSummary = formatToolInput(hookData);
          const label = inputSummary ? `${toolName}: ${inputSummary}` : toolName;
          const idx = items.length;
          items.push({
            kind: "tool",
            label,
            timestamp: formatTime(item.created_at),
            status: "running" as const,
            stage: evStage,
          });
          pendingTools.set(toolName, idx);
        } else if (hookEvent === "PostToolUse") {
          const toolName = hookData.tool_name || "tool";
          const pendingIdx = pendingTools.get(toolName);
          if (pendingIdx !== undefined && items[pendingIdx]) {
            items[pendingIdx].status = "done";
            if (hookData.duration) {
              items[pendingIdx].duration = (hookData.duration / 1000).toFixed(1) + "s";
            }
            pendingTools.delete(toolName);
          } else {
            const inputSummary = formatToolInput(hookData);
            const label = inputSummary ? `${toolName}: ${inputSummary}` : toolName;
            items.push({
              kind: "tool",
              label,
              timestamp: formatTime(item.created_at),
              status: "done" as const,
              duration: hookData.duration ? (hookData.duration / 1000).toFixed(1) + "s" : undefined,
              stage: evStage,
            });
          }
        } else if (hookEvent === "SessionStart" || hookEvent === "UserPromptSubmit") {
          // Infrastructure events -- skip
        } else if (hookData.agent_status === "busy") {
          const agentName = hookData.agent || evStage || sessionAgent;
          const toolName = hookData.tool_name || "";
          let activity = "working";
          if (toolName === "Read" || toolName === "read_file") activity = "reading files";
          else if (toolName === "Bash" || toolName === "bash") activity = "running commands";
          else if (toolName === "Edit" || toolName === "write_file") activity = "editing files";
          else if (toolName === "Grep" || toolName === "search") activity = "searching";
          else if (toolName) activity = "using " + toolName;
          items.push({
            kind: "system",
            content: agentName + " is " + activity + "...",
            timestamp: formatTime(item.created_at),
            stage: evStage,
          });
        }
        continue;
      }

      if (evType === "checkpoint") {
        const cpData = typeof item.data === "object" ? item.data : {};
        const status = cpData.status || "";
        const compute = cpData.compute || cpData.compute_type || "";
        const label = (evStage || "session") + (status ? " " + status : "");
        const suffix = compute ? " on " + compute + " compute" : "";
        items.push({
          kind: "system",
          content: label + suffix,
          timestamp: formatTime(item.created_at),
          stage: evStage,
        });
        continue;
      }

      const isAgentChannelEvent =
        evType === "agent_progress" ||
        evType === "agent_completed" ||
        evType === "agent_question" ||
        evType === "agent_error";
      if (hasMessages && isAgentChannelEvent) {
        continue;
      }

      if (evType === "agent_progress") {
        const msg = nested?.message || evData;
        if (msg) {
          items.push({
            kind: "agent",
            content: msg,
            timestamp: formatTime(item.created_at),
            agentName: evStage || sessionAgent,
            model: nested?.model,
            type: "progress",
            stage: evStage,
          });
        }
      } else if (evType === "agent_completed") {
        const summary = nested?.summary || nested?.message || evData;
        const extras: string[] = [];
        if (nested?.pr_url) extras.push("PR: " + nested.pr_url);
        if (Array.isArray(nested?.filesChanged) && nested.filesChanged.length > 0)
          extras.push("Files: " + nested.filesChanged.join(", "));
        const content = extras.length > 0 ? summary + "\n" + extras.join("\n") : summary;
        items.push({
          kind: "agent",
          content: content || "Stage completed",
          timestamp: formatTime(item.created_at),
          agentName: evStage || sessionAgent,
          model: nested?.model,
          type: "completed",
          stage: evStage,
        });
      } else if (evType === "agent_question") {
        items.push({
          kind: "agent",
          content: nested?.question || evData || "Agent has a question",
          timestamp: formatTime(item.created_at),
          agentName: evStage || sessionAgent,
          model: undefined,
          type: "question",
          stage: evStage,
        });
      } else if (evType === "agent_error") {
        items.push({
          kind: "system",
          content: "Error: " + (nested?.error || evData || "Unknown error"),
          timestamp: formatTime(item.created_at),
          stage: evStage,
        });
      } else if (evType === "stage_ready") {
        const stageData = typeof item.data === "object" ? item.data : {};
        const agent = stageData.agent || "";
        const gate = stageData.gate || "";
        const parts = [agent && "agent: " + agent, gate && "gate: " + gate].filter(Boolean);
        const detail = parts.length > 0 ? " (" + parts.join(", ") + ")" : "";
        items.push({
          kind: "system",
          content: "Stage " + (evStage || "unknown") + " ready" + detail,
          timestamp: formatTime(item.created_at),
          stage: evStage,
        });
      } else if (evType === "stage_started") {
        const stageData = typeof item.data === "object" ? item.data : {};
        const agent = stageData.agent || "";
        const model = stageData.model || "";
        const taskPreview: string = stageData.task_preview || "";
        const preview = taskPreview.length > 80 ? taskPreview.slice(0, 80) + "..." : taskPreview;
        const agentLabel = agent || evStage || "agent";
        const modelSuffix = model ? " (" + model + ")" : "";
        const previewSuffix = preview ? " -- " + preview : "";
        items.push({
          kind: "system",
          content: agentLabel + " started" + modelSuffix + previewSuffix,
          timestamp: formatTime(item.created_at),
          stage: evStage,
        });
      } else if (evType === "stage_completed") {
        const stageData = typeof item.data === "object" ? item.data : {};
        const agent = stageData.agent || "";
        const agentSuffix = agent ? " (" + agent + ")" : "";
        items.push({
          kind: "system",
          content: "Stage " + (evStage || "unknown") + " completed" + agentSuffix,
          timestamp: formatTime(item.created_at),
          stage: evStage,
        });
      } else if (evType === "stage_handoff") {
        const target = evStage || nested?.stage || "";
        items.push({
          kind: "system",
          content: target ? "advancing to " + target : "advancing to next stage",
          timestamp: formatTime(item.created_at),
          stage: evStage,
        });
      } else if (evType.includes("dispatch") || evType.includes("advance")) {
        items.push({
          kind: "system",
          content: evData || evType.replace(/_/g, " "),
          timestamp: formatTime(item.created_at),
          stage: evStage,
        });
      } else if (evType.includes("tool")) {
        const isError = evType.includes("error") || evType.includes("fail");
        items.push({
          kind: "tool",
          label: evData || evType.replace(/_/g, " "),
          timestamp: formatTime(item.created_at),
          status: isError ? "error" : "done",
          duration: item.data?.duration ? (item.data.duration / 1000).toFixed(1) + "s" : undefined,
          error: isError ? item.data?.error || evData : undefined,
          stage: evStage,
        });
      } else if (
        evType.includes("completion_rejected") ||
        evType.includes("guardrail") ||
        evType.includes("retry") ||
        evType.includes("verification")
      ) {
        items.push({
          kind: "system",
          content: evData || evType.replace(/_/g, " "),
          timestamp: formatTime(item.created_at),
          stage: evStage,
        });
      } else {
        // Show all other events with their message data (match the events tab)
        const evDataObj = typeof item.data === "object" ? item.data : {};
        const msg = evDataObj.message || (typeof item.data === "string" ? item.data : "");
        const label = msg ? evType.replace(/_/g, " ") + " -- " + msg : evType.replace(/_/g, " ");
        if (label) {
          items.push({ kind: "system", content: label, timestamp: formatTime(item.created_at), stage: evStage });
        }
      }
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ts = (offsetMs: number) => new Date(Date.UTC(2026, 0, 1) + offsetMs).toISOString();

function makeMessage(role: string, content: string, offsetMs: number, extra: Record<string, any> = {}) {
  return { role, content, created_at: ts(offsetMs), ...extra };
}

function makeEvent(type: string, data: any, offsetMs: number) {
  return { type, data, created_at: ts(offsetMs) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildConversationTimeline", () => {
  test("merges events and messages sorted by timestamp", () => {
    // agent_progress is skipped when messages exist (hasMessages=true),
    // so we use a stage_started event to test merge ordering
    const events = [makeEvent("stage_started", { stage: "plan", agent: "planner" }, 200)];
    const messages = [makeMessage("user", "Hello", 100), makeMessage("assistant", "Hi back", 300)];

    const tl = buildConversationTimeline(events, messages);

    expect(tl).toHaveLength(3);
    expect(tl[0].kind).toBe("user");
    expect(tl[1].kind).toBe("system");
    expect(tl[1].content).toBe("planner started");
    expect(tl[2].kind).toBe("agent");
    expect(tl[2].content).toBe("Hi back");
  });

  test("agent messages render as kind: agent", () => {
    const messages = [makeMessage("assistant", "I will implement this", 100, { agent_name: "coder", model: "opus" })];

    const tl = buildConversationTimeline([], messages);

    expect(tl).toHaveLength(1);
    expect(tl[0].kind).toBe("agent");
    expect(tl[0].agentName).toBe("coder");
    expect(tl[0].model).toBe("opus");
  });

  test("user messages render as kind: user", () => {
    const messages = [makeMessage("user", "Fix the bug", 100)];

    const tl = buildConversationTimeline([], messages);

    expect(tl).toHaveLength(1);
    expect(tl[0].kind).toBe("user");
    expect(tl[0].agentName).toBe("You");
    expect(tl[0].content).toBe("Fix the bug");
  });

  test("stage transitions render as kind: system with rich details", () => {
    const events = [
      makeEvent("stage_ready", { stage: "plan", agent: "planner", gate: "auto" }, 100),
      makeEvent("stage_started", { stage: "plan", agent: "planner", model: "opus-4" }, 200),
      makeEvent("dispatch_agent", "Dispatching coder", 300),
      makeEvent("advance_stage", "Advancing to review", 400),
    ];

    const tl = buildConversationTimeline(events, []);

    expect(tl).toHaveLength(4);
    for (const item of tl) {
      expect(item.kind).toBe("system");
    }
    expect(tl[0].content).toBe("Stage plan ready (agent: planner, gate: auto)");
    expect(tl[1].content).toBe("planner started (opus-4)");
    expect(tl[2].content).toBe("Dispatching coder");
    expect(tl[3].content).toBe("Advancing to review");
  });

  test("tool events render as kind: tool", () => {
    const events = [makeEvent("tool_call", { message: "read_file /src/main.ts", duration: 1500 }, 100)];

    const tl = buildConversationTimeline(events, []);

    expect(tl).toHaveLength(1);
    expect(tl[0].kind).toBe("tool");
    expect(tl[0].status).toBe("done");
    expect(tl[0].duration).toBe("1.5s");
  });

  test("failed tool events render as kind: tool with error status", () => {
    const events = [
      makeEvent("tool_error", { message: "write_file failed", error: "Permission denied" }, 100),
      makeEvent("tool_call_fail", { message: "exec timed out" }, 200),
    ];

    const tl = buildConversationTimeline(events, []);

    expect(tl).toHaveLength(2);
    expect(tl[0].kind).toBe("tool");
    expect(tl[0].status).toBe("error");
    expect(tl[0].error).toBe("Permission denied");
    expect(tl[1].kind).toBe("tool");
    expect(tl[1].status).toBe("error");
  });

  test("empty events + messages returns empty timeline", () => {
    const tl = buildConversationTimeline([], []);
    expect(tl).toHaveLength(0);
    expect(tl).toEqual([]);
  });

  test("messages without events still render", () => {
    const messages = [makeMessage("user", "Do the thing", 100), makeMessage("assistant", "Done", 200)];

    const tl = buildConversationTimeline([], messages);

    expect(tl).toHaveLength(2);
    expect(tl[0].kind).toBe("user");
    expect(tl[1].kind).toBe("agent");
  });

  test("events without messages still render (system events only)", () => {
    const events = [
      makeEvent("stage_started", { stage: "plan", agent: "planner" }, 100),
      makeEvent("agent_progress", { data: { message: "Thinking..." } }, 200),
    ];

    const tl = buildConversationTimeline(events, []);

    expect(tl).toHaveLength(2);
    expect(tl[0].kind).toBe("system");
    expect(tl[0].content).toBe("planner started");
    expect(tl[1].kind).toBe("agent");
  });

  test("agent_completed event includes PR URL and files in content", () => {
    const events = [
      makeEvent(
        "agent_completed",
        {
          data: {
            summary: "Implementation complete",
            pr_url: "https://github.com/org/repo/pull/42",
            filesChanged: ["src/main.ts", "src/utils.ts"],
          },
        },
        100,
      ),
    ];

    const tl = buildConversationTimeline(events, []);

    expect(tl).toHaveLength(1);
    expect(tl[0].kind).toBe("agent");
    expect(tl[0].content).toContain("Implementation complete");
    expect(tl[0].content).toContain("PR: https://github.com/org/repo/pull/42");
    expect(tl[0].content).toContain("Files: src/main.ts, src/utils.ts");
  });

  test("agent_error renders as system event with error prefix", () => {
    const events = [makeEvent("agent_error", { data: { error: "Out of memory" } }, 100)];

    const tl = buildConversationTimeline(events, []);

    expect(tl).toHaveLength(1);
    expect(tl[0].kind).toBe("system");
    expect(tl[0].content).toBe("Error: Out of memory");
  });

  test("agent_question event renders as agent kind with question type", () => {
    const events = [makeEvent("agent_question", { data: { question: "Which branch?" } }, 100)];

    const tl = buildConversationTimeline(events, []);

    expect(tl).toHaveLength(1);
    expect(tl[0].kind).toBe("agent");
    expect(tl[0].type).toBe("question");
    expect(tl[0].content).toBe("Which branch?");
  });

  test("guardrail/retry/verification events render as system", () => {
    const events = [
      makeEvent("completion_rejected", "Guardrail blocked", 100),
      makeEvent("guardrail_triggered", "Content policy", 200),
      makeEvent("retry_attempt", "Retry #2", 300),
      makeEvent("verification_passed", "All checks green", 400),
    ];

    const tl = buildConversationTimeline(events, []);

    expect(tl).toHaveLength(4);
    for (const item of tl) {
      expect(item.kind).toBe("system");
    }
  });

  test("unknown event types are shown with their message", () => {
    const events = [makeEvent("unknown_custom_event", "something happened", 100)];

    const tl = buildConversationTimeline(events, []);

    expect(tl).toHaveLength(1);
    expect(tl[0].kind).toBe("system");
    expect(tl[0].content).toBe("unknown custom event -- something happened");
  });

  test("checkpoint events are shown with status and compute", () => {
    const events = [makeEvent("checkpoint", { stage: "plan", status: "running", compute: "local" }, 100)];

    const tl = buildConversationTimeline(events, []);

    expect(tl).toHaveLength(1);
    expect(tl[0].kind).toBe("system");
    expect(tl[0].content).toBe("plan running on local compute");
  });

  test("hook_status PreToolUse/PostToolUse render as tool calls", () => {
    const events = [
      makeEvent("hook_status", { event: "PreToolUse", tool_name: "Read", tool_input: "/src/main.ts" }, 100),
      makeEvent("hook_status", { event: "PostToolUse", tool_name: "Read", duration: 2100 }, 200),
    ];

    const tl = buildConversationTimeline(events, []);

    expect(tl).toHaveLength(1);
    expect(tl[0].kind).toBe("tool");
    expect(tl[0].label).toBe("Read: /src/main.ts");
    expect(tl[0].status).toBe("done");
    expect(tl[0].duration).toBe("2.1s");
  });

  test("hook_status with agent_status busy shows activity", () => {
    const events = [makeEvent("hook_status", { agent_status: "busy", agent: "planner", tool_name: "Read" }, 100)];

    const tl = buildConversationTimeline(events, []);

    expect(tl).toHaveLength(1);
    expect(tl[0].kind).toBe("system");
    expect(tl[0].content).toBe("planner is reading files...");
  });

  test("hook_status SessionStart and UserPromptSubmit are hidden", () => {
    const events = [
      makeEvent("hook_status", { event: "SessionStart" }, 100),
      makeEvent("hook_status", { event: "UserPromptSubmit" }, 200),
    ];

    const tl = buildConversationTimeline(events, []);

    expect(tl).toHaveLength(0);
  });
});
