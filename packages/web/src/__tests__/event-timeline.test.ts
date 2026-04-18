/**
 * Tests for EventTimeline component.
 *
 * Verifies that:
 * - EventTimeline accepts onEventSelect prop (drawer pattern, not inline expand)
 * - No expanded state in EventTimeline (removed in favor of drawer)
 * - Border color classes map correctly to CSS variables
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const WEB_SRC = join(import.meta.dir, "..");

function readFile(relativePath: string): string {
  return readFileSync(join(WEB_SRC, relativePath), "utf-8");
}

describe("EventTimeline component", () => {
  const src = readFile("components/ui/EventTimeline.tsx");

  test("exports EventTimeline function", () => {
    expect(src).toContain("export function EventTimeline");
  });

  test("accepts onEventSelect prop for drawer pattern", () => {
    expect(src).toContain("onEventSelect?: (event: TimelineEvent) => void");
  });

  test("calls onEventSelect when a row is clicked", () => {
    expect(src).toContain("onEventSelect?.(event)");
  });

  test("does NOT have expanded state (removed in favor of drawer)", () => {
    // Should not have useState for expanded/expandedId
    expect(src).not.toContain("expandedId");
    expect(src).not.toMatch(/useState.*expanded/);
  });

  test("does NOT render inline detail content (uses drawer instead)", () => {
    // No conditional rendering of detail content below the row
    // The detail prop exists on TimelineEvent but is only shown in the drawer
    expect(src).not.toContain("isExpanded");
  });
});

describe("EventTimeline border color mapping", () => {
  const src = readFile("components/ui/EventTimeline.tsx");

  test("green maps to --completed", () => {
    expect(src).toContain('green: "border-l-[var(--completed)]"');
  });

  test("blue maps to --running", () => {
    expect(src).toContain('blue: "border-l-[var(--running)]"');
  });

  test("red maps to --failed", () => {
    expect(src).toContain('red: "border-l-[var(--failed)]"');
  });

  test("amber maps to --waiting", () => {
    expect(src).toContain('amber: "border-l-[var(--waiting)]"');
  });

  test("gray maps to --stopped", () => {
    expect(src).toContain('gray: "border-l-[var(--stopped)]"');
  });
});

describe("EventTimeline type exports", () => {
  const src = readFile("components/ui/EventTimeline.tsx");

  test("exports TimelineEvent interface", () => {
    expect(src).toContain("export interface TimelineEvent");
  });

  test("exports EventColor type", () => {
    expect(src).toContain("export type EventColor");
  });

  test("TimelineEvent has id, timestamp, label, color fields", () => {
    expect(src).toContain("id: string");
    expect(src).toContain("timestamp: string");
    expect(src).toContain("label: React.ReactNode");
    expect(src).toContain("color: EventColor");
  });

  test("TimelineEvent has optional rawData for drawer display", () => {
    expect(src).toContain("rawData?: Record<string, unknown>");
  });

  test("TimelineEvent has optional eventType for drawer display", () => {
    expect(src).toContain("eventType?: string");
  });
});
