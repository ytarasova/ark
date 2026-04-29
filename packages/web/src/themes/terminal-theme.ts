/**
 * Reads the active CSS theme tokens off `:root` and produces an xterm.js
 * `ITheme`. Centralised here so both Live and Static terminal panels stay
 * in sync with the rest of the app: the canvas, foreground, selection and
 * scrollbar slider all bind to theme tokens, so swapping themes (or dark/
 * light variants) shifts the terminal alongside everything else.
 *
 * The slider color itself is applied via CSS (.terminal-host .xterm ...
 * .slider { background: var(--border) }) so it tracks live theme changes
 * automatically. Canvas-level colours read here are pushed back into the
 * existing xterm instance via `term.options.theme = buildTerminalTheme()`
 * from a theme-reactive effect in StaticTerminal + LiveTerminalPanel, so
 * a theme switch mid-session repaints both terminals without remount.
 * ANSI palette colours stay hard-coded since they're canonical and do
 * not belong on the theme switcher.
 */
function readVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function buildTerminalTheme() {
  const background = readVar("--bg-code", "#0a0a0a");
  const foreground = readVar("--fg", "#e4e4e7");
  const selectionBackground = readVar("--bg-hover", "#3f3f46");
  return {
    background,
    foreground,
    // Cursor colour is theme-agnostic (foreground is fine for live, the
    // canvas colour for static replays where we want the cursor hidden).
    selectionBackground,
    // OverviewRulerRenderer paints a 1px stripe on the left edge of the
    // ruler canvas using this colour (xterm defaults to foreground -> a
    // bright vertical line; passing "transparent" doesn't help because
    // xterm's css.toColor() throws and silently falls back to fg). Match
    // the canvas so the 1px stripe is invisible.
    overviewRulerBorder: background,
    // Canonical ANSI palette -- these don't change with the theme.
    black: "#09090b",
    red: "#ef4444",
    green: "#22c55e",
    yellow: "#eab308",
    blue: "#3b82f6",
    magenta: "#a855f7",
    cyan: "#06b6d4",
    white: "#e4e4e7",
    brightBlack: "#52525b",
    brightRed: "#f87171",
    brightGreen: "#4ade80",
    brightYellow: "#facc15",
    brightBlue: "#60a5fa",
    brightMagenta: "#c084fc",
    brightCyan: "#22d3ee",
    brightWhite: "#fafafa",
  };
}
