/**
 * Design system theme tokens extracted from PR #154 mockups.
 *
 * Every value comes directly from the CSS custom properties in the three
 * HTML mockup files (midnight-circuit, arctic-slate, warm-obsidian).
 */

export interface ThemeTokens {
  // Backgrounds
  bgApp: string;
  bgCard: string;
  bgPopover: string;
  bgSidebar: string;
  bgHover: string;
  bgInput: string;
  bgOverlay: string;
  bgCode: string;

  // Foreground / text
  fgDefault: string;
  fgMuted: string;
  fgFaint: string;

  // Primary accent
  primary: string;
  primaryHover: string;
  primarySubtle: string;
  primaryFg: string;

  // Borders
  borderDefault: string;
  borderLight: string;

  // Status colors
  statusRunning: string;
  statusWaiting: string;
  statusCompleted: string;
  statusFailed: string;
  statusStopped: string;

  // Status glows
  runningGlow: string;
  failedGlow: string;

  // Diff
  diffAddBg: string;
  diffAddFg: string;
  diffRemoveBg: string;
  diffRemoveFg: string;

  // Brand gradient
  gradientBrand: string;

  // Radii
  radiusSm: string;
  radiusMd: string;
  radiusLg: string;

  // Easing
  easeDefault: string;

  // Color scheme
  colorScheme: "dark" | "light";
}

// ---------------------------------------------------------------------------
// Midnight Circuit
// ---------------------------------------------------------------------------

export const midnightCircuit: ThemeTokens = {
  bgApp: "#0c0c14",
  bgCard: "#14141e",
  bgPopover: "#18182a",
  bgSidebar: "#0a0a12",
  bgHover: "#1e1e30",
  bgInput: "#14141e",
  bgOverlay: "rgba(0, 0, 0, 0.6)",
  bgCode: "#1a1a2c",

  fgDefault: "#e4e4ed",
  fgMuted: "#7878a0",
  fgFaint: "#606082",

  primary: "#7c6aef",
  primaryHover: "#6b59de",
  primarySubtle: "rgba(124, 106, 239, 0.1)",
  primaryFg: "#ffffff",

  borderDefault: "#252540",
  borderLight: "#1e1e30",

  statusRunning: "#60a5fa",
  statusWaiting: "#fbbf24",
  statusCompleted: "#34d399",
  statusFailed: "#f87171",
  statusStopped: "rgba(107, 114, 128, 0.4)",

  runningGlow: "0 0 8px rgba(96, 165, 250, 0.4)",
  failedGlow: "0 0 8px rgba(248, 113, 113, 0.3)",

  diffAddBg: "rgba(52, 211, 153, 0.08)",
  diffAddFg: "#34d399",
  diffRemoveBg: "rgba(248, 113, 113, 0.08)",
  diffRemoveFg: "#f87171",

  gradientBrand: "linear-gradient(135deg, #7c6aef 0%, #06b6d4 100%)",

  radiusSm: "6px",
  radiusMd: "8px",
  radiusLg: "12px",

  easeDefault: "cubic-bezier(0.32, 0.72, 0, 1)",

  colorScheme: "dark",
};

export const midnightCircuitLight: ThemeTokens = {
  bgApp: "#f8f8fc",
  bgCard: "#ffffff",
  bgPopover: "#ffffff",
  bgSidebar: "#f0f0f8",
  bgHover: "#ededf5",
  bgInput: "#ffffff",
  bgOverlay: "rgba(0, 0, 0, 0.3)",
  bgCode: "#e8e8f0",

  fgDefault: "#1a1a2e",
  fgMuted: "#6b6b88",
  fgFaint: "#a0a0b8",

  primary: "#6c5ce7",
  primaryHover: "#5b4bd6",
  primarySubtle: "rgba(108, 92, 231, 0.08)",
  primaryFg: "#ffffff",

  borderDefault: "#dcdce8",
  borderLight: "#ededf5",

  statusRunning: "#2563eb",
  statusWaiting: "#d97706",
  statusCompleted: "#16a34a",
  statusFailed: "#dc2626",
  statusStopped: "rgba(156, 163, 175, 0.6)",

  runningGlow: "0 0 8px rgba(37, 99, 235, 0.3)",
  failedGlow: "0 0 8px rgba(220, 38, 38, 0.2)",

  diffAddBg: "rgba(5, 150, 105, 0.08)",
  diffAddFg: "#059669",
  diffRemoveBg: "rgba(220, 38, 38, 0.08)",
  diffRemoveFg: "#dc2626",

  gradientBrand: "linear-gradient(135deg, #6c5ce7 0%, #06b6d4 100%)",

  radiusSm: "6px",
  radiusMd: "8px",
  radiusLg: "12px",

  easeDefault: "cubic-bezier(0.32, 0.72, 0, 1)",

  colorScheme: "light",
};

// ---------------------------------------------------------------------------
// Arctic Slate
// ---------------------------------------------------------------------------

export const arcticSlate: ThemeTokens = {
  bgApp: "#09090b",
  bgCard: "#111113",
  bgPopover: "#18181a",
  bgSidebar: "#09090b",
  bgHover: "#1c1c1e",
  bgInput: "#111113",
  bgOverlay: "rgba(0, 0, 0, 0.6)",
  bgCode: "#1a1a1c",

  fgDefault: "#ededf0",
  fgMuted: "#8a8a93",
  fgFaint: "#5f5f68",

  primary: "#3b82f6",
  primaryHover: "#2563eb",
  primarySubtle: "rgba(59, 130, 246, 0.1)",
  primaryFg: "#ffffff",

  borderDefault: "#27272a",
  borderLight: "#1c1c1e",

  statusRunning: "#60a5fa",
  statusWaiting: "#fbbf24",
  statusCompleted: "#34d399",
  statusFailed: "#f87171",
  statusStopped: "rgba(107, 114, 128, 0.4)",

  runningGlow: "0 0 8px rgba(96, 165, 250, 0.4)",
  failedGlow: "0 0 8px rgba(248, 113, 113, 0.3)",

  diffAddBg: "rgba(52, 211, 153, 0.08)",
  diffAddFg: "#34d399",
  diffRemoveBg: "rgba(248, 113, 113, 0.08)",
  diffRemoveFg: "#f87171",

  gradientBrand: "linear-gradient(135deg, #3b82f6 0%, #06b6d4 100%)",

  radiusSm: "6px",
  radiusMd: "8px",
  radiusLg: "12px",

  easeDefault: "cubic-bezier(0.32, 0.72, 0, 1)",

  colorScheme: "dark",
};

export const arcticSlateLight: ThemeTokens = {
  bgApp: "#fafafa",
  bgCard: "#ffffff",
  bgPopover: "#ffffff",
  bgSidebar: "#f4f4f5",
  bgHover: "#e4e4e7",
  bgInput: "#ffffff",
  bgOverlay: "rgba(0, 0, 0, 0.3)",
  bgCode: "#e4e4e7",

  fgDefault: "#18181b",
  fgMuted: "#71717a",
  fgFaint: "#a1a1aa",

  primary: "#2563eb",
  primaryHover: "#1d4ed8",
  primarySubtle: "rgba(37, 99, 235, 0.08)",
  primaryFg: "#ffffff",

  borderDefault: "#e4e4e7",
  borderLight: "#f4f4f5",

  statusRunning: "#2563eb",
  statusWaiting: "#d97706",
  statusCompleted: "#16a34a",
  statusFailed: "#dc2626",
  statusStopped: "rgba(156, 163, 175, 0.6)",

  runningGlow: "0 0 8px rgba(37, 99, 235, 0.3)",
  failedGlow: "0 0 8px rgba(220, 38, 38, 0.2)",

  diffAddBg: "rgba(5, 150, 105, 0.08)",
  diffAddFg: "#059669",
  diffRemoveBg: "rgba(220, 38, 38, 0.08)",
  diffRemoveFg: "#dc2626",

  gradientBrand: "linear-gradient(135deg, #2563eb 0%, #06b6d4 100%)",

  radiusSm: "6px",
  radiusMd: "8px",
  radiusLg: "12px",

  easeDefault: "cubic-bezier(0.32, 0.72, 0, 1)",

  colorScheme: "light",
};

// ---------------------------------------------------------------------------
// Warm Obsidian
// ---------------------------------------------------------------------------

export const warmObsidian: ThemeTokens = {
  bgApp: "#0f0f0f",
  bgCard: "#191919",
  bgPopover: "#1e1e1e",
  bgSidebar: "#0c0c0c",
  bgHover: "#242424",
  bgInput: "#191919",
  bgOverlay: "rgba(0, 0, 0, 0.6)",
  bgCode: "#202020",

  fgDefault: "#ededed",
  fgMuted: "#878787",
  fgFaint: "#626262",

  primary: "#d4a847",
  primaryHover: "#c49a3a",
  primarySubtle: "rgba(212, 168, 71, 0.1)",
  primaryFg: "#0f0f0f",

  borderDefault: "#2a2a2a",
  borderLight: "#242424",

  statusRunning: "#60a5fa",
  statusWaiting: "#fbbf24",
  statusCompleted: "#34d399",
  statusFailed: "#f87171",
  statusStopped: "rgba(107, 114, 128, 0.4)",

  runningGlow: "0 0 8px rgba(96, 165, 250, 0.4)",
  failedGlow: "0 0 8px rgba(248, 113, 113, 0.3)",

  diffAddBg: "rgba(52, 211, 153, 0.08)",
  diffAddFg: "#34d399",
  diffRemoveBg: "rgba(248, 113, 113, 0.08)",
  diffRemoveFg: "#f87171",

  gradientBrand: "linear-gradient(135deg, #d4a847 0%, #e07a2f 100%)",

  radiusSm: "6px",
  radiusMd: "8px",
  radiusLg: "12px",

  easeDefault: "cubic-bezier(0.32, 0.72, 0, 1)",

  colorScheme: "dark",
};

export const warmObsidianLight: ThemeTokens = {
  bgApp: "#faf9f7",
  bgCard: "#ffffff",
  bgPopover: "#ffffff",
  bgSidebar: "#f2f1ee",
  bgHover: "#e8e6e1",
  bgInput: "#ffffff",
  bgOverlay: "rgba(0, 0, 0, 0.3)",
  bgCode: "#e8e6e1",

  fgDefault: "#1c1c1c",
  fgMuted: "#787878",
  fgFaint: "#ababab",

  primary: "#b8922e",
  primaryHover: "#a68228",
  primarySubtle: "rgba(184, 146, 46, 0.08)",
  primaryFg: "#ffffff",

  borderDefault: "#e0dfdb",
  borderLight: "#f2f1ee",

  statusRunning: "#2563eb",
  statusWaiting: "#d97706",
  statusCompleted: "#16a34a",
  statusFailed: "#dc2626",
  statusStopped: "rgba(156, 163, 175, 0.6)",

  runningGlow: "0 0 8px rgba(37, 99, 235, 0.3)",
  failedGlow: "0 0 8px rgba(220, 38, 38, 0.2)",

  diffAddBg: "rgba(5, 150, 105, 0.08)",
  diffAddFg: "#059669",
  diffRemoveBg: "rgba(220, 38, 38, 0.08)",
  diffRemoveFg: "#dc2626",

  gradientBrand: "linear-gradient(135deg, #b8922e 0%, #e07a2f 100%)",

  radiusSm: "6px",
  radiusMd: "8px",
  radiusLg: "12px",

  easeDefault: "cubic-bezier(0.32, 0.72, 0, 1)",

  colorScheme: "light",
};

// ---------------------------------------------------------------------------
// Theme registry
// ---------------------------------------------------------------------------

export type ThemeName = "midnight-circuit" | "arctic-slate" | "warm-obsidian";
export type ColorMode = "dark" | "light";

export const themes: Record<ThemeName, { dark: ThemeTokens; light: ThemeTokens }> = {
  "midnight-circuit": { dark: midnightCircuit, light: midnightCircuitLight },
  "arctic-slate": { dark: arcticSlate, light: arcticSlateLight },
  "warm-obsidian": { dark: warmObsidian, light: warmObsidianLight },
};

/** Map ThemeTokens fields to CSS custom property names. */
export function tokensToCssVars(tokens: ThemeTokens): Record<string, string> {
  return {
    "--bg": tokens.bgApp,
    "--bg-card": tokens.bgCard,
    "--bg-popover": tokens.bgPopover,
    "--bg-sidebar": tokens.bgSidebar,
    "--bg-hover": tokens.bgHover,
    "--bg-input": tokens.bgInput,
    "--bg-overlay": tokens.bgOverlay,
    "--bg-code": tokens.bgCode,

    "--fg": tokens.fgDefault,
    "--fg-muted": tokens.fgMuted,
    "--fg-faint": tokens.fgFaint,

    "--primary": tokens.primary,
    "--primary-hover": tokens.primaryHover,
    "--primary-subtle": tokens.primarySubtle,
    "--primary-fg": tokens.primaryFg,

    "--border": tokens.borderDefault,
    "--border-light": tokens.borderLight,

    "--running": tokens.statusRunning,
    "--waiting": tokens.statusWaiting,
    "--completed": tokens.statusCompleted,
    "--failed": tokens.statusFailed,
    "--stopped": tokens.statusStopped,

    "--running-glow": tokens.runningGlow,
    "--failed-glow": tokens.failedGlow,

    "--diff-add-bg": tokens.diffAddBg,
    "--diff-add-fg": tokens.diffAddFg,
    "--diff-rm-bg": tokens.diffRemoveBg,
    "--diff-rm-fg": tokens.diffRemoveFg,

    "--gradient-brand": tokens.gradientBrand,

    "--radius-sm": tokens.radiusSm,
    "--radius-md": tokens.radiusMd,
    "--radius-lg": tokens.radiusLg,

    "--ease-default": tokens.easeDefault,
  };
}
