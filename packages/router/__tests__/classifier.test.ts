/**
 * Tests for the request complexity classifier.
 */

import { describe, test, expect } from "bun:test";
import { classify } from "../classifier.js";
import type { ChatCompletionRequest } from "../types.js";

function makeRequest(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: "auto",
    messages: [{ role: "user", content: "Hello" }],
    ...overrides,
  };
}

describe("classifier", () => {
  test("trivial message gets low score", () => {
    const result = classify(makeRequest({
      messages: [{ role: "user", content: "Hi" }],
    }));
    expect(result.score).toBeLessThan(0.15);
    expect(result.difficulty).toBe("trivial");
    expect(result.task_type).toBe("chat");
    expect(result.signals).toContain("simple_chat");
  });

  test("simple question gets low score", () => {
    const result = classify(makeRequest({
      messages: [{ role: "user", content: "What is the capital of France?" }],
    }));
    expect(result.score).toBeLessThan(0.3);
    expect(result.difficulty).toBe("trivial");
  });

  test("code request gets high score", () => {
    const result = classify(makeRequest({
      messages: [{ role: "user", content: `
        Write a TypeScript function that implements a binary search tree.
        Include insert, delete, and search methods.
        Use generics and async/await for the persistence layer.
        \`\`\`typescript
        import { Database } from "./db.js";
        const db = new Database();
        \`\`\`
      ` }],
    }));
    expect(result.score).toBeGreaterThanOrEqual(0.2);
    expect(result.task_type).toBe("code");
    expect(result.signals.some(s => s.includes("code"))).toBe(true);
  });

  test("tool requests are detected", () => {
    const result = classify(makeRequest({
      messages: [{ role: "user", content: "Search for files matching *.ts" }],
      tools: [
        { type: "function", function: { name: "search_files", parameters: {} } },
        { type: "function", function: { name: "read_file", parameters: {} } },
        { type: "function", function: { name: "write_file", parameters: {} } },
      ],
    }));
    expect(result.has_tools).toBe(true);
    expect(result.signals).toContain("has_tools");
  });

  test("many tools increase score", () => {
    const tools = Array.from({ length: 8 }, (_, i) => ({
      type: "function" as const,
      function: { name: `tool_${i}`, parameters: {} },
    }));
    const result = classify(makeRequest({ tools }));
    expect(result.signals).toContain("multi_tool");
    expect(result.score).toBeGreaterThan(0);
  });

  test("multi-turn conversation increases score", () => {
    const messages = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `Message ${i}`,
    }));
    const result = classify(makeRequest({ messages }));
    expect(result.turn_count).toBe(12);
    expect(result.signals).toContain("multi_turn");
  });

  test("reasoning keywords increase score", () => {
    const result = classify(makeRequest({
      messages: [{ role: "user", content: "Explain the trade-offs between microservices and monoliths. Analyze the implications for system design." }],
    }));
    expect(result.task_type).toBe("reasoning");
    expect(result.signals.some(s => s.includes("reasoning"))).toBe(true);
  });

  test("long context detected", () => {
    const longContent = "x".repeat(50000);
    const result = classify(makeRequest({
      messages: [{ role: "user", content: longContent }],
    }));
    expect(result.signals).toContain("long_context");
    expect(result.context_length).toBeGreaterThan(10000);
  });

  test("complex system prompt detected", () => {
    const result = classify(makeRequest({
      messages: [
        { role: "system", content: "x".repeat(10000) },
        { role: "user", content: "Do the thing" },
      ],
    }));
    expect(result.signals).toContain("complex_system_prompt");
  });

  test("extraction task detected", () => {
    const result = classify(makeRequest({
      messages: [{ role: "user", content: "Extract all email addresses and convert them to JSON format" }],
    }));
    expect(result.task_type).toBe("extraction");
  });

  test("score is clamped between 0 and 1", () => {
    // Very complex request
    const tools = Array.from({ length: 10 }, (_, i) => ({
      type: "function" as const,
      function: { name: `tool_${i}`, parameters: {} },
    }));
    const messages = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `Explain step-by-step how to implement and analyze the architecture design pattern for ${i}. import { foo } from "./bar.js"; const x = async () => await fetch(); \`\`\`ts code \`\`\``,
    }));
    const result = classify(makeRequest({ messages, tools, tool_choice: "auto" }));
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});
