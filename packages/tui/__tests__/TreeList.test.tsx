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

const noop = () => {};

describe("TreeList", () => {
  it("renders flat list when no groupBy", () => {
    const { lastFrame, unmount } = render(
      <TreeList items={items} getKey={(i) => i.id} renderRow={(item) => `  ${item.name}`} selectedKey="a" onSelect={noop} />
    );
    expect(lastFrame()!).toContain("Alpha");
    expect(lastFrame()!).toContain("Beta");
    expect(lastFrame()!).toContain("Gamma");
    unmount();
  });

  it("renders group headers when groupBy is provided", () => {
    const { lastFrame, unmount } = render(
      <TreeList items={items} getKey={(i) => i.id} groupBy={(i) => i.group} renderRow={(i) => `  ${i.name}`} selectedKey="a" onSelect={noop} />
    );
    expect(lastFrame()!).toContain("g1");
    expect(lastFrame()!).toContain("g2");
    unmount();
  });

  it("shows empty message when no items", () => {
    const { lastFrame, unmount } = render(
      <TreeList items={[]} getKey={() => ""} renderRow={() => ""} selectedKey={null} onSelect={noop} emptyMessage="Nothing here." />
    );
    expect(lastFrame()!).toContain("Nothing here.");
    unmount();
  });

  it("renders children under items", () => {
    const { lastFrame, unmount } = render(
      <TreeList
        items={[items[0]]}
        getKey={(i) => i.id}
        renderRow={(i) => `  ${i.name}`}
        renderChildren={(i) => <Text dimColor>{"    child of " + i.name}</Text>}
        selectedKey="a"
        onSelect={noop}
      />
    );
    expect(lastFrame()!).toContain("child of Alpha");
    unmount();
  });

  it("uses renderColoredRow for unselected items", () => {
    const { lastFrame, unmount } = render(
      <TreeList
        items={items}
        getKey={(i) => i.id}
        renderRow={(i) => `  ${i.name}`}
        renderColoredRow={(i) => <Text color="green">{`  ${i.name}`}</Text>}
        selectedKey="a"
        onSelect={noop}
      />
    );
    expect(lastFrame()!).toContain("Beta");
    expect(lastFrame()!).toContain("Gamma");
    unmount();
  });

  it("selects correct item by key regardless of group order", () => {
    // Items in reverse group order (z before a)
    const unsorted = [
      { id: "z", name: "Zulu", group: "z-group" },
      { id: "a", name: "Alpha", group: "a-group" },
    ];
    // selectedKey="a" should select Alpha even though Zulu comes first in array
    const { lastFrame, unmount } = render(
      <TreeList
        items={unsorted}
        getKey={(i) => i.id}
        groupBy={(i) => i.group}
        renderRow={(i, selected) => `${selected ? ">" : " "} ${i.name}`}
        selectedKey="a"
        onSelect={noop}
      />
    );
    const frame = lastFrame()!;
    expect(frame).toContain("> Alpha");
    expect(frame).not.toContain("> Zulu");
    unmount();
  });

  it("selects second item by key across groups", () => {
    const unsorted = [
      { id: "z", name: "Zulu", group: "z-group" },
      { id: "a", name: "Alpha", group: "a-group" },
    ];
    // selectedKey="z" selects Zulu
    const { lastFrame, unmount } = render(
      <TreeList
        items={unsorted}
        getKey={(i) => i.id}
        groupBy={(i) => i.group}
        renderRow={(i, selected) => `${selected ? ">" : " "} ${i.name}`}
        selectedKey="z"
        onSelect={noop}
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
        getKey={(i) => i.id}
        groupBy={(i) => i.group}
        groupSort={(a, b) => (order[a] ?? 9) - (order[b] ?? 9)}
        renderRow={(i, selected) => `${selected ? ">" : " "} ${i.name}`}
        selectedKey="r1"
        onSelect={noop}
      />
    );
    const frame = lastFrame()!;
    // Running should come before Waiting, Waiting before Stopped
    const runIdx = frame.indexOf("Running");
    const waitIdx = frame.indexOf("Waiting");
    const stopIdx = frame.indexOf("Stopped");
    expect(runIdx).toBeLessThan(waitIdx);
    expect(waitIdx).toBeLessThan(stopIdx);
    // selectedKey="r1" selects Run1
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
        getKey={(i) => i.id}
        groupBy={(i) => i.group}
        renderRow={(i) => `  ${i.name}`}
        selectedKey="r1"
        onSelect={noop}
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
    // selectedKey="f1" selects Fail1 (first item in Failed group, alphabetically first)
    const { lastFrame, unmount } = render(
      <TreeList
        items={statusItems}
        getKey={(i) => i.id}
        groupBy={(i) => i.group}
        renderRow={(i, selected) => `${selected ? ">" : " "} ${i.name}`}
        selectedKey="f1"
        onSelect={noop}
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
        getKey={(i) => i.id}
        groupBy={(i) => i.group}
        groupSort={(a, b) => (order[a] ?? 9) - (order[b] ?? 9)}
        renderRow={(i, selected) => `${selected ? ">" : " "} ${i.name}`}
        selectedKey="r1"
        onSelect={noop}
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
        getKey={(i) => i.id}
        groupBy={(i) => i.group}
        emptyGroups={["b-group"]}
        renderRow={(i, selected) => `${selected ? ">" : " "} ${i.name}`}
        selectedKey="a"
        onSelect={noop}
      />
    );
    const frame = lastFrame()!;
    // selectedKey="a" selects Alpha
    expect(frame).toContain("> Alpha");
    expect(frame).toContain("(empty)"); // b-group shows as empty
    expect(frame).not.toContain("> Charlie");
    unmount();
  });

  it("calls onSelect with first item when selectedKey is null", () => {
    let selected: any = undefined;
    const { unmount } = render(
      <TreeList
        items={items}
        getKey={(i) => i.id}
        renderRow={(i) => i.name}
        selectedKey={null}
        onSelect={(item) => { selected = item; }}
      />
    );
    // Allow useEffect to fire
    expect(selected).not.toBeNull();
    expect(selected?.id).toBe("a");
    unmount();
  });

  it("calls onSelect(null) when items are empty", () => {
    let called = false;
    const { unmount } = render(
      <TreeList
        items={[]}
        getKey={() => ""}
        renderRow={() => ""}
        selectedKey="nonexistent"
        onSelect={(item) => { if (item === null) called = true; }}
        emptyMessage="empty"
      />
    );
    expect(called).toBe(true);
    unmount();
  });
});
