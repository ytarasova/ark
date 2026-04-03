import { describe, it, expect, beforeEach } from "bun:test";
import { getHotkeys, matchesHotkey, resetHotkeys, hotkeyLabel } from "../hotkeys.js";

describe("hotkeys", () => {
  beforeEach(() => resetHotkeys());

  it("getHotkeys returns default bindings", () => {
    const hotkeys = getHotkeys();
    expect(hotkeys.dispatch).toBe("Enter");
    expect(hotkeys.stop).toBe("s");
    expect(hotkeys.delete).toBe("x");
  });

  it("matchesHotkey matches simple keys", () => {
    expect(matchesHotkey("stop", "s", {})).toBe(true);
    expect(matchesHotkey("stop", "x", {})).toBe(false);
  });

  it("matchesHotkey handles ctrl+ bindings", () => {
    expect(matchesHotkey("undo", "z", { ctrl: true })).toBe(true);
    expect(matchesHotkey("undo", "z", {})).toBe(false);
  });

  it("hotkeyLabel returns the binding string", () => {
    expect(hotkeyLabel("stop")).toBe("s");
    expect(hotkeyLabel("undo")).toBe("ctrl+z");
  });

  it("hotkeyLabel returns empty for unknown action", () => {
    expect(hotkeyLabel("nonexistent")).toBe("");
  });
});
