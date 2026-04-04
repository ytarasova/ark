/**
 * Tests for per-agent message filtering.
 */

import { describe, it, expect } from "bun:test";
import { filterMessages, parseMessageFilter, type FilteredMessage } from "../message-filter.js";

const messages: FilteredMessage[] = [
  { role: "user", content: "Start the task", agent: "planner", timestamp: "2024-01-01T00:00:00Z" },
  { role: "assistant", content: "Planning complete with detailed analysis", agent: "planner", timestamp: "2024-01-01T00:01:00Z" },
  { role: "assistant", content: "Implementation started on the feature", agent: "implementer", timestamp: "2024-01-01T00:02:00Z" },
  { role: "assistant", content: "Review findings and suggestions listed", agent: "reviewer", timestamp: "2024-01-01T00:03:00Z" },
  { role: "user", content: "Looks good, proceed", timestamp: "2024-01-01T00:04:00Z" },
  { role: "assistant", content: "Final implementation with all fixes applied", agent: "implementer", timestamp: "2024-01-01T00:05:00Z" },
];

describe("filterMessages", () => {
  describe("maxMessages", () => {
    it("limits to most recent N messages", () => {
      const result = filterMessages(messages, { maxMessages: 3 });
      expect(result.length).toBe(3);
      expect(result[0].content).toBe("Review findings and suggestions listed");
      expect(result[2].content).toBe("Final implementation with all fixes applied");
    });

    it("returns all if limit exceeds count", () => {
      const result = filterMessages(messages, { maxMessages: 100 });
      expect(result.length).toBe(6);
    });
  });

  describe("fromAgents", () => {
    it("includes only messages from specified agents", () => {
      const result = filterMessages(messages, { fromAgents: ["implementer"] });
      expect(result.length).toBe(3);  // 2 implementer + 1 user (no agent field)
      for (const m of result) {
        expect(!m.agent || m.agent === "implementer").toBe(true);
      }
    });

    it("includes messages without agent field (user messages)", () => {
      const result = filterMessages(messages, { fromAgents: ["reviewer"] });
      const agents = result.map(m => m.agent);
      expect(agents).toContain("reviewer");
      expect(agents).toContain(undefined);  // user message with no agent
    });
  });

  describe("excludeAgents", () => {
    it("excludes messages from specified agents", () => {
      const result = filterMessages(messages, { excludeAgents: ["planner"] });
      expect(result.length).toBe(4);
      expect(result.every(m => m.agent !== "planner")).toBe(true);
    });

    it("keeps messages without agent field", () => {
      const result = filterMessages(messages, { excludeAgents: ["planner", "implementer", "reviewer"] });
      expect(result.length).toBe(1);
      expect(result[0].content).toBe("Looks good, proceed");
    });
  });

  describe("maxTokenEstimate", () => {
    it("limits by rough token budget, keeping most recent", () => {
      // Each message content is ~5-8 words = ~25-40 chars = ~6-10 tokens
      // Set a small budget to verify truncation
      const result = filterMessages(messages, { maxTokenEstimate: 20 });
      expect(result.length).toBeLessThan(messages.length);
      // Should include the last message(s)
      expect(result[result.length - 1].content).toBe("Final implementation with all fixes applied");
    });

    it("returns all messages if budget is generous", () => {
      const result = filterMessages(messages, { maxTokenEstimate: 10000 });
      expect(result.length).toBe(messages.length);
    });
  });

  describe("combined filters", () => {
    it("applies fromAgents then maxMessages", () => {
      const result = filterMessages(messages, {
        fromAgents: ["implementer"],
        maxMessages: 1,
      });
      expect(result.length).toBe(1);
      expect(result[0].content).toBe("Final implementation with all fixes applied");
    });
  });
});

describe("parseMessageFilter", () => {
  it("returns null for config without message_filter", () => {
    expect(parseMessageFilter({})).toBeNull();
    expect(parseMessageFilter(null)).toBeNull();
    expect(parseMessageFilter(undefined)).toBeNull();
  });

  it("parses a valid message_filter config", () => {
    const config = {
      message_filter: {
        max_messages: 50,
        from_agents: ["planner", "implementer"],
        exclude_agents: ["documenter"],
        max_tokens: 4000,
        include_system_prompt: false,
      },
    };
    const filter = parseMessageFilter(config);
    expect(filter).not.toBeNull();
    expect(filter!.maxMessages).toBe(50);
    expect(filter!.fromAgents).toEqual(["planner", "implementer"]);
    expect(filter!.excludeAgents).toEqual(["documenter"]);
    expect(filter!.maxTokenEstimate).toBe(4000);
    expect(filter!.includeSystemPrompt).toBe(false);
  });

  it("defaults includeSystemPrompt to true", () => {
    const config = { message_filter: { max_messages: 10 } };
    const filter = parseMessageFilter(config);
    expect(filter!.includeSystemPrompt).toBe(true);
  });
});
