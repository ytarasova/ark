import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { TreeList } from "../components/TreeList.js";

const items = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Beta" },
  { id: "c", name: "Gamma" },
];

describe("TreeList consistency", () => {
  it("renders > marker for selected item and spaces for unselected", () => {
    const { lastFrame, unmount } = render(
      <TreeList
        items={items}
        renderRow={(item) => item.name}
        sel={1}
      />
    );
    const frame = lastFrame()!;
    // Selected item (Beta at index 1) should have > prefix
    expect(frame).toContain("> Beta");
    // Unselected items should not have > prefix
    expect(frame).not.toContain("> Alpha");
    expect(frame).not.toContain("> Gamma");
    // Unselected items should have space prefix
    expect(frame).toContain("  Alpha");
    expect(frame).toContain("  Gamma");
    unmount();
  });

  it("works without groupBy (flat list)", () => {
    const { lastFrame, unmount } = render(
      <TreeList
        items={items}
        renderRow={(item) => item.name}
        sel={0}
      />
    );
    const frame = lastFrame()!;
    // All items should be rendered
    expect(frame).toContain("Alpha");
    expect(frame).toContain("Beta");
    expect(frame).toContain("Gamma");
    // No group headers should be present
    expect(frame).not.toMatch(/^\s*g\d/m);
    // First item should be selected
    expect(frame).toContain("> Alpha");
    unmount();
  });
});
