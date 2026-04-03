import { describe, it, expect } from "bun:test";
import { hasPasteMarker, isReadyForInput } from "../send-reliable.js";

describe("hasPasteMarker", () => {
  it("detects paste marker", () => {
    expect(hasPasteMarker("[Pasted text #1 +89 lines]")).toBe(true);
    expect(hasPasteMarker("Some output\n[Pasted text #2 +5 lines]\nmore")).toBe(true);
  });

  it("returns false for normal content", () => {
    expect(hasPasteMarker("Hello world")).toBe(false);
    expect(hasPasteMarker("> prompt")).toBe(false);
    expect(hasPasteMarker("")).toBe(false);
  });
});

describe("isReadyForInput", () => {
  it("detects > prompt", () => {
    expect(isReadyForInput("some output\n>")).toBe(true);
    expect(isReadyForInput("Claude > ")).toBe(true); // trailing space trimmed, ends with >
    expect(isReadyForInput("workspace >")).toBe(true);
  });

  it("detects $ prompt", () => {
    expect(isReadyForInput("user@host:~$")).toBe(true);
  });

  it("detects % prompt (zsh)", () => {
    expect(isReadyForInput("user@host %")).toBe(true);
  });

  it("returns false for empty content", () => {
    expect(isReadyForInput("")).toBe(false);
    expect(isReadyForInput("\n\n")).toBe(false);
  });

  it("returns false for active output", () => {
    expect(isReadyForInput("Processing...\nWorking on task")).toBe(false);
  });
});
