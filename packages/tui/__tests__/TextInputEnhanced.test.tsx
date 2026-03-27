import { describe, it, expect } from "bun:test";
import React, { useState } from "react";
import { render } from "ink-testing-library";
import { TextInputEnhanced } from "../components/TextInputEnhanced.js";

const delay = (ms = 50) => new Promise(r => setTimeout(r, ms));

// Escape sequences for terminal key input
const KEYS = {
  left: "\x1b[D",
  right: "\x1b[C",
  backspace: "\x7f",
  ctrlA: "\x01",
  ctrlE: "\x05",
  ctrlW: "\x17",
  ctrlU: "\x15",
  ctrlK: "\x0b",
  ctrlB: "\x02",
  ctrlF: "\x06",
  // Option+arrow uses escape prefix
  optLeft: "\x1b\x1b[D",
  optRight: "\x1b\x1b[C",
  // Option+Backspace
  optBackspace: "\x1b\x7f",
};

/** Wrapper that manages state so we can test interactive editing */
function TestInput({ initial = "", onValue }: { initial?: string; onValue?: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <TextInputEnhanced
      value={value}
      onChange={(v) => { setValue(v); onValue?.(v); }}
      focus={true}
    />
  );
}

/**
 * Extract text content from a rendered frame.
 * Ink's inverse text shows up with ANSI codes - strip them for content checks.
 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("TextInputEnhanced", () => {
  describe("character input", () => {
    it("accepts typed characters", async () => {
      const { lastFrame, stdin, unmount } = render(<TestInput />);
      stdin.write("hello");
      await delay();
      expect(stripAnsi(lastFrame()!)).toContain("hello");
      unmount();
    });

    it("inserts at cursor position", async () => {
      const { lastFrame, stdin, unmount } = render(<TestInput initial="hllo" />);
      // Move cursor left 3 times to position after 'h'
      stdin.write(KEYS.left);
      stdin.write(KEYS.left);
      stdin.write(KEYS.left);
      await delay();
      stdin.write("e");
      await delay();
      expect(stripAnsi(lastFrame()!)).toContain("hello");
      unmount();
    });
  });

  describe("character navigation", () => {
    it("left arrow moves cursor left", async () => {
      const { lastFrame, stdin, unmount } = render(<TestInput initial="abc" />);
      // Cursor starts at end. Move left once → cursor on 'c'
      stdin.write(KEYS.left);
      await delay();
      const frame = lastFrame()!;
      // 'c' should be the inverse (cursor) character, with 'ab' before it
      expect(frame).toContain("ab");
      unmount();
    });

    it("right arrow moves cursor right", async () => {
      const { lastFrame, stdin, unmount } = render(<TestInput initial="abc" />);
      // Move to beginning, then right once → cursor on 'b'
      stdin.write(KEYS.ctrlA);
      await delay();
      stdin.write(KEYS.right);
      await delay();
      const frame = stripAnsi(lastFrame()!);
      expect(frame).toContain("abc");
      unmount();
    });

    it("Ctrl+B moves cursor left", async () => {
      const { lastFrame, stdin, unmount } = render(<TestInput initial="abc" />);
      stdin.write(KEYS.ctrlB);
      await delay();
      // Typing should insert before 'c'
      stdin.write("x");
      await delay();
      expect(stripAnsi(lastFrame()!)).toContain("abxc");
      unmount();
    });

    it("Ctrl+F moves cursor right", async () => {
      const { lastFrame, stdin, unmount } = render(<TestInput initial="abc" />);
      stdin.write(KEYS.ctrlA);
      await delay();
      stdin.write(KEYS.ctrlF);
      await delay();
      stdin.write("x");
      await delay();
      expect(stripAnsi(lastFrame()!)).toContain("axbc");
      unmount();
    });
  });

  describe("word navigation", () => {
    it("Option+Left jumps to previous word boundary", async () => {
      const { lastFrame, stdin, unmount } = render(<TestInput initial="hello world" />);
      // Cursor at end. Option+Left should jump to start of "world"
      stdin.write(KEYS.optLeft);
      await delay();
      stdin.write("x");
      await delay();
      expect(stripAnsi(lastFrame()!)).toContain("hello xworld");
      unmount();
    });

    it("Option+Right jumps to next word boundary", async () => {
      const { lastFrame, stdin, unmount } = render(<TestInput initial="hello world" />);
      stdin.write(KEYS.ctrlA);
      await delay();
      // Option+Right should jump past "hello"
      stdin.write(KEYS.optRight);
      await delay();
      stdin.write("x");
      await delay();
      expect(stripAnsi(lastFrame()!)).toContain("hellox world");
      unmount();
    });

    it("Option+Left at beginning stays at beginning", async () => {
      const { lastFrame, stdin, unmount } = render(<TestInput initial="hello" />);
      stdin.write(KEYS.ctrlA);
      await delay();
      stdin.write(KEYS.optLeft);
      await delay();
      stdin.write("x");
      await delay();
      expect(stripAnsi(lastFrame()!)).toContain("xhello");
      unmount();
    });
  });

  describe("beginning/end of line navigation", () => {
    it("Ctrl+A moves to beginning of line", async () => {
      const { lastFrame, stdin, unmount } = render(<TestInput initial="hello" />);
      stdin.write(KEYS.ctrlA);
      await delay();
      stdin.write("x");
      await delay();
      expect(stripAnsi(lastFrame()!)).toContain("xhello");
      unmount();
    });

    it("Ctrl+E moves to end of line", async () => {
      const { lastFrame, stdin, unmount } = render(<TestInput initial="hello" />);
      stdin.write(KEYS.ctrlA);
      await delay();
      stdin.write(KEYS.ctrlE);
      await delay();
      stdin.write("x");
      await delay();
      expect(stripAnsi(lastFrame()!)).toContain("hellox");
      unmount();
    });
  });

  describe("backspace", () => {
    it("deletes character before cursor", async () => {
      const { lastFrame, stdin, unmount } = render(<TestInput initial="hello" />);
      stdin.write(KEYS.backspace);
      await delay();
      expect(stripAnsi(lastFrame()!)).toContain("hell");
      unmount();
    });

    it("does nothing at beginning of line", async () => {
      const { lastFrame, stdin, unmount } = render(<TestInput initial="hi" />);
      stdin.write(KEYS.ctrlA);
      await delay();
      stdin.write(KEYS.backspace);
      await delay();
      expect(stripAnsi(lastFrame()!)).toContain("hi");
      unmount();
    });
  });

  describe("word deletion", () => {
    it("Option+Backspace deletes word backward", async () => {
      const { lastFrame, stdin, unmount } = render(<TestInput initial="hello world" />);
      stdin.write(KEYS.optBackspace);
      await delay();
      expect(stripAnsi(lastFrame()!)).toContain("hello");
      expect(stripAnsi(lastFrame()!)).not.toContain("world");
      unmount();
    });

    it("Option+Backspace deletes word backward mid-line", async () => {
      const { lastFrame, stdin, unmount } = render(<TestInput initial="one two three" />);
      // Move to end of "two" (before " three")
      stdin.write(KEYS.left);
      stdin.write(KEYS.left);
      stdin.write(KEYS.left);
      stdin.write(KEYS.left);
      stdin.write(KEYS.left);
      stdin.write(KEYS.left);
      await delay();
      stdin.write(KEYS.optBackspace);
      await delay();
      expect(stripAnsi(lastFrame()!)).toContain("one  three");
      unmount();
    });

    it("Ctrl+W deletes word backward", async () => {
      const { lastFrame, stdin, unmount } = render(<TestInput initial="hello world" />);
      stdin.write(KEYS.ctrlW);
      await delay();
      expect(stripAnsi(lastFrame()!)).toContain("hello");
      expect(stripAnsi(lastFrame()!)).not.toContain("world");
      unmount();
    });

    it("Option+Backspace at beginning does nothing", async () => {
      const { lastFrame, stdin, unmount } = render(<TestInput initial="hello" />);
      stdin.write(KEYS.ctrlA);
      await delay();
      stdin.write(KEYS.optBackspace);
      await delay();
      expect(stripAnsi(lastFrame()!)).toContain("hello");
      unmount();
    });
  });

  describe("line deletion", () => {
    it("Ctrl+U deletes to beginning of line", async () => {
      const { lastFrame, stdin, unmount } = render(<TestInput initial="hello world" />);
      // Move cursor to before "world"
      stdin.write(KEYS.optLeft);
      await delay();
      stdin.write(KEYS.ctrlU);
      await delay();
      expect(stripAnsi(lastFrame()!)).toContain("world");
      expect(stripAnsi(lastFrame()!)).not.toContain("hello");
      unmount();
    });

    it("Ctrl+K deletes to end of line", async () => {
      const { lastFrame, stdin, unmount } = render(<TestInput initial="hello world" />);
      stdin.write(KEYS.optLeft);
      await delay();
      stdin.write(KEYS.ctrlK);
      await delay();
      expect(stripAnsi(lastFrame()!)).toContain("hello");
      expect(stripAnsi(lastFrame()!)).not.toContain("world");
      unmount();
    });

    it("Ctrl+U at end clears entire line", async () => {
      let lastValue = "hello";
      const { lastFrame, stdin, unmount } = render(
        <TestInput initial="hello" onValue={(v) => { lastValue = v; }} />
      );
      stdin.write(KEYS.ctrlU);
      await delay();
      expect(lastValue).toBe("");
      unmount();
    });
  });

  describe("placeholder", () => {
    it("shows placeholder when empty", () => {
      const { lastFrame, unmount } = render(
        <TextInputEnhanced value="" onChange={() => {}} placeholder="type here" focus={true} />
      );
      expect(stripAnsi(lastFrame()!)).toContain("type here");
      unmount();
    });

    it("hides placeholder when value exists", () => {
      const { lastFrame, unmount } = render(
        <TextInputEnhanced value="hi" onChange={() => {}} placeholder="type here" focus={true} />
      );
      expect(stripAnsi(lastFrame()!)).not.toContain("type here");
      unmount();
    });
  });

  describe("multi-line paste", () => {
    it("preserves newlines in pasted text value", async () => {
      let captured = "";
      const { stdin, unmount } = render(
        <TestInput onValue={(v) => { captured = v; }} />
      );
      stdin.write("line1\nline2\nline3");
      await delay();
      expect(captured).toContain("\n");
      expect(captured.split("\n").length).toBe(3);
      unmount();
    });

    it("collapses display when paste exceeds MAX_DISPLAY_LINES", async () => {
      const multiLine = "first line\nsecond\nthird\nfourth\nfifth";
      const { lastFrame, unmount } = render(
        <TextInputEnhanced value={multiLine} onChange={() => {}} focus={true} />
      );
      const frame = stripAnsi(lastFrame()!);
      // Should show first line and a line count indicator
      expect(frame).toContain("first line");
      expect(frame).toContain("[+4 lines]");
      // Should NOT show all lines
      expect(frame).not.toContain("fifth");
      unmount();
    });

    it("renders normally when lines are within MAX_DISPLAY_LINES", () => {
      const fewLines = "line1\nline2\nline3";
      const { lastFrame, unmount } = render(
        <TextInputEnhanced value={fewLines} onChange={() => {}} focus={true} />
      );
      const frame = stripAnsi(lastFrame()!);
      expect(frame).toContain("line1");
      expect(frame).toContain("line3");
      expect(frame).not.toContain("[+");
      unmount();
    });

    it("truncates long first line in collapsed view", () => {
      const longFirst = "a".repeat(80) + "\nsecond\nthird\nfourth\nfifth";
      const { lastFrame, unmount } = render(
        <TextInputEnhanced value={longFirst} onChange={() => {}} focus={true} />
      );
      const frame = stripAnsi(lastFrame()!);
      expect(frame).toContain("...");
      expect(frame).toContain("[+4 lines]");
      unmount();
    });

    it("submits full multi-line value on Enter", async () => {
      let submitted = "";
      const multiLine = "line1\nline2\nline3\nline4\nline5";
      function SubmitTest() {
        const [value, setValue] = useState(multiLine);
        return (
          <TextInputEnhanced
            value={value}
            onChange={setValue}
            onSubmit={(v) => { submitted = v; }}
            focus={true}
          />
        );
      }
      const { stdin, unmount } = render(<SubmitTest />);
      stdin.write("\r"); // Enter
      await delay();
      expect(submitted).toBe(multiLine);
      expect(submitted.split("\n").length).toBe(5);
      unmount();
    });

    it("strips carriage returns from pasted Windows-style text", async () => {
      let captured = "";
      const { stdin, unmount } = render(
        <TestInput onValue={(v) => { captured = v; }} />
      );
      stdin.write("line1\r\nline2\r\nline3");
      await delay();
      expect(captured).not.toContain("\r");
      expect(captured.split("\n").length).toBe(3);
      unmount();
    });
  });
});
