/**
 * Theme support - dark/light/system.
 */

import { execSync } from "child_process";

export type ThemeMode = "dark" | "light" | "system";

export interface Theme {
  accent: string;
  highlight: string;
  running: string;
  waiting: string;
  error: string;
  idle: string;
  surface: string;
  text: string;
  dimText: string;
}

const DARK: Theme = {
  accent: "#82aaff",          // brighter blue -- readable on dark bg
  highlight: "#c792ea",       // soft purple -- selected items
  running: "#c3e88d",         // bright green
  waiting: "#ffcb6b",         // warm yellow
  error: "#ff5370",           // vivid red
  idle: "#939ede",            // soft lavender
  surface: "#2b2f3e",        // slightly lighter than terminal bg
  text: "#d6deeb",            // bright off-white -- main content
  dimText: "#7e8eba",         // visible muted text
};

const LIGHT: Theme = {
  accent: "#2e7de9",
  highlight: "#7847bd",
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
