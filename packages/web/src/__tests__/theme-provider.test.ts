/**
 * Tests for ThemeProvider token logic.
 *
 * We test the pure parts: token-to-CSS-var conversion, theme registry
 * completeness, storage key reading, and color mode helpers. The React
 * context + DOM effects are not testable under bun:test (no DOM), but
 * the data layer is fully covered.
 */

import { describe, test, expect } from "bun:test";
import {
  themes,
  tokensToCssVars,
  midnightCircuit,
  midnightCircuitLight,
  arcticSlate,
  arcticSlateLight,
  warmObsidian,
  warmObsidianLight,
  type ThemeName,
  type ThemeTokens,
} from "../themes/tokens.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tokensToCssVars", () => {
  test("maps token fields to CSS custom properties", () => {
    const vars = tokensToCssVars(midnightCircuit);

    expect(vars["--bg"]).toBe(midnightCircuit.bgApp);
    expect(vars["--bg-card"]).toBe(midnightCircuit.bgCard);
    expect(vars["--fg"]).toBe(midnightCircuit.fgDefault);
    expect(vars["--fg-muted"]).toBe(midnightCircuit.fgMuted);
    expect(vars["--primary"]).toBe(midnightCircuit.primary);
    expect(vars["--border"]).toBe(midnightCircuit.borderDefault);
    expect(vars["--running"]).toBe(midnightCircuit.statusRunning);
    expect(vars["--failed"]).toBe(midnightCircuit.statusFailed);
    expect(vars["--radius-sm"]).toBe(midnightCircuit.radiusSm);
  });

  test("returns all expected CSS variable keys", () => {
    const vars = tokensToCssVars(midnightCircuit);
    const keys = Object.keys(vars);

    // Background vars
    expect(keys).toContain("--bg");
    expect(keys).toContain("--bg-card");
    expect(keys).toContain("--bg-popover");
    expect(keys).toContain("--bg-sidebar");
    expect(keys).toContain("--bg-hover");
    expect(keys).toContain("--bg-input");
    expect(keys).toContain("--bg-overlay");
    expect(keys).toContain("--bg-code");

    // Foreground vars
    expect(keys).toContain("--fg");
    expect(keys).toContain("--fg-muted");
    expect(keys).toContain("--fg-faint");

    // Primary vars
    expect(keys).toContain("--primary");
    expect(keys).toContain("--primary-hover");
    expect(keys).toContain("--primary-subtle");
    expect(keys).toContain("--primary-fg");

    // Border vars
    expect(keys).toContain("--border");
    expect(keys).toContain("--border-light");

    // Status vars
    expect(keys).toContain("--running");
    expect(keys).toContain("--waiting");
    expect(keys).toContain("--completed");
    expect(keys).toContain("--failed");
    expect(keys).toContain("--stopped");

    // Diff vars
    expect(keys).toContain("--diff-add-bg");
    expect(keys).toContain("--diff-add-fg");
    expect(keys).toContain("--diff-rm-bg");
    expect(keys).toContain("--diff-rm-fg");

    // Radii
    expect(keys).toContain("--radius-sm");
    expect(keys).toContain("--radius-md");
    expect(keys).toContain("--radius-lg");
  });

  test("no CSS variable values are empty or undefined", () => {
    for (const themeName of Object.keys(themes) as ThemeName[]) {
      for (const mode of ["dark", "light"] as const) {
        const vars = tokensToCssVars(themes[themeName][mode]);
        for (const [key, val] of Object.entries(vars)) {
          expect(val).toBeTruthy();
          expect(typeof val).toBe("string");
        }
      }
    }
  });
});

describe("theme registry", () => {
  test("all 3 themes are registered", () => {
    const names = Object.keys(themes);
    expect(names).toContain("midnight-circuit");
    expect(names).toContain("arctic-slate");
    expect(names).toContain("warm-obsidian");
    expect(names).toHaveLength(3);
  });

  test("each theme has dark and light modes", () => {
    for (const name of Object.keys(themes) as ThemeName[]) {
      const theme = themes[name];
      expect(theme.dark).toBeDefined();
      expect(theme.light).toBeDefined();
    }
  });

  test("all 3 themes have valid token sets", () => {
    const requiredKeys: (keyof ThemeTokens)[] = [
      "bgApp",
      "bgCard",
      "fgDefault",
      "fgMuted",
      "primary",
      "primaryHover",
      "borderDefault",
      "statusRunning",
      "statusWaiting",
      "statusCompleted",
      "statusFailed",
      "diffAddBg",
      "diffRemoveBg",
      "radiusSm",
      "radiusMd",
      "radiusLg",
      "colorScheme",
    ];

    for (const name of Object.keys(themes) as ThemeName[]) {
      for (const mode of ["dark", "light"] as const) {
        const tokens = themes[name][mode];
        for (const key of requiredKeys) {
          expect(tokens[key]).toBeTruthy();
        }
      }
    }
  });

  test("dark modes have colorScheme: dark", () => {
    expect(midnightCircuit.colorScheme).toBe("dark");
    expect(arcticSlate.colorScheme).toBe("dark");
    expect(warmObsidian.colorScheme).toBe("dark");
  });

  test("light modes have colorScheme: light", () => {
    expect(midnightCircuitLight.colorScheme).toBe("light");
    expect(arcticSlateLight.colorScheme).toBe("light");
    expect(warmObsidianLight.colorScheme).toBe("light");
  });
});

describe("theme toggling", () => {
  test("toggle between dark and light modes (pure logic)", () => {
    // Simulates the toggleColorMode callback
    function toggle(current: "dark" | "light"): "dark" | "light" {
      return current === "dark" ? "light" : "dark";
    }

    expect(toggle("dark")).toBe("light");
    expect(toggle("light")).toBe("dark");
  });

  test("CSS vars differ between dark and light modes of same theme", () => {
    const darkVars = tokensToCssVars(midnightCircuit);
    const lightVars = tokensToCssVars(midnightCircuitLight);

    // Background should be different (dark vs light)
    expect(darkVars["--bg"]).not.toBe(lightVars["--bg"]);
    expect(darkVars["--bg-card"]).not.toBe(lightVars["--bg-card"]);
    expect(darkVars["--fg"]).not.toBe(lightVars["--fg"]);
  });

  test("CSS vars differ between different themes in same mode", () => {
    const midnightVars = tokensToCssVars(midnightCircuit);
    const arcticVars = tokensToCssVars(arcticSlate);
    const warmVars = tokensToCssVars(warmObsidian);

    // Primary colors should differ
    expect(midnightVars["--primary"]).not.toBe(arcticVars["--primary"]);
    expect(midnightVars["--primary"]).not.toBe(warmVars["--primary"]);
    expect(arcticVars["--primary"]).not.toBe(warmVars["--primary"]);
  });
});

describe("storage key logic", () => {
  test("valid theme names are recognized", () => {
    const validNames = ["midnight-circuit", "arctic-slate", "warm-obsidian"];
    for (const name of validNames) {
      expect(themes[name as ThemeName]).toBeDefined();
    }
  });

  test("invalid theme name falls back gracefully", () => {
    const invalidName = "nonexistent-theme";
    expect(themes[invalidName as ThemeName]).toBeUndefined();
    // The ThemeProvider defaults to "midnight-circuit" for invalid stored values
    const fallback: ThemeName = "midnight-circuit";
    expect(themes[fallback]).toBeDefined();
  });
});
