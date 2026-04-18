/**
 * Tests for maximize/minimize session view functionality.
 *
 * Verifies that:
 * - SessionsPage has maximized state
 * - Maximize2/Minimize2 icons are imported
 * - Session list is hidden when maximized
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const WEB_SRC = join(import.meta.dir, "..");

function readFile(relativePath: string): string {
  return readFileSync(join(WEB_SRC, relativePath), "utf-8");
}

describe("SessionsPage maximize/minimize state", () => {
  const src = readFile("pages/SessionsPage.tsx");

  test("has maximized state initialized to false", () => {
    expect(src).toContain("useState(false)");
    expect(src).toContain("const [maximized, setMaximized]");
  });

  test("imports Maximize2 and Minimize2 icons from lucide-react", () => {
    expect(src).toContain("Maximize2");
    expect(src).toContain("Minimize2");
    expect(src).toMatch(/import.*\{.*Maximize2.*Minimize2.*\}.*from "lucide-react"/);
  });

  test("toggles maximized state on button click", () => {
    expect(src).toContain("setMaximized((prev) => !prev)");
  });

  test("renders Minimize2 when maximized, Maximize2 otherwise", () => {
    expect(src).toContain("maximized ? <Minimize2");
    expect(src).toContain(": <Maximize2");
  });

  test("has tooltip title for maximize/minimize button", () => {
    expect(src).toContain("Restore session list");
    expect(src).toContain("Maximize session view");
  });
});

describe("SessionsPage session list hidden when maximized", () => {
  const src = readFile("pages/SessionsPage.tsx");

  test("session list panel is conditionally rendered based on maximized", () => {
    expect(src).toContain("!maximized &&");
    expect(src).toContain("<SessionListPanel");
  });

  test("clearing selected session resets maximized to false", () => {
    // When setSelectedId is called with null, maximized should reset
    expect(src).toContain("if (!id) setMaximized(false)");
  });

  test("maximize button only appears when a session is selected", () => {
    // The maximize button is inside the selectedId conditional block
    const selectedIdBlock = src.match(/selectedId \?[\s\S]*?<\/div>\s*\) : \(/);
    expect(selectedIdBlock).not.toBeNull();
    expect(selectedIdBlock![0]).toContain("setMaximized");
  });
});
