import { describe, it, expect } from "bun:test";
import { detectStatusFromContent, stripAnsi } from "../status-detect.js";

describe("stripAnsi", () => {
  it("removes escape codes", () => {
    expect(stripAnsi("\x1b[32mgreen\x1b[0m")).toBe("green");
    expect(stripAnsi("\x1b[1;34mbold blue\x1b[0m")).toBe("bold blue");
  });

  it("preserves plain text", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });
});

describe("detectStatusFromContent", () => {
  it("detects running from ctrl+c message", () => {
    const content = "Working on feature...\nctrl+c to interrupt\n⠋ Analyzing code";
    expect(detectStatusFromContent(content)).toBe("running");
  });

  it("detects running from spinner chars", () => {
    expect(detectStatusFromContent("⠋ Loading...")).toBe("running");
    expect(detectStatusFromContent("⠹ Processing")).toBe("running");
  });

  it("detects running from esc to interrupt", () => {
    expect(detectStatusFromContent("Some output\nesc to interrupt")).toBe("running");
  });

  it("detects waiting from bare prompt", () => {
    expect(detectStatusFromContent("Previous output\n>")).toBe("waiting");
  });

  it("detects waiting from permission prompt", () => {
    expect(detectStatusFromContent("Yes, allow once\nNo, deny")).toBe("waiting");
  });

  it("detects waiting from enter to confirm", () => {
    expect(detectStatusFromContent("Options:\nEnter to confirm · Esc to cancel")).toBe("waiting");
  });

  it("detects idle from shell prompt", () => {
    expect(detectStatusFromContent("task complete\nuser@host:~$")).toBe("idle");
  });

  it("returns unknown for empty content", () => {
    expect(detectStatusFromContent("")).toBe("unknown");
  });

  it("returns unknown for ambiguous content", () => {
    expect(detectStatusFromContent("Some random text\nnothing special")).toBe("unknown");
  });

  it("busy takes priority over prompt", () => {
    // Content with both busy and prompt indicators
    const content = "ctrl+c to interrupt\n>";
    expect(detectStatusFromContent(content)).toBe("running");
  });

  it("detects Claude timing indicator as running", () => {
    expect(detectStatusFromContent("(35s · 673 tokens)")).toBe("running");
  });
});
