/**
 * Tests for ScrollBox component — rendering, follow mode, scroll indicators.
 */

import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { ScrollBox } from "../components/ScrollBox.js";

describe("ScrollBox", () => {
  it("renders children", () => {
    const { lastFrame, unmount } = render(
      <ScrollBox>
        <Text>Line 1</Text>
        <Text>Line 2</Text>
        <Text>Line 3</Text>
      </ScrollBox>
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Line 1");
    expect(frame).toContain("Line 2");
    expect(frame).toContain("Line 3");
    unmount();
  });

  it("does not respond to j/k in followIndex mode", async () => {
    // In follow mode, the ScrollBox delegates scrolling to the parent.
    // j/k should NOT change the internal offset.
    // We create enough items to overflow, then verify j key does nothing.
    const items = Array.from({ length: 50 }, (_, i) => <Text key={i}>Item {i}</Text>);

    const { lastFrame, stdin, unmount } = render(
      <ScrollBox followIndex={0} reserveRows={6}>
        {items}
      </ScrollBox>
    );

    const before = lastFrame()!;
    stdin.write("j");
    stdin.write("j");
    stdin.write("j");
    await new Promise(r => setTimeout(r, 50));
    const after = lastFrame()!;

    // The frame should be unchanged because j/k are ignored in follow mode
    expect(after).toBe(before);
    unmount();
  });

  it("shows scroll indicator when content overflows", () => {
    // Create more items than can fit in the terminal (default 40 - 6 reserve = 34 rows)
    const items = Array.from({ length: 50 }, (_, i) => <Text key={i}>Item {i}</Text>);

    const { lastFrame, unmount } = render(
      <ScrollBox reserveRows={6}>
        {items}
      </ScrollBox>
    );

    const frame = lastFrame()!;
    // Should show the down arrow indicator (content below)
    expect(frame).toContain("\u25BC"); // ▼
    unmount();
  });
});
