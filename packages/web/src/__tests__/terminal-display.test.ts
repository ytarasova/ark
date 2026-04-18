/**
 * Tests for StaticTerminal component.
 *
 * Verifies that:
 * - StaticTerminal accepts output prop
 * - Auto-detects column width from output content
 * - Container has overflow-x-auto for horizontal scroll
 * - Does NOT use FitAddon (uses manual row calculation instead)
 * - Terminal tab in SessionDetail uses correct container classes
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const WEB_SRC = join(import.meta.dir, "..");

function readComponent(relativePath: string): string {
  return readFileSync(join(WEB_SRC, relativePath), "utf-8");
}

describe("StaticTerminal component", () => {
  const src = readComponent("components/StaticTerminal.tsx");

  test("exports StaticTerminal component", () => {
    expect(src).toContain("export function StaticTerminal");
  });

  test("accepts output prop", () => {
    expect(src).toContain("interface StaticTerminalProps");
    expect(src).toContain("output: string");
  });

  test("auto-detects column width from output content", () => {
    expect(src).toContain("detectCols");
    expect(src).toContain("stripAnsi");
  });

  test("container has overflow-x-auto for horizontal scroll", () => {
    expect(src).toContain("overflow-x-auto");
  });

  test("does NOT import or instantiate FitAddon -- uses manual row calculation instead", () => {
    // FitAddon may appear in a comment explaining why it is not used,
    // but it must NOT be imported or instantiated
    expect(src).not.toContain("@xterm/addon-fit");
    expect(src).not.toContain("new FitAddon");
    expect(src).not.toContain("import { FitAddon");
    // Verify it calculates rows manually instead
    expect(src).toContain("Math.floor");
    expect(src).toContain("cellHeight");
  });

  test("passes cols to XTerm constructor", () => {
    // The terminal options should include cols
    expect(src).toMatch(/new XTerm\(\{[\s\S]*?cols,/);
  });

  test("uses ResizeObserver for dynamic row fitting", () => {
    expect(src).toContain("ResizeObserver");
    expect(src).toContain("resizeObserver.observe");
    expect(src).toContain("resizeObserver.disconnect");
  });
});

describe("Terminal tab in SessionDetail", () => {
  const sessionDetail = readComponent("components/SessionDetail.tsx");

  test("imports StaticTerminal", () => {
    expect(sessionDetail).toContain('import { StaticTerminal } from "./StaticTerminal.js"');
  });

  test("terminal tab content uses flex-1 min-h-0 container", () => {
    // The terminal tab wrapper should have flex-1 min-h-0 for proper sizing
    expect(sessionDetail).toContain('className="flex-1 min-h-0"');
  });

  test("renders StaticTerminal with output prop", () => {
    expect(sessionDetail).toContain("<StaticTerminal output={output}");
  });

  test("shows empty state when no terminal output", () => {
    expect(sessionDetail).toContain("No terminal output available");
  });
});
