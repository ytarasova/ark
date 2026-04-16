/**
 * Tests for useFocus -- focus stack for keyboard input ownership.
 */

import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { FocusProvider, useFocus } from "../hooks/useFocus.js";
import { waitFor } from "../../core/__tests__/test-helpers.js";

let focusRef: ReturnType<typeof useFocus> | null = null;

function FocusInspector() {
  const focus = useFocus();
  focusRef = focus;
  return (
    <Text>{`owner=${focus.owner ?? "null"} appActive=${focus.appActive} pane=${focus.targetPane ?? "null"}`}</Text>
  );
}

function Wrapped() {
  return (
    <FocusProvider>
      <FocusInspector />
    </FocusProvider>
  );
}

describe("useFocus", () => {
  it("appActive is true when stack is empty", () => {
    const { lastFrame, unmount } = render(<Wrapped />);
    expect(lastFrame()!).toContain("appActive=true");
    expect(lastFrame()!).toContain("owner=null");
    expect(focusRef!.appActive).toBe(true);
    expect(focusRef!.owner).toBeNull();
    unmount();
  });

  it("push(id) sets owner to that id, appActive becomes false", async () => {
    const { lastFrame, unmount } = render(<Wrapped />);
    focusRef!.push("form");
    await waitFor(() => focusRef!.owner === "form");
    expect(focusRef!.owner).toBe("form");
    expect(focusRef!.appActive).toBe(false);
    expect(lastFrame()!).toContain("owner=form");
    expect(lastFrame()!).toContain("appActive=false");
    unmount();
  });

  it("push twice: owner is the last pushed", async () => {
    const { unmount } = render(<Wrapped />);
    focusRef!.push("form");
    await waitFor(() => focusRef!.owner === "form");
    focusRef!.push("overlay");
    await waitFor(() => focusRef!.owner === "overlay");
    expect(focusRef!.owner).toBe("overlay");
    expect(focusRef!.appActive).toBe(false);
    unmount();
  });

  it("pop removes from stack, owner reverts to previous", async () => {
    const { unmount } = render(<Wrapped />);
    focusRef!.push("form");
    await waitFor(() => focusRef!.owner === "form");
    focusRef!.push("overlay");
    await waitFor(() => focusRef!.owner === "overlay");
    expect(focusRef!.owner).toBe("overlay");

    focusRef!.pop("overlay");
    await waitFor(() => focusRef!.owner === "form");
    expect(focusRef!.owner).toBe("form");
    expect(focusRef!.appActive).toBe(false);
    unmount();
  });

  it("pop all: appActive becomes true again", async () => {
    const { unmount } = render(<Wrapped />);
    focusRef!.push("form");
    await waitFor(() => focusRef!.owner === "form");
    focusRef!.push("overlay");
    await waitFor(() => focusRef!.owner === "overlay");

    focusRef!.pop("overlay");
    await waitFor(() => focusRef!.owner === "form");
    focusRef!.pop("form");
    await waitFor(() => focusRef!.owner === null);

    expect(focusRef!.owner).toBeNull();
    expect(focusRef!.appActive).toBe(true);
    unmount();
  });

  it("push duplicate id is no-op (doesn't add twice)", async () => {
    const { unmount } = render(<Wrapped />);
    focusRef!.push("form");
    await waitFor(() => focusRef!.owner === "form");
    focusRef!.push("form");
    // Still form after duplicate push - just yield a tick
    await waitFor(() => focusRef!.owner === "form");

    // Owner should still be form
    expect(focusRef!.owner).toBe("form");

    // After one pop, stack should be empty (only one entry was added)
    focusRef!.pop("form");
    await waitFor(() => focusRef!.owner === null);
    expect(focusRef!.owner).toBeNull();
    expect(focusRef!.appActive).toBe(true);
    unmount();
  });

  it("pop non-existent id is no-op", async () => {
    const { unmount } = render(<Wrapped />);
    focusRef!.push("form");
    await waitFor(() => focusRef!.owner === "form");

    focusRef!.pop("nonexistent");
    // Owner should still be form - wait a tick to confirm no change
    await waitFor(() => focusRef!.owner === "form");

    // Stack should be unchanged
    expect(focusRef!.owner).toBe("form");
    expect(focusRef!.appActive).toBe(false);
    unmount();
  });

  it("push defaults targetPane to right", async () => {
    const { unmount } = render(<Wrapped />);
    expect(focusRef!.targetPane).toBeNull();

    focusRef!.push("form");
    await waitFor(() => focusRef!.owner === "form");
    expect(focusRef!.targetPane).toBe("right");
    unmount();
  });

  it("push with explicit left pane sets targetPane to left", async () => {
    const { unmount } = render(<Wrapped />);
    focusRef!.push("search", "left");
    await waitFor(() => focusRef!.owner === "search");
    expect(focusRef!.targetPane).toBe("left");
    unmount();
  });

  it("pushing an overlay then popping exactly that overlay restores previous state", async () => {
    const { unmount } = render(<Wrapped />);

    // Simulate overlay lifecycle: push "talk" overlay, then pop it
    focusRef!.push("talk");
    await waitFor(() => focusRef!.owner === "talk");
    expect(focusRef!.appActive).toBe(false);

    // Simulate setting overlay to null -- pop exactly the pushed overlay
    focusRef!.pop("talk");
    await waitFor(() => focusRef!.owner === null);
    expect(focusRef!.owner).toBeNull();
    expect(focusRef!.appActive).toBe(true);
    unmount();
  });

  it("push overlay, pop only that overlay -- does not pop unrelated entries", async () => {
    const { unmount } = render(<Wrapped />);

    // Simulate a base focus entry (like a search input)
    focusRef!.push("search", "left");
    await waitFor(() => focusRef!.owner === "search");

    // Overlay opens on top
    focusRef!.push("talk");
    await waitFor(() => focusRef!.owner === "talk");

    // Overlay closes -- only pop "talk", not "search"
    focusRef!.pop("talk");
    await waitFor(() => focusRef!.owner === "search");
    expect(focusRef!.owner).toBe("search");
    expect(focusRef!.appActive).toBe(false);

    // Clean up
    focusRef!.pop("search");
    await waitFor(() => focusRef!.owner === null);
    unmount();
  });

  it("targetPane follows top of stack", async () => {
    const { unmount } = render(<Wrapped />);
    focusRef!.push("search", "left");
    await waitFor(() => focusRef!.owner === "search");
    expect(focusRef!.targetPane).toBe("left");

    focusRef!.push("overlay");
    await waitFor(() => focusRef!.owner === "overlay");
    expect(focusRef!.targetPane).toBe("right");

    focusRef!.pop("overlay");
    await waitFor(() => focusRef!.owner === "search");
    expect(focusRef!.targetPane).toBe("left");

    focusRef!.pop("search");
    await waitFor(() => focusRef!.owner === null);
    expect(focusRef!.targetPane).toBeNull();
    unmount();
  });
});
