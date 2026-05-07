import { describe, it, expect } from "bun:test";
import { shellEscape } from "../ec2/shell-escape.js";

describe("shellEscape", () => {
  it("passes basic strings through wrapped in single quotes", () => {
    expect(shellEscape("hello")).toBe("'hello'");
  });

  it("escapes single quotes", () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
  });

  it("handles empty strings", () => {
    expect(shellEscape("")).toBe("''");
  });

  it("handles paths with spaces", () => {
    expect(shellEscape("/home/user/my project")).toBe("'/home/user/my project'");
  });

  it("handles paths with special characters", () => {
    expect(shellEscape("/tmp/path$var")).toBe("'/tmp/path$var'");
  });

  it("handles multiple single quotes", () => {
    expect(shellEscape("a'b'c")).toBe("'a'\\''b'\\''c'");
  });

  it("handles strings with backticks and dollars", () => {
    // These should be safe inside single quotes
    expect(shellEscape("`whoami` $HOME")).toBe("'`whoami` $HOME'");
  });

  it("handles newlines in strings", () => {
    expect(shellEscape("line1\nline2")).toBe("'line1\nline2'");
  });
});
