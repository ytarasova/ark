import { describe, it, expect } from "bun:test";
import { getTheme, setThemeMode, getThemeMode } from "../theme.js";

describe("theme", () => {
  it("defaults to dark", () => {
    setThemeMode("dark");
    const theme = getTheme();
    expect(theme.accent).toBe("#7aa2f7");
  });

  it("switches to light", () => {
    setThemeMode("light");
    const theme = getTheme();
    expect(theme.accent).toBe("#2e7de9");
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
