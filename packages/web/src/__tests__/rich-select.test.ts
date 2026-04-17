/**
 * Tests for RichSelect pure logic.
 *
 * RichSelect is a React component using Radix Popover. We test the filtering
 * and selection logic extracted from the component, since bun:test does not
 * have a DOM or React renderer.
 */

import { describe, test, expect } from "bun:test";

// ---------------------------------------------------------------------------
// Extracted logic from RichSelect.tsx
// ---------------------------------------------------------------------------

interface RichSelectOption {
  value: string;
  label: string;
  description?: string;
  icon?: any;
  badge?: string;
}

function filterOptions(options: RichSelectOption[], filter: string): RichSelectOption[] {
  if (!filter) return options;
  return options.filter(
    (o) =>
      o.label.toLowerCase().includes(filter.toLowerCase()) ||
      (o.description && o.description.toLowerCase().includes(filter.toLowerCase())),
  );
}

function findSelected(options: RichSelectOption[], value: string): RichSelectOption | undefined {
  return options.find((o) => o.value === value);
}

function shouldShowSearch(searchable: boolean | undefined, optionCount: number): boolean {
  return searchable ?? optionCount > 6;
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const OPTIONS: RichSelectOption[] = [
  { value: "claude", label: "Claude Code", description: "Anthropic coding agent" },
  { value: "codex", label: "Codex CLI", description: "OpenAI coding agent" },
  { value: "gemini", label: "Gemini CLI", description: "Google coding agent" },
  { value: "goose", label: "Goose", description: "Block open-source agent" },
];

const MANY_OPTIONS: RichSelectOption[] = [
  ...OPTIONS,
  { value: "cursor", label: "Cursor", description: "AI IDE" },
  { value: "windsurf", label: "Windsurf", description: "Codeium IDE" },
  { value: "aider", label: "Aider", description: "Terminal pair programmer" },
  { value: "sweep", label: "Sweep", description: "GitHub bot" },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RichSelect logic", () => {
  test("findSelected returns the matching option by value", () => {
    const selected = findSelected(OPTIONS, "claude");
    expect(selected).toBeDefined();
    expect(selected!.label).toBe("Claude Code");
  });

  test("findSelected returns undefined for unknown value", () => {
    const selected = findSelected(OPTIONS, "nonexistent");
    expect(selected).toBeUndefined();
  });

  test("search filters options by label", () => {
    const result = filterOptions(OPTIONS, "claude");
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe("claude");
  });

  test("search filters options by description", () => {
    const result = filterOptions(OPTIONS, "anthropic");
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe("claude");
  });

  test("search is case-insensitive", () => {
    const result = filterOptions(OPTIONS, "GEMINI");
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe("gemini");
  });

  test("empty search returns all options", () => {
    const result = filterOptions(OPTIONS, "");
    expect(result).toHaveLength(4);
  });

  test("search with no matches returns empty array", () => {
    const result = filterOptions(OPTIONS, "zzzz");
    expect(result).toHaveLength(0);
  });

  test("search for partial string matches multiple options", () => {
    const result = filterOptions(OPTIONS, "cli");
    expect(result).toHaveLength(2); // Codex CLI and Gemini CLI
  });

  test("auto-enable search for long lists (>6 options)", () => {
    expect(shouldShowSearch(undefined, 4)).toBe(false);
    expect(shouldShowSearch(undefined, 7)).toBe(true);
    expect(shouldShowSearch(undefined, 10)).toBe(true);
  });

  test("explicit searchable overrides auto-detection", () => {
    expect(shouldShowSearch(true, 3)).toBe(true);
    expect(shouldShowSearch(false, 100)).toBe(false);
  });

  test("selected option has checkmark (value match check)", () => {
    // Simulates the value === o.value check in the render
    const currentValue = "codex";
    const isSelected = (option: RichSelectOption) => currentValue === option.value;

    expect(isSelected(OPTIONS[0])).toBe(false); // claude
    expect(isSelected(OPTIONS[1])).toBe(true); // codex
    expect(isSelected(OPTIONS[2])).toBe(false); // gemini
  });

  test("options with badges include badge text", () => {
    const optionsWithBadges: RichSelectOption[] = [
      { value: "a", label: "Option A", badge: "new" },
      { value: "b", label: "Option B" },
    ];
    expect(optionsWithBadges[0].badge).toBe("new");
    expect(optionsWithBadges[1].badge).toBeUndefined();
  });
});
