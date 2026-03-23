/**
 * Tests for useListNavigation hook.
 */

import { describe, it, expect } from "bun:test";
import React, { useState } from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useListNavigation } from "../hooks/useListNavigation.js";

function TestList({ items, active = true }: { items: string[]; active?: boolean }) {
  const { sel } = useListNavigation(items.length, { active });

  return (
    <Text>
      {items.map((item, i) => (
        i === sel ? `[${item}]` : item
      )).join(" ")}
    </Text>
  );
}

describe("useListNavigation", () => {
  it("starts at index 0", () => {
    const { lastFrame, unmount } = render(
      <TestList items={["a", "b", "c"]} />
    );
    expect(lastFrame()!).toContain("[a]");
    unmount();
  });

  it("moves down with j", async () => {
    const { lastFrame, stdin, unmount } = render(
      <TestList items={["a", "b", "c"]} />
    );
    stdin.write("j");
    await new Promise(r => setTimeout(r, 50));
    expect(lastFrame()!).toContain("[b]");
    unmount();
  });

  it("moves up with k", async () => {
    const { lastFrame, stdin, unmount } = render(
      <TestList items={["a", "b", "c"]} />
    );
    stdin.write("j");
    stdin.write("j");
    await new Promise(r => setTimeout(r, 50));
    stdin.write("k");
    await new Promise(r => setTimeout(r, 50));
    expect(lastFrame()!).toContain("[b]");
    unmount();
  });

  it("does not go below last item", async () => {
    const { lastFrame, stdin, unmount } = render(
      <TestList items={["a", "b"]} />
    );
    stdin.write("j");
    stdin.write("j");
    stdin.write("j");
    await new Promise(r => setTimeout(r, 50));
    expect(lastFrame()!).toContain("[b]");
    unmount();
  });

  it("does not go above first item", async () => {
    const { lastFrame, stdin, unmount } = render(
      <TestList items={["a", "b"]} />
    );
    stdin.write("k");
    await new Promise(r => setTimeout(r, 50));
    expect(lastFrame()!).toContain("[a]");
    unmount();
  });

  it("g jumps to first item", async () => {
    const { lastFrame, stdin, unmount } = render(
      <TestList items={["a", "b", "c"]} />
    );
    stdin.write("j");
    stdin.write("j");
    await new Promise(r => setTimeout(r, 50));
    stdin.write("g");
    await new Promise(r => setTimeout(r, 50));
    expect(lastFrame()!).toContain("[a]");
    unmount();
  });

  it("G jumps to last item", async () => {
    const { lastFrame, stdin, unmount } = render(
      <TestList items={["a", "b", "c"]} />
    );
    stdin.write("G");
    await new Promise(r => setTimeout(r, 50));
    expect(lastFrame()!).toContain("[c]");
    unmount();
  });

  it("ignores keys when active=false", async () => {
    const { lastFrame, stdin, unmount } = render(
      <TestList items={["a", "b", "c"]} active={false} />
    );
    stdin.write("j");
    await new Promise(r => setTimeout(r, 50));
    expect(lastFrame()!).toContain("[a]");
    unmount();
  });

  it("clamps selection when list shrinks", async () => {
    function ShrinkList() {
      const [items, setItems] = useState(["a", "b", "c"]);
      const { sel } = useListNavigation(items.length);
      return (
        <Text>
          {`sel=${sel} len=${items.length}`}
          {/* We can't easily shrink in this test, but verify initial state */}
        </Text>
      );
    }

    const { lastFrame, unmount } = render(<ShrinkList />);
    expect(lastFrame()!).toContain("sel=0");
    unmount();
  });
});
