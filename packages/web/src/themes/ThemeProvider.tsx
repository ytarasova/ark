import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { themes, tokensToCssVars, type ColorMode, type ThemeName } from "./tokens.js";

// ---------------------------------------------------------------------------
// Context types
// ---------------------------------------------------------------------------

export interface ThemeContextValue {
  /** Active theme name (e.g. "midnight-circuit") */
  themeName: ThemeName;
  /** Active color mode */
  colorMode: ColorMode;
  /** Switch theme */
  setThemeName: (name: ThemeName) => void;
  /** Switch color mode */
  setColorMode: (mode: ColorMode) => void;
  /** Toggle between dark and light */
  toggleColorMode: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

const STORAGE_KEY_THEME = "ark-theme-name";
const STORAGE_KEY_MODE = "ark-color-mode";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSystemColorMode(): ColorMode {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function readStoredTheme(): ThemeName | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY_THEME);
    if (v === "midnight-circuit" || v === "arctic-slate" || v === "warm-obsidian") return v;
  } catch {
    /* noop */
  }
  return null;
}

function readStoredMode(): ColorMode | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY_MODE);
    if (v === "dark" || v === "light") return v;
  } catch {
    /* noop */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Apply tokens to the document root
// ---------------------------------------------------------------------------

function applyTheme(name: ThemeName, mode: ColorMode) {
  const tokens = themes[name][mode];
  const vars = tokensToCssVars(tokens);
  const root = document.documentElement;

  // Set CSS custom properties
  for (const [prop, value] of Object.entries(vars)) {
    root.style.setProperty(prop, value);
  }

  // Set class for theme + mode (useful for selectors)
  root.className = `${name} ${mode}`;

  // Color-scheme meta
  root.style.colorScheme = mode;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: ThemeName;
  defaultColorMode?: ColorMode;
}

export function ThemeProvider({ children, defaultTheme, defaultColorMode }: ThemeProviderProps) {
  const [themeName, setThemeNameRaw] = useState<ThemeName>(
    () => readStoredTheme() ?? defaultTheme ?? "midnight-circuit",
  );
  const [colorMode, setColorModeRaw] = useState<ColorMode>(
    () => readStoredMode() ?? defaultColorMode ?? getSystemColorMode(),
  );

  // Persist + apply on change
  const setThemeName = useCallback((name: ThemeName) => {
    setThemeNameRaw(name);
    try {
      localStorage.setItem(STORAGE_KEY_THEME, name);
    } catch {
      /* noop */
    }
  }, []);

  const setColorMode = useCallback((mode: ColorMode) => {
    setColorModeRaw(mode);
    try {
      localStorage.setItem(STORAGE_KEY_MODE, mode);
    } catch {
      /* noop */
    }
  }, []);

  const toggleColorMode = useCallback(() => {
    setColorMode(colorMode === "dark" ? "light" : "dark");
  }, [colorMode, setColorMode]);

  // Apply CSS vars whenever theme or mode changes
  useEffect(() => {
    applyTheme(themeName, colorMode);
  }, [themeName, colorMode]);

  // Listen for OS preference changes (only if user hasn't explicitly set a mode)
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    function handler(e: MediaQueryListEvent) {
      if (!readStoredMode()) {
        setColorModeRaw(e.matches ? "light" : "dark");
      }
    }
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ themeName, colorMode, setThemeName, setColorMode, toggleColorMode }),
    [themeName, colorMode, setThemeName, setColorMode, toggleColorMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return ctx;
}
