/**
 * Tests for useFocus — focus stack for keyboard input ownership.
 */

import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { FocusProvider, useFocus } from "../hooks/useFocus.js";

let focusRef: ReturnType<typeof useFocus> | null = null;

function FocusInspector() {
  const focus = useFocus();
  focusRef = focus;
  return (
    <Text>{`owner=${focus.owner ?? "null"} appActive=${focus.appActive}`}</Text>
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
    await new Promise(r => setTimeout(r, 50));
    expect(focusRef!.owner).toBe("form");
    expect(focusRef!.appActive).toBe(false);
    expect(lastFrame()!).toContain("owner=form");
    expect(lastFrame()!).toContain("appActive=false");
    unmount();
  });

  it("push twice: owner is the last pushed", async () => {
    const { unmount } = render(<Wrapped />);
    focusRef!.push("form");
    await new Promise(r => setTimeout(r, 50));
    focusRef!.push("overlay");
    await new Promise(r => setTimeout(r, 50));
    expect(focusRef!.owner).toBe("overlay");
    expect(focusRef!.appActive).toBe(false);
    unmount();
  });

  it("pop removes from stack, owner reverts to previous", async () => {
    const { unmount } = render(<Wrapped />);
    focusRef!.push("form");
    await new Promise(r => setTimeout(r, 50));
    focusRef!.push("overlay");
    await new Promise(r => setTimeout(r, 50));
    expect(focusRef!.owner).toBe("overlay");

    focusRef!.pop("overlay");
    await new Promise(r => setTimeout(r, 50));
    expect(focusRef!.owner).toBe("form");
    expect(focusRef!.appActive).toBe(false);
    unmount();
  });

  it("pop all: appActive becomes true again", async () => {
    const { unmount } = render(<Wrapped />);
    focusRef!.push("form");
    await new Promise(r => setTimeout(r, 50));
    focusRef!.push("overlay");
    await new Promise(r => setTimeout(r, 50));

    focusRef!.pop("overlay");
    await new Promise(r => setTimeout(r, 50));
    focusRef!.pop("form");
    await new Promise(r => setTimeout(r, 50));

    expect(focusRef!.owner).toBeNull();
    expect(focusRef!.appActive).toBe(true);
    unmount();
  });

  it("push duplicate id is no-op (doesn't add twice)", async () => {
    const { unmount } = render(<Wrapped />);
    focusRef!.push("form");
    await new Promise(r => setTimeout(r, 50));
    focusRef!.push("form");
    await new Promise(r => setTimeout(r, 50));

    // Owner should still be form
    expect(focusRef!.owner).toBe("form");

    // After one pop, stack should be empty (only one entry was added)
    focusRef!.pop("form");
    await new Promise(r => setTimeout(r, 50));
    expect(focusRef!.owner).toBeNull();
    expect(focusRef!.appActive).toBe(true);
    unmount();
  });

  it("pop non-existent id is no-op", async () => {
    const { unmount } = render(<Wrapped />);
    focusRef!.push("form");
    await new Promise(r => setTimeout(r, 50));

    focusRef!.pop("nonexistent");
    await new Promise(r => setTimeout(r, 50));

    // Stack should be unchanged
    expect(focusRef!.owner).toBe("form");
    expect(focusRef!.appActive).toBe(false);
    unmount();
  });
});
