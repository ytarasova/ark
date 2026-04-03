/**
 * Theme support - dark/light/system.
 */

export type ThemeMode = "dark" | "light" | "system";

export interface Theme {
  accent: string;
  running: string;
  waiting: string;
  error: string;
  idle: string;
  surface: string;
  text: string;
  dimText: string;
}

const DARK: Theme = {
  accent: "#7aa2f7",
  running: "#9ece6a",
  waiting: "#e0af68",
  error: "#f7768e",
  idle: "#787fa0",
  surface: "#24283b",
  text: "#c0caf5",
  dimText: "#565f89",
};

const LIGHT: Theme = {
  accent: "#2e7de9",
  running: "#587539",
  waiting: "#8c6c3e",
  error: "#f52a65",
  idle: "#6172b0",
  surface: "#e1e2e7",
  text: "#3760bf",
  dimText: "#8990b3",
};

function detectSystemTheme(): "dark" | "light" {
  try {
    const { execSync } = require("child_process");
    const result = execSync("defaults read -g AppleInterfaceStyle 2>/dev/null", { encoding: "utf-8" }).trim();
    return result === "Dark" ? "dark" : "light";
  } catch {
    return "dark"; // default to dark
  }
}

let _mode: ThemeMode = "dark";
let _cached: Theme | null = null;

export function setThemeMode(mode: ThemeMode): void {
  _mode = mode;
  _cached = null;
}

export function getTheme(): Theme {
  if (_cached) return _cached;
  const resolved = _mode === "system" ? detectSystemTheme() : _mode;
  _cached = resolved === "light" ? LIGHT : DARK;
  return _cached;
}

export function getThemeMode(): ThemeMode { return _mode; }
