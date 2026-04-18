/**
 * Tests for session view layout and scroll behavior.
 *
 * Verifies that:
 * - The center panel constrains its children with overflow-hidden
 * - The scrollable content area uses overflow-y-auto
 * - Auto-scroll only fires for new messages on active sessions, not on initial load
 * - The error card has shrink-0 to prevent flex compression
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const WEB_SRC = join(import.meta.dir, "..");

function readComponent(relativePath: string): string {
  return readFileSync(join(WEB_SRC, relativePath), "utf-8");
}

describe("session layout overflow constraints", () => {
  const sessionsPage = readComponent("pages/SessionsPage.tsx");
  const sessionDetail = readComponent("components/SessionDetail.tsx");

  test("center panel wrapper has overflow-hidden to constrain children", () => {
    // The wrapper around SessionDetail must have overflow-hidden
    // to prevent flex children from growing beyond viewport
    const centerPanelMatch = sessionsPage.match(/className="flex-1 flex flex-col min-w-0[^"]*"/g);
    expect(centerPanelMatch).not.toBeNull();
    const hasOverflowHidden = centerPanelMatch!.some((cls) => cls.includes("overflow-hidden"));
    expect(hasOverflowHidden).toBe(true);
  });

  test("session detail scroll container uses overflow-y-auto", () => {
    // The scroll container uses dynamic classes (terminal tab gets different overflow)
    // but the default non-terminal mode must include overflow-y-auto
    expect(sessionDetail).toContain('"overflow-y-auto px-6 py-6"');
  });

  test("session detail root is flex-1 flex flex-col with min-h-0", () => {
    // SessionDetail must be flex-1 flex-col with min-h-0 to fill remaining space
    // min-h-0 overrides flex's default min-height:auto so the scroll container activates
    expect(sessionDetail).toContain('className="flex-1 flex flex-col min-w-0 min-h-0 bg-[var(--bg)]"');
  });

  test("error card has shrink-0 to prevent flex compression", () => {
    // The error card div must have shrink-0
    const errorCardPattern = /session\.status === "failed" && session\.error/;
    expect(sessionDetail).toMatch(errorCardPattern);
    // The error card div's className must include shrink-0
    const errorCardMatch = sessionDetail.match(
      /session\.status === "failed" && session\.error[\s\S]*?className="[^"]*shrink-0[^"]*"/,
    );
    expect(errorCardMatch).not.toBeNull();
  });
});

describe("auto-scroll behavior", () => {
  const sessionDetail = readComponent("components/SessionDetail.tsx");

  test("tracks previous message count to avoid scrolling on initial load", () => {
    // Must have a ref to track previous message count
    expect(sessionDetail).toContain("prevMsgCountRef");
    expect(sessionDetail).toContain("useRef<number | null>(null)");
  });

  test("auto-scroll checks for new messages, not just any message count", () => {
    // The useEffect must compare prev vs current count
    expect(sessionDetail).toContain("prev === null");
    expect(sessionDetail).toContain("prev === count");
  });

  test("auto-scroll only fires for active sessions", () => {
    // scrollIntoView should be gated by isActive
    const scrollEffect = sessionDetail.match(/scrollIntoView[\s\S]*?isActive/);
    expect(scrollEffect).not.toBeNull();
  });

  test("auto-scroll does not fire unconditionally on mount", () => {
    // The old pattern was: if (bottomRef.current && activeTab === "conversation")
    // The new pattern must include a guard against initial load
    // Verify we don't have the old unconditional pattern
    const oldPattern =
      /if \(bottomRef\.current && activeTab === "conversation"\)\s*\{\s*bottomRef\.current\.scrollIntoView/;
    expect(sessionDetail).not.toMatch(oldPattern);
  });
});

describe("layout component overflow chain", () => {
  const layout = readComponent("components/Layout.tsx");

  test("root container is h-screen with overflow-hidden", () => {
    expect(layout).toContain("h-screen");
    expect(layout).toContain("overflow-hidden");
  });

  test("content area has overflow-hidden", () => {
    // The div wrapping children must have overflow-hidden
    const contentMatch = layout.match(/className="flex-1 flex min-w-0 overflow-hidden"/);
    expect(contentMatch).not.toBeNull();
  });
});
