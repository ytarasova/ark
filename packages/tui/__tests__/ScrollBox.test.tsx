/**
 * Tests for ScrollBox component -- rendering, follow mode, scroll indicators.
 */

import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { ScrollBox } from "../components/ScrollBox.js";
import { waitFor } from "../../core/__tests__/test-helpers.js";

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
    const items = Array.from({ length: 50 }, (_, i) => <Text key={i}>Item {i}</Text>);

    const { lastFrame, stdin, unmount } = render(
      <ScrollBox followIndex={0}>
        {items}
      </ScrollBox>
    );

    const before = lastFrame()!;
    stdin.write("j");
    stdin.write("j");
    stdin.write("j");
    await waitFor(() => lastFrame()! === before);
    const after = lastFrame()!;
    expect(after).toBe(before);
    unmount();
  });

  it("followIndex beyond item count does not cause negative offset", () => {
    const items = Array.from({ length: 5 }, (_, i) => <Text key={i}>Item {i}</Text>);

    const { lastFrame, unmount } = render(
      <ScrollBox followIndex={100}>
        {items}
      </ScrollBox>
    );

    const frame = lastFrame()!;
    expect(frame).toContain("Item 0");
    expect(frame).toContain("Item 4");
    unmount();
  });

  it("renders all items when they fit in available space", () => {
    const items = Array.from({ length: 5 }, (_, i) => <Text key={i}>Row {i}</Text>);

    const { lastFrame, unmount } = render(
      <ScrollBox>
        {items}
      </ScrollBox>
    );

    const frame = lastFrame()!;
    expect(frame).toContain("Row 0");
    expect(frame).toContain("Row 4");
    // No scroll indicator for small lists
    expect(frame).not.toContain("\u25BC");
    unmount();
  });
});
