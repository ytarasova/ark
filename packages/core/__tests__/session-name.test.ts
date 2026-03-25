/**
 * Tests for session name sanitization logic.
 * The sanitize function is extracted from NewSessionForm.tsx submit handler.
 */

import { describe, it, expect } from "bun:test";

/** Same sanitization regex as in NewSessionForm.tsx submit */
const sanitize = (name: string) =>
  name
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

describe("session name sanitization", () => {
  it("replaces spaces with dashes", () => {
    expect(sanitize("hello world")).toBe("hello-world");
  });

  it("removes special characters", () => {
    expect(sanitize("test@#$session")).toBe("test-session");
  });

  it("collapses multiple dashes into one", () => {
    expect(sanitize("a--b---c")).toBe("a-b-c");
  });

  it("strips leading and trailing dashes", () => {
    expect(sanitize("-test-")).toBe("test");
  });

  it("truncates to 60 characters", () => {
    const long = "a".repeat(100);
    const result = sanitize(long);
    expect(result.length).toBe(60);
  });

  it("passes through already clean names", () => {
    expect(sanitize("my-session")).toBe("my-session");
    expect(sanitize("my_session_123")).toBe("my_session_123");
  });

  it("handles mixed special characters", () => {
    expect(sanitize("hello world!@#$%^&*()")).toBe("hello-world");
  });

  it("preserves underscores", () => {
    expect(sanitize("snake_case_name")).toBe("snake_case_name");
  });

  it("handles consecutive special chars as single dash", () => {
    expect(sanitize("a!!!b")).toBe("a-b");
  });
});
