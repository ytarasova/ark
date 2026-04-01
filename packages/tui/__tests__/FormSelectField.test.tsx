import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { FormSelectField } from "../components/form/index.js";
import { waitFor } from "../../core/__tests__/test-helpers.js";

const items = [
  { label: "Option A", value: "a" },
  { label: "Option B", value: "b" },
  { label: "Option C", value: "c" },
];

describe("FormSelectField", () => {
  it("shows current value when inactive", () => {
    const { lastFrame, unmount } = render(
      <FormSelectField label="Color" value="a" items={items} onSelect={() => {}} active={false} />
    );
    expect(lastFrame()!).toContain("Color");
    expect(lastFrame()!).toContain("a");
    unmount();
  });

  it("shows displayValue when provided", () => {
    const { lastFrame, unmount } = render(
      <FormSelectField label="Mode" value="wt" items={items} onSelect={() => {}} active={false} displayValue="worktree" />
    );
    expect(lastFrame()!).toContain("worktree");
    unmount();
  });

  it("shows select menu when active", () => {
    const { lastFrame, unmount } = render(
      <FormSelectField label="Color" value="a" items={items} onSelect={() => {}} active={true} />
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Option A");
    expect(frame).toContain("Option B");
    expect(frame).toContain("Option C");
    unmount();
  });

  it("shows (none) when value is empty and inactive", () => {
    const { lastFrame, unmount } = render(
      <FormSelectField label="Group" value="" items={items} onSelect={() => {}} active={false} />
    );
    expect(lastFrame()!).toContain("(none)");
    unmount();
  });

  it("calls onSelect when item is chosen", async () => {
    let selected = "";
    const { stdin, unmount } = render(
      <FormSelectField label="Color" value="a" items={items} onSelect={(v) => { selected = v; }} active={true} />
    );
    // Press Enter to select first item
    stdin.write("\r");
    await waitFor(() => selected === "a");
    expect(selected).toBe("a");
    unmount();
  });
});
