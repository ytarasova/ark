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

  it("sel follows visual group order, not original array order", () => {
    // Items in reverse group order (z before a)
    const unsorted = [
      { id: "z", name: "Zulu", group: "z-group" },
      { id: "a", name: "Alpha", group: "a-group" },
    ];
    // sel=0 should select the first VISUAL item (a-group → Alpha)
    const { lastFrame, unmount } = render(
      <TreeList
        items={unsorted}
        groupBy={(i) => i.group}
        renderRow={(i, selected) => `${selected ? ">" : " "} ${i.name}`}
        sel={0}
      />
    );
    const frame = lastFrame()!;
    // Alpha (a-group) should be selected, not Zulu (z-group)
    expect(frame).toContain("> Alpha");
    expect(frame).not.toContain("> Zulu");
    unmount();
  });

  it("sel=1 selects second visual item across groups", () => {
    const unsorted = [
      { id: "z", name: "Zulu", group: "z-group" },
      { id: "a", name: "Alpha", group: "a-group" },
    ];
    // sel=1 should select Zulu (second in visual order)
    const { lastFrame, unmount } = render(
      <TreeList
        items={unsorted}
        groupBy={(i) => i.group}
        renderRow={(i, selected) => `${selected ? ">" : " "} ${i.name}`}
        sel={1}
      />
    );
    const frame = lastFrame()!;
    expect(frame).toContain("> Zulu");
    expect(frame).not.toContain("> Alpha");
    unmount();
  });

  it("groupSort controls group header ordering", () => {
    const statusItems = [
      { id: "r1", name: "Run1", group: "Running" },
      { id: "s1", name: "Stop1", group: "Stopped" },
      { id: "w1", name: "Wait1", group: "Waiting" },
    ];
    // Custom sort: Running=0, Waiting=1, Stopped=2
    const order: Record<string, number> = { Running: 0, Waiting: 1, Stopped: 2 };
    const { lastFrame, unmount } = render(
      <TreeList
        items={statusItems}
        groupBy={(i) => i.group}
        groupSort={(a, b) => (order[a] ?? 9) - (order[b] ?? 9)}
        renderRow={(i, selected) => `${selected ? ">" : " "} ${i.name}`}
        sel={0}
      />
    );
    const frame = lastFrame()!;
    // Running should come before Waiting, Waiting before Stopped
    const runIdx = frame.indexOf("Running");
    const waitIdx = frame.indexOf("Waiting");
    const stopIdx = frame.indexOf("Stopped");
    expect(runIdx).toBeLessThan(waitIdx);
    expect(waitIdx).toBeLessThan(stopIdx);
    // sel=0 should select first item in first group (Running -> Run1)
    expect(frame).toContain("> Run1");
    unmount();
  });

  it("group headers contain group name and item count", () => {
    const statusItems = [
      { id: "r1", name: "Run1", group: "Running" },
      { id: "r2", name: "Run2", group: "Running" },
      { id: "f1", name: "Fail1", group: "Failed" },
    ];
    const { lastFrame, unmount } = render(
      <TreeList
        items={statusItems}
        groupBy={(i) => i.group}
        renderRow={(i) => `  ${i.name}`}
        sel={0}
      />
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Failed (1)");
    expect(frame).toContain("Running (2)");
    unmount();
  });

  it("group header is visible when first item in group is selected", () => {
    const statusItems = [
      { id: "r1", name: "Run1", group: "Running" },
      { id: "f1", name: "Fail1", group: "Failed" },
    ];
    // sel=0 selects first item (Failed -> Fail1, alphabetical order)
    const { lastFrame, unmount } = render(
      <TreeList
        items={statusItems}
        groupBy={(i) => i.group}
        renderRow={(i, selected) => `${selected ? ">" : " "} ${i.name}`}
        sel={0}
      />
    );
    const frame = lastFrame()!;
    // Both the group header and the selected item should be visible
    expect(frame).toContain("Failed (1)");
    expect(frame).toContain("> Fail1");
    unmount();
  });

  it("first group header appears on the first line of output", () => {
    const statusItems = [
      { id: "r1", name: "Run1", group: "Running" },
      { id: "r2", name: "Run2", group: "Running" },
      { id: "f1", name: "Fail1", group: "Failed" },
    ];
    const order: Record<string, number> = { Running: 0, Failed: 1 };
    const { lastFrame, unmount } = render(
      <TreeList
        items={statusItems}
        groupBy={(i) => i.group}
        groupSort={(a, b) => (order[a] ?? 9) - (order[b] ?? 9)}
        renderRow={(i, selected) => `${selected ? ">" : " "} ${i.name}`}
        sel={0}
      />
    );
    const frame = lastFrame()!;
    const lines = frame.split("\n").filter(l => l.trim());
    // First non-empty line MUST be the first group header
    expect(lines[0]).toContain("Running (2)");
    // Second line is the selected item
    expect(lines[1]).toContain("> Run1");
    // Failed group header appears later
    const failedIdx = lines.findIndex(l => l.includes("Failed"));
    expect(failedIdx).toBeGreaterThan(2);
    unmount();
  });

  it("empty groups between items don't break selection", () => {
    const items = [
      { id: "c", name: "Charlie", group: "c-group" },
      { id: "a", name: "Alpha", group: "a-group" },
    ];
    // b-group is empty but present
    const { lastFrame, unmount } = render(
      <TreeList
        items={items}
        groupBy={(i) => i.group}
        emptyGroups={["b-group"]}
        renderRow={(i, selected) => `${selected ? ">" : " "} ${i.name}`}
        sel={0}
      />
    );
    const frame = lastFrame()!;
    // sel=0 should be Alpha (a-group, first alphabetically)
    expect(frame).toContain("> Alpha");
    expect(frame).toContain("(empty)"); // b-group shows as empty
    expect(frame).not.toContain("> Charlie");
    unmount();
  });
});
