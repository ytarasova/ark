import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { TreeList } from "../components/TreeList.js";

const items = [
  { id: "a", name: "Alpha", group: "g1" },
  { id: "b", name: "Beta", group: "g1" },
  { id: "c", name: "Gamma", group: "g2" },
];

describe("TreeList", () => {
  it("renders flat list when no groupBy", () => {
    const { lastFrame, unmount } = render(
      <TreeList items={items} renderRow={(item) => `  ${item.name}`} sel={0} />
    );
    expect(lastFrame()!).toContain("Alpha");
    expect(lastFrame()!).toContain("Beta");
    expect(lastFrame()!).toContain("Gamma");
    unmount();
  });

  it("renders group headers when groupBy is provided", () => {
    const { lastFrame, unmount } = render(
      <TreeList items={items} groupBy={(i) => i.group} renderRow={(i) => `  ${i.name}`} sel={0} />
    );
    expect(lastFrame()!).toContain("g1");
    expect(lastFrame()!).toContain("g2");
    unmount();
  });

  it("shows empty message when no items", () => {
    const { lastFrame, unmount } = render(
      <TreeList items={[]} renderRow={() => ""} sel={0} emptyMessage="Nothing here." />
    );
    expect(lastFrame()!).toContain("Nothing here.");
    unmount();
  });

  it("renders children under items", () => {
    const { lastFrame, unmount } = render(
      <TreeList
        items={[items[0]]}
        renderRow={(i) => `  ${i.name}`}
        renderChildren={(i) => <Text dimColor>{"    child of " + i.name}</Text>}
        sel={0}
      />
    );
    expect(lastFrame()!).toContain("child of Alpha");
    unmount();
  });

  it("uses renderColoredRow for unselected items", () => {
    const { lastFrame, unmount } = render(
      <TreeList
        items={items}
        renderRow={(i) => `  ${i.name}`}
        renderColoredRow={(i) => <Text color="green">{`  ${i.name}`}</Text>}
        sel={0}
      />
    );
    expect(lastFrame()!).toContain("Beta");
    expect(lastFrame()!).toContain("Gamma");
    unmount();
  });
});
