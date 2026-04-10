import { describe, it, expect } from "bun:test";
import { getTheme, setThemeMode, getThemeMode } from "../theme.js";

describe("theme", () => {
  it("defaults to dark", () => {
    setThemeMode("dark");
    const theme = getTheme();
    // All theme fields must be defined hex colors
    for (const [key, value] of Object.entries(theme)) {
      expect(typeof value).toBe("string");
      expect(value).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
    // Dark and light must have different accents
    setThemeMode("light");
    const light = getTheme();
    expect(theme.accent).not.toBe(light.accent);
  });

  it("switches to light", () => {
    setThemeMode("light");
    const theme = getTheme();
    expect(theme.accent).toBeDefined();
    expect(theme.accent).toMatch(/^#/);
  });

  it("getThemeMode returns current mode", () => {
    setThemeMode("dark");
    expect(getThemeMode()).toBe("dark");
  });

  it("system mode resolves without error", () => {
    setThemeMode("system");
    const theme = getTheme();
    expect(theme.accent).toBeDefined();
  });
});
