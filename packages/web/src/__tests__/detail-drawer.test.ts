/**
 * Tests for DetailDrawer component.
 *
 * Verifies that:
 * - DetailDrawer exists with open, onClose, title, children props
 * - Has fixed overlay and right-side panel
 * - Close button exists with X icon
 * - Panel width is 520px
 * - Escape key closes the drawer
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const WEB_SRC = join(import.meta.dir, "..");

function readFile(relativePath: string): string {
  return readFileSync(join(WEB_SRC, relativePath), "utf-8");
}

describe("DetailDrawer component", () => {
  const src = readFile("components/ui/DetailDrawer.tsx");

  test("exports DetailDrawer function", () => {
    expect(src).toContain("export function DetailDrawer");
  });

  test("accepts open, onClose, title, children props", () => {
    expect(src).toContain("open: boolean");
    expect(src).toContain("onClose: () => void");
    expect(src).toContain("title: string");
    expect(src).toContain("children: React.ReactNode");
  });

  test("destructures all props in function signature", () => {
    expect(src).toContain("{ open, onClose, title, children }");
  });
});

describe("DetailDrawer overlay", () => {
  const src = readFile("components/ui/DetailDrawer.tsx");

  test("has fixed overlay with inset-0", () => {
    expect(src).toContain("fixed inset-0");
  });

  test("overlay has z-40", () => {
    expect(src).toContain("z-40");
  });

  test("overlay uses semi-transparent black background", () => {
    expect(src).toContain("bg-black/40");
  });

  test("clicking overlay calls onClose", () => {
    expect(src).toContain("onClick={onClose}");
  });
});

describe("DetailDrawer panel", () => {
  const src = readFile("components/ui/DetailDrawer.tsx");

  test("panel is fixed to the right side", () => {
    expect(src).toContain("fixed top-0 right-0");
  });

  test("panel width is 520px", () => {
    expect(src).toContain("w-[520px]");
  });

  test("panel has max-w-[90vw] for mobile safety", () => {
    expect(src).toContain("max-w-[90vw]");
  });

  test("panel has z-50 (above overlay)", () => {
    expect(src).toContain("z-50");
  });

  test("panel slides in/out with translate-x transform", () => {
    expect(src).toContain("translate-x-0");
    expect(src).toContain("translate-x-full");
  });

  test("panel has border-l for visual separation", () => {
    expect(src).toContain("border-l border-[var(--border)]");
  });
});

describe("DetailDrawer close button", () => {
  const src = readFile("components/ui/DetailDrawer.tsx");

  test("has close button with aria-label", () => {
    expect(src).toContain('aria-label="Close drawer"');
  });

  test("imports X icon from lucide-react", () => {
    expect(src).toContain('import { X } from "lucide-react"');
  });

  test("close button calls onClose", () => {
    // The close button's onClick should call onClose
    expect(src).toContain("onClick={onClose}");
  });
});

describe("DetailDrawer keyboard support", () => {
  const src = readFile("components/ui/DetailDrawer.tsx");

  test("listens for Escape key to close", () => {
    expect(src).toContain('"Escape"');
    expect(src).toContain("onClose()");
  });

  test("only adds keydown listener when open", () => {
    expect(src).toContain("if (!open) return");
  });

  test("cleans up event listener on unmount", () => {
    expect(src).toContain("removeEventListener");
  });
});
