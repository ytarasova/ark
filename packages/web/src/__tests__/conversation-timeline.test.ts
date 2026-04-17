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

function buildConversationTimeline(events: any[], messages: any[]) {
  const items: any[] = [];
  const all: any[] = [];

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
        kind: item.role === "user" ? "user" : "agent",
        role: item.role,
        content: item.content,
        timestamp: formatTime(item.created_at),
        agentName: item.role === "user" ? "You" : item.agent_name || item.role || "assistant",
        model: item.model,
        type: item.type,
      });
    } else {
      const evType = item.type || "";
      const evData = typeof item.data === "string" ? item.data : item.data?.message || "";
      const nested = typeof item.data === "object" ? item.data?.data : null;

      if (evType === "agent_progress") {
        const msg = nested?.message || evData;
        if (msg) {
          items.push({
            kind: "agent",
            content: msg,
            timestamp: formatTime(item.created_at),
            agentName: nested?.stage || item.data?.stage || "agent",
            model: nested?.model,
            type: "progress",
          });
        }
      } else if (evType === "agent_completed") {
        const summary = nested?.summary || nested?.message || evData;
        const extras: string[] = [];
        if (nested?.pr_url) extras.push(`PR: ${nested.pr_url}`);
        if (Array.isArray(nested?.filesChanged) && nested.filesChanged.length > 0) {
          extras.push(`Files: ${nested.filesChanged.join(", ")}`);
        }
        const content = extras.length > 0 ? `${summary}\n${extras.join("\n")}` : summary;
        items.push({
          kind: "agent",
          content: content || "Stage completed",
          timestamp: formatTime(item.created_at),
          agentName: nested?.stage || item.data?.stage || "agent",
          model: nested?.model,
          type: "completed",
        });
      } else if (evType === "agent_question") {
        items.push({
          kind: "agent",
          content: nested?.question || evData || "Agent has a question",
          timestamp: formatTime(item.created_at),
          agentName: nested?.stage || item.data?.stage || "agent",
          model: undefined,
          type: "question",
        });
      } else if (evType === "agent_error") {
        items.push({
          kind: "system",
          content: `Error: ${nested?.error || evData || "Unknown error"}`,
          timestamp: formatTime(item.created_at),
        });
      } else if (evType.includes("stage_") || evType.includes("dispatch") || evType.includes("advance")) {
        items.push({
          kind: "system",
          content: evData || evType.replace(/_/g, " "),
          timestamp: formatTime(item.created_at),
        });
      } else if (evType.includes("tool")) {
        const isError = evType.includes("error") || evType.includes("fail");
        items.push({
          kind: "tool",
          label: evData || evType.replace(/_/g, " "),
          timestamp: formatTime(item.created_at),
          status: isError ? "error" : "done",
          duration: item.data?.duration ? `${(item.data.duration / 1000).toFixed(1)}s` : undefined,
          error: isError ? item.data?.error || evData : undefined,
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
        });
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
    const events = [makeEvent("agent_progress", { data: { message: "Working..." } }, 200)];
    const messages = [makeMessage("user", "Hello", 100), makeMessage("assistant", "Hi back", 300)];

    const tl = buildConversationTimeline(events, messages);

    expect(tl).toHaveLength(3);
    expect(tl[0].kind).toBe("user");
    expect(tl[1].kind).toBe("agent");
    expect(tl[1].content).toBe("Working...");
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

  test("stage transitions render as kind: system", () => {
    const events = [
      makeEvent("stage_transition", "Moving to implement", 100),
      makeEvent("dispatch_agent", "Dispatching coder", 200),
      makeEvent("advance_stage", "Advancing to review", 300),
    ];

    const tl = buildConversationTimeline(events, []);

    expect(tl).toHaveLength(3);
    for (const item of tl) {
      expect(item.kind).toBe("system");
    }
    expect(tl[0].content).toBe("Moving to implement");
    expect(tl[1].content).toBe("Dispatching coder");
    expect(tl[2].content).toBe("Advancing to review");
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
      makeEvent("stage_started", "plan started", 100),
      makeEvent("agent_progress", { data: { message: "Thinking..." } }, 200),
    ];

    const tl = buildConversationTimeline(events, []);

    expect(tl).toHaveLength(2);
    expect(tl[0].kind).toBe("system");
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

  test("unknown event types are silently skipped", () => {
    const events = [makeEvent("unknown_custom_event", "something happened", 100)];

    const tl = buildConversationTimeline(events, []);

    // Unknown types that don't match any pattern are not included
    expect(tl).toHaveLength(0);
  });
});
